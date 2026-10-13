import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Check } from 'typebox/value';
import type { TSchema } from 'typebox';
import { networkFetch } from './network.ts';

export type WorkflowTool =
  | { kind: 'http'; url: string; method?: 'GET' | 'POST'; headersFromEnv?: Record<string, string>; timeoutMs?: number }
  | { kind: 'cli'; command: string; args?: string[]; envFrom?: Record<string, string>; timeoutMs?: number }
  | { kind: 'mcp'; command: string; args?: string[]; envFrom?: Record<string, string>; tool: string; timeoutMs?: number };
export interface ToolInvocation { signal: AbortSignal; workDir: string; packDir: string }

function processTool(tool: Extract<WorkflowTool, { kind: 'cli' | 'mcp' }>, input: unknown, context: ToolInvocation, describe: boolean) {
  context.signal.throwIfAborted();
  fs.mkdirSync(context.workDir, { recursive: true });
  const command = tool.command === '$node' ? process.execPath : tool.command;
  const args = (tool.args ?? []).map(value => value === '$pack' ? context.packDir : value.startsWith('$pack/') ? path.join(context.packDir, value.slice(6)) : value);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, source] of Object.entries(tool.envFrom ?? {})) {
    if (process.env[source] === undefined) throw new Error(`工作流工具缺少环境变量 ${source}`);
    env[name] = process.env[source];
  }
  if (tool.command === '$node') env.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(command, args, { cwd: context.workDir, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise<unknown>((resolve, reject) => {
    let done = false, output = '', pending = '', bytes = 0;
    const finish = (error?: unknown, result?: unknown) => {
      if (done) return; done = true; clearTimeout(timer); context.signal.removeEventListener('abort', abort);
      const settle = () => error ? reject(error) : resolve(result);
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolveExit => child.once('close', () => resolveExit()));
        let treeClosed: Promise<void> = Promise.resolve();
        if (process.platform === 'win32' && child.pid) {
          const cleanup = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          treeClosed = new Promise<void>(resolveTree => {
            cleanup.once('error', () => { child.kill(); resolveTree(); });
            cleanup.once('close', code => { if (code && child.exitCode === null) child.kill(); resolveTree(); });
          });
        } else child.kill();
        void Promise.all([exited, treeClosed]).then(settle);
      } else settle();
    };
    const abort = () => finish(context.signal.reason);
    const timer = setTimeout(() => finish(new Error('工作流外部工具超时')), tool.timeoutMs ?? 30000);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) { abort(); return; }
    const send = (id: number | undefined, method: string, params: unknown) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }) + '\n');
    child.on('error', error => finish(new Error(`无法启动工作流工具（${(error as NodeJS.ErrnoException).code ?? 'process error'}）`)));
    child.stdin.on('error', error => { if (!done) finish(new Error(`工作流工具输入通道关闭（${(error as NodeJS.ErrnoException).code ?? 'pipe'}）`)); });
    // Stderr is drained, but never copied into a prompt or durable log: commands
    // may echo their environment credentials while reporting an error.
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { finish(new Error('工作流工具输出超过 2MiB 上限')); return; }
      if (tool.kind === 'cli') { output += chunk; return; }
      pending += chunk;
      while (!done && pending.includes('\n')) {
        const index = pending.indexOf('\n'), line = pending.slice(0, index).trim(); pending = pending.slice(index + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (!message.id) continue;
          if (message.error) { finish(new Error(`MCP 请求失败（${String(message.error.code ?? 'error')}）`)); return; }
          if (message.id === 1) { send(undefined, 'notifications/initialized', {}); send(2, 'tools/list', {}); }
          else if (message.id === 2) {
            const declared = message.result?.tools?.find((entry: { name: string }) => entry.name === tool.tool);
            if (!declared?.inputSchema) { finish(new Error(`MCP 未提供工具 ${tool.tool} 的参数契约`)); return; }
            if (describe) { finish(undefined, declared); return; }
            if (!Check(declared.inputSchema as TSchema, input)) { finish(new Error(`MCP 工具 ${tool.tool} 的当前参数 schema 不接受该输入`)); return; }
            send(3, 'tools/call', { name: tool.tool, arguments: input });
          } else if (message.id === 3) {
            const result = message.result;
            if (result?.isError) { finish(new Error(`MCP 工具 ${tool.tool} 返回执行失败`)); return; }
            if (result?.structuredContent !== undefined) finish(undefined, result.structuredContent);
            else {
              const text = (result?.content ?? []).filter((entry: { type: string }) => entry.type === 'text').map((entry: { text: string }) => entry.text).join('\n');
              try { finish(undefined, JSON.parse(text)); } catch { finish(undefined, { text }); }
            }
          }
        } catch { finish(new Error('MCP 工具返回的协议消息不是合法 JSON')); }
      }
    });
    child.once('close', code => {
      if (done) return;
      if (code !== 0) { finish(new Error(`工作流工具进程退出（${code ?? 'signal'}）`)); return; }
      if (tool.kind === 'mcp') { finish(new Error('MCP 连接在返回工具结果前关闭')); return; }
      try { finish(undefined, JSON.parse(output)); } catch { finish(new Error('CLI 工具必须在标准输出返回一个合法 JSON 值')); }
    });
    if (tool.kind === 'cli') child.stdin.end(JSON.stringify(input) + '\n');
    else send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'easy-workflow', version: '1' } });
  });
}

export async function invokeWorkflowTool(tool: WorkflowTool, input: unknown, context: ToolInvocation): Promise<unknown> {
  if (tool.kind !== 'http') return processTool(tool, input, context, false);
  const endpoint = new URL(tool.url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('HTTP 工具地址必须是无内嵌凭据的 HTTP(S) 地址');
  const headers = new Headers({ accept: 'application/json' });
  for (const [header, source] of Object.entries(tool.headersFromEnv ?? {})) {
    const value = process.env[source]; if (!value) throw new Error(`HTTP 工具缺少环境变量 ${source}`); headers.set(header, value);
  }
  const method = tool.method ?? 'POST';
  if (method === 'GET') for (const [key, value] of Object.entries(input as Record<string, unknown>)) endpoint.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  else headers.set('content-type', 'application/json');
  const response = await networkFetch(endpoint, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.any([context.signal, AbortSignal.timeout(tool.timeoutMs ?? 30000)]) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP 工具返回 ${response.status}`); }
  const reader = response.body?.getReader();
  let bytes = 0; const chunks: Uint8Array[] = [];
  if (reader) try {
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 2 * 1024 * 1024) throw new Error('HTTP 工具响应超过 2MiB 上限'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  context.signal.throwIfAborted();
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('HTTP 工具必须返回合法 JSON'); }
}

export async function describeWorkflowTool(tool: WorkflowTool, context: ToolInvocation) {
  return tool.kind === 'mcp' ? processTool(tool, {}, context, true) : { kind: tool.kind, dynamicSchema: false };
}
