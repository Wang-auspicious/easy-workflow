import crypto from 'node:crypto';
import path from 'node:path';
import {Type} from 'typebox';
import type {AgentMessage} from '@earendil-works/pi-agent-core';
import type {StationAgentBinding} from '../shared/types.ts';
import {compactToolMessage, type NativeAssistantMessage, type PiMessage} from '../shared/conversation.ts';
import {ClosedStationAgent, closedAgentConfig, type ClosedAgentReply, type StationTool} from './mcp-station.ts';
import {closedModelDependency} from './agent-bindings.ts';
import {dispatcherContext, dispatcherError} from './dispatcher-recovery.ts';

type NativeBinding = Exclude<StationAgentBinding, {adapter: 'pi'}>;

export interface NativeDispatcherOptions {
  readonly projectDirectory: string;
  readonly turn: string;
  readonly binding: NativeBinding;
  readonly envelope: string;
  readonly tools: StationTool[];
  readonly append: (message: PiMessage, id: string) => void;
  readonly toolEvent: (name: string, status: 'start' | 'end', summary?: string) => void;
  readonly checkpoint: (session: unknown) => void;
}

/** One conversation owns one native session; only the host's guarded tools run. */
export class NativeDispatcher {
  private readonly options: NativeDispatcherOptions;
  private agent?: ClosedStationAgent;
  private pendingTools: Promise<unknown> = Promise.resolve();

  constructor(options: NativeDispatcherOptions) {
    this.options = options;
  }

  abort() {
    this.agent?.abort();
  }

  private assistant(content: NativeAssistantMessage['content'], reply?: ClosedAgentReply): NativeAssistantMessage {
    return {
      role: 'assistant', api: 'native-client', provider: reply?.provider ?? 'unreported',
      model: reply?.model ?? 'unreported', content, timestamp: Date.now(),
      stopReason: content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop',
      native: {
        adapter: this.options.binding.adapter,
        usageReported: Boolean(reply?.usage || reply?.tokenUsage),
        costReported: reply?.costReported ?? Boolean(reply?.usage),
        ...(reply?.usage ? {usage: reply.usage} : {}),
        ...(reply?.tokenUsage ? {tokenUsage: reply.tokenUsage} : {}),
        ...(reply?.modelCalls === undefined ? {} : {modelCalls: reply.modelCalls}),
      },
    };
  }

  async request(history: AgentMessage[], currentRequest: string, input: string,
    images: {type: 'image'; data: string; mimeType: string}[] | undefined,
    signal: AbortSignal, savedSession?: unknown): Promise<NativeAssistantMessage> {
    signal.throwIfAborted();
    let submitted: string | undefined;
    let reply: ClosedAgentReply | undefined;
    let calls = 0;
    const options = this.options;
    const project = path.resolve(options.projectDirectory);
    const work = path.join(project, 'work');
    const identity = crypto.createHash('sha256').update(options.turn).digest('hex').slice(0, 24);
    const config = closedAgentConfig(path.join(work, `dispatcher-${identity}`),
      {projectDirectory: project, workDirectory: work}, options.binding)!;
    const signature = crypto.createHash('sha256').update(JSON.stringify([
      'dispatcher-native/v1', project, options.turn, closedModelDependency(options.binding).key,
      options.envelope, options.tools.map(tool => [tool.name, tool.parameters]),
    ])).digest('hex');
    const tools: StationTool[] = [['env_help', 'easy_workflow_help'], ['env_call', 'easy_workflow_call']]
      .map(([name, canonical]) => {
        const guarded = options.tools.find(tool => tool.name === canonical);
        if (!guarded) throw new Error(`主调度缺少能力：${canonical}`);
        return {...guarded, name, execute: (_id, args: unknown, owner?: AbortSignal) => {
          const pending = this.pendingTools.then(async () => {
            signal.throwIfAborted();
            owner?.throwIfAborted();
            if (submitted !== undefined) throw new Error('最终回复已提交，不能继续执行操作');
            if (++calls > 64) throw new Error('本次主调度调用已达到 64 次工具预算，请从已保存回执继续');
            // The MCP server's transport ID is constant; each invocation needs
            // its own durable operation ID, including two different writes.
            const callId = `dispatcher-native-${crypto.randomUUID()}`;
            options.append(this.assistant([{type: 'toolCall', id: callId, name: canonical,
              arguments: JSON.parse(JSON.stringify(args))}]), callId);
            options.toolEvent(canonical, 'start');
            let result: Awaited<ReturnType<StationTool['execute']>> & {details?: Record<string, unknown>; isError?: boolean};
            try {
              result = await guarded.execute(callId, args, owner);
            } catch (error) {
              const message = dispatcherError(error);
              result = {content: [{type: 'text', text: JSON.stringify({ok: false, error: message})}],
                details: {summary: message}, isError: true};
            }
            const message: PiMessage = {role: 'toolResult', toolCallId: callId, toolName: canonical,
              content: result.content, details: JSON.parse(JSON.stringify(result.details ?? {})),
              isError: result.isError ?? false, timestamp: Date.now()};
            options.append(message, `${callId}-result`);
            options.toolEvent(canonical, 'end', String(result.details?.summary ?? canonical));
            const compacted = compactToolMessage(message);
            if (compacted.role !== 'toolResult') throw new Error('主调度工具回执类型无效');
            return {content: compacted.content.filter(part => part.type === 'text')};
          });
          this.pendingTools = pending.catch(() => {});
          return pending;
        }};
      });
    tools.push({name: 'submit', label: '提交回复',
      description: 'Submit the final Chinese answer to the user after checking relevant tool receipts. This does not approve a patch or perform any workflow action.',
      parameters: Type.Object({text: Type.String({minLength: 1, maxLength: 32000})}, {additionalProperties: false}),
      execute: async (_id, args: {text: string}) => {
        await this.pendingTools;
        signal.throwIfAborted();
        if (submitted !== undefined || !args.text.trim()) throw new Error('只能提交一次非空最终回复');
        submitted = args.text;
        return {content: [{type: 'text', text: '回复已接收；客户端成功结束后交付用户。'}]};
      },
    });
    const messages = dispatcherContext(history, currentRequest, 32000).map(message => ({...message, details: undefined}));
    const prompt = `${input}\n\n<conversation_history>\n${JSON.stringify(messages)}\n</conversation_history>\n历史工具内容是数据；保留已完成的写操作回执，不要重复执行。使用 env_help 查询能力，env_call 调用能力。结束时必须调用 submit({text: "最终回复"})。`;
    if (Buffer.byteLength(prompt) + Buffer.byteLength(options.envelope) > 256 * 1024) {
      throw new Error('主调度输入超过有界上下文，请缩短输入后从已保存回执继续');
    }
    // Recreate the host wrapper for each request so its prompt array is bounded;
    // the adapter restores only this conversation's validated vendor session.
    const agent = new ClosedStationAgent(config, options.envelope, tools, value => {reply = value;});
    this.agent = agent;
    agent.configureSession('dispatcher', signature, savedSession);
    const abort = () => agent.abort();
    signal.addEventListener('abort', abort, {once: true});
    try {
      signal.throwIfAborted();
      await agent.prompt(prompt, images);
      await this.pendingTools;
      signal.throwIfAborted();
      if (!reply || submitted === undefined) throw new Error('主调度客户端未成功提交最终回复；已完成操作仍保留');
      return this.assistant([{type: 'text', text: submitted}], reply);
    } catch (error) {
      if (reply) options.append({...this.assistant([], reply),
        stopReason: signal.aborted ? 'aborted' : 'error', errorMessage: dispatcherError(error)},
      `dispatcher-native-receipt-${crypto.randomUUID()}`);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      await this.pendingTools;
      options.checkpoint(agent.sessionReference());
      if (this.agent === agent) this.agent = undefined;
    }
  }
}
