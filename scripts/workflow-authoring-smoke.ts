// Opt-in, real-model acceptance. Creates an isolated project and keeps evidence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const option = (key: string) => process.argv.find(argument => argument.startsWith(`--${key}=`))?.slice(key.length + 3);
const scenario = option('scenario') ?? 'analysis';
assert.ok(['analysis', 'feedback'].includes(scenario), 'scenario must be analysis or feedback');
const kernel = option('kernel') ?? (scenario === 'feedback' ? 'v1' : 'v2');
assert.ok(['v1', 'v2'].includes(kernel), 'kernel must be v1 or v2');
const resumed = option('resume');
const improve = process.argv.includes('--improve');
const verifyExisting = process.argv.includes('--verify-existing');
assert.ok(!improve || (resumed && scenario === 'feedback'), '--improve needs a resumed feedback project');
assert.ok(!verifyExisting || (resumed && improve), '--verify-existing needs the resumed improved feedback project');
const directory = resumed ? path.resolve(resumed) : fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-authoring-live-'));
assert.equal(path.dirname(directory), path.resolve(os.tmpdir()), 'acceptance projects must stay in the temporary directory');
assert.ok(path.basename(directory).startsWith('easy-workflow-authoring-live-'));
console.log(JSON.stringify({directory, scenario, kernel, resumed: Boolean(resumed)}));
process.env.FACTORY_VAR = directory;
process.env.FACTORY_DISCOVERY = '0';
process.env.FACTORY_PREFLIGHT = '0';
process.env.VISLEXICON_ROOT = path.join(directory, 'unconnected');
const {instantiateWorkflowTemplate} = await import('../server/templates.ts');
const {Factory} = await import('../server/factory.ts');
const {FactoryControl} = await import('../server/control.ts');
const {Dispatcher} = await import('../server/dispatcher.ts');
const {closeModelTransport} = await import('../server/pi.ts');
const {closeNetwork} = await import('../server/network.ts');
const {closeBrowser} = await import('../server/browser.ts');
if (!resumed) {
  await instantiateWorkflowTemplate(directory, {templateId: 'fanout', id: 'baseline', name: 'Baseline', includeBuiltins: false}, {running: false});
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({kernel, model: 2, modelWorkers: 2}));
}
const factory = new Factory(directory);
await factory.boot();
const dispatcher = new Dispatcher(factory, new FactoryControl(factory), {requestTimeoutMs: 120000, maxAttempts: 3});
const tools: string[] = [];
factory.journal.subscribe(event => {
  if (event.kind === 'control.executed') {tools.push(event.tool); console.log(`CONTROL ${event.tool}`);}
  if (event.kind === 'attempt.started') console.log(`START ${event.node} ${event.attempt}`);
  if (event.kind === 'attempt.finished') console.log(`FINISH ${event.attempt} ${event.ok ? 'ok' : 'failed'}`);
});
const deadline = setTimeout(() => {dispatcher.abort(); factory.runtime.dispose();}, 900000);
const heartbeat = setInterval(() => console.log(JSON.stringify({status: dispatcher.status.status,
  stage: tools.at(-1) ?? 'designing', active: Object.values(factory.state.attempts).filter(attempt => !attempt.endedAt).length})), 30000);
const packId = scenario === 'feedback' ? 'feedback-intelligence' : 'authored-analysis';
const productionItem = improve ? 'feedback-production-optimized' : 'feedback-production';
const trialInput = 'F001: 点击工位对话后出现白屏，无法继续操作。\n\nF002: 字体太小，难以阅读节点名称。\n\nF003: 希望主调度可以自己创建工作流。';
const productionInput = 'F101: 点击节点对话中的消息会白屏，需要重开应用。\n\nF102: 打开工位消息详情也会白屏，工作被中断。\n\nF103: 节点卡片大小不统一，小窗口文字看不清。\n\nF104: 希望卡片增加立体感，按钮有明确的悬停和按压反馈。\n\nF105: 主 Agent 应能自主创建线路、接好节点并实际跑出结果。\n\nF106: 任务停住后看不出在等模型、预算还是其他工位。';
const prompt = scenario === 'feedback' ? `请自主创建并实际运行“产品反馈归因与验收”工作流，包 id 为 ${packId}。这是已授权的隔离项目，你可自行建线、修改草稿、真实试跑、启用并正式投料，不要改 baseline，不必问确认，不要只输出方案。
目标：输入 text（非空字符串，每个 F 编号一条反馈，空行分隔）。由程序标准化文本，然后并行做程序字词/段落统计和真实 Agent 语义分析，再汇合生成行动清单，最后由另一个独立审查 Agent 对照原始输入逐项核对，只有 pass 且 issues=[] 才能发布 JSON。不通过应有明确的有界返工连接，不能让写作者自己充当审查员。节点、schema、ROLE.md 和连线由你设计，至少两个真实 Agent 节点，至少一个程序分支及一个汇合点。
最终 JSON 的 result 必须含 feedbackCount（反馈原始条数，重复问题仍计数）、statistics（复制程序真实统计）、issues（数组，每项含 title、priority=P0/P1/P2、evidenceIds 字符串数组、recommendation）、nextSteps（可操作的字符串数组）。每个 F 编号必须被 issues 恰好覆盖一次，可合并同类问题，但不得遗漏、重复分配或编造编号。描述问题与修复建议，不得声称建议已完成或测试已通过。
先用以下 3 条试跑，核对 feedbackCount=3、statistics.paragraphs=3 和所有工位覆盖：
${trialInput}
通过后启用同一 revision，再正式投料，任务名 ${productionItem}，输入如下 6 条（发布后 feedbackCount=6，statistics.paragraphs=6，F101 和 F102 应归入同一个白屏问题）：
${productionInput}
正式投料后要核对实际任务状态、审查输出、产物路径和 SHA-256，再报告结果。工具报错时读诊断，自己修正并继续，不能降低这些验收条件。` : '请实际自主创建一套新工作流，包 id 为 authored-analysis，名称“自主文本分析”。把文本标准化后并行统计字词和提取关键词，再汇合、保存 JSON。用你自己的自主建线能力读取模板、设计并保存完整草稿、真实隔离试跑、修正任何错误，启用通过版本。试跑输入 alpha beta beta，断言报告词数为 3。然后正式投料 gamma gamma delta，任务名 live-proof，核对实际交付。不要修改 baseline，不要只告诉我操作步骤。这个隔离项目已经授权你创建和执行，不必再确认。';
let summary: Record<string, unknown>;
try {
  const request = verifyExisting ? `继续核验已经完成的 ${packId} 工作流。新服务已修复 workflow_result 读取正式产物的实现：接受结果持久保存在任务 data 的 outputKey 下，不能只依赖可选的 attempt.output。
请自己读取状态找到 ${productionItem} 的真实 token，用 workflow_result 核验磁盘 JSON、字节、SHA-256、6 条反馈的完整覆盖和独立审查 pass；再读取对应草稿与已经通过的最近试跑回执，确认字段条件仍成立。已有试跑和正式结果就复用，不重建、不重复投料，不因这是核验而重跑模型。确认 readyForDelivery=true 后报告真实结果和路径。如果依然失败则保留准确原因，不伪称成功。`
    : improve ? `上一轮 feedback-production 已实际发布，保留它，不重复投料。现在请继续优化你自己创建的 ${packId}：读取 workflow_authoring 的最新能力，用 workflow_edit 增量修改，把仅汇合统计和语义结果的搬运 Agent 改为 compose-json 程序，保留真正的语义分析 Agent 和独立审查 Agent，保留有界退回、全部输出契约及原始输入核对。
这个隔离项目只用于本次验收，现明确授权你在确认没有在途任务后结束上一轮，以启用你自己修改并重新真实试跑通过的版本。不要更改 baseline。正式新任务名 ${productionItem}，用 workflow_result 有界等待并核验实际文件。你自己设计和提交修改，不要要求我手工编辑文件。
以下是仍须全部满足的原始目标、试跑与正式样本：\n${prompt}`
    : resumed ? `继续这个已经授权的任务。先读取已持久化草稿、试跑回执、已安装版本和已投料状态，复用已完成工作，修正问题直到全部条件通过。不要重复已交付的投料。\n${prompt}` : prompt;
  fs.writeFileSync(path.join(directory, verifyExisting ? 'verification-request.txt' : improve ? 'improvement-request.txt' : 'request.txt'), request);
  const response = await dispatcher.chat(request, []);
  await factory.runtime.settle();
  const installed = factory.workflowPacks?.manifests.find(manifest => manifest.id === packId);
  const delivered = Object.values(factory.state.tokens).filter(token => token.data.workflowPack === packId && token.status === 'published');
  const required = ['workflow_draft', 'workflow_trial', 'workflow_activate', 'workflow_feed'];
  const journal = [...factory.journal.read()];
  const history = journal.filter(event => event.kind === 'control.executed').map(event => event.tool);
  const calls = journal.flatMap(event => event.kind === 'chat.message' && event.message.role === 'assistant'
    ? event.message.content.filter(part => part.type === 'toolCall') : []);
  const receipts = journal.flatMap(event => {
    if (event.kind !== 'chat.message' || event.message.role !== 'toolResult' || event.message.isError) return [];
    const callId = event.message.toolCallId;
    return event.message.content.flatMap(part => {
      if (part.type !== 'text') return [];
      try {return [{callId, value: JSON.parse(part.text)}];} catch {return [];}
    });
  });
  const artifacts = delivered.flatMap(token => Object.values(token.data).filter((value): value is {path: string; sha256: string; bytes: number} =>
    value !== null && typeof value === 'object' && !Array.isArray(value) && 'path' in value && 'sha256' in value && 'bytes' in value)
    .map(value => {
      const file = path.resolve(directory, value.path);
      assert.ok(file.startsWith(directory + path.sep));
      const bytes = fs.readFileSync(file);
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), value.sha256);
      assert.equal(bytes.length, value.bytes);
      return {...value, token: token.id, content: JSON.parse(bytes.toString('utf8'))};
    }));
  const attempts = Object.values(factory.state.attempts).filter(attempt => delivered.some(token => token.id === attempt.token));
  summary = {ok: Boolean(installed) && delivered.length > 0 && artifacts.length > 0 && required.every(name => history.includes(name)),
    scenario, kernel: factory.kernel, model: factory.dispatcherModelStatus(), tools: history, installed: installed?.id,
    published: delivered.length, artifacts, attempts, directory, response};
  assert.equal(summary.ok, true, 'The real coordinator must create, trial, activate and publish through its own tools');
  if (scenario === 'feedback') {
    const result = artifacts.find(artifact => artifact.content.item === productionItem)?.content.result;
    assert.ok(result, 'the formal result must exist on disk');
    assert.equal(result.feedbackCount, 6);
    assert.equal(result.statistics.paragraphs, 6);
    assert.equal(result.statistics.characters, [...productionInput].length);
    assert.ok(Array.isArray(result.nextSteps) && result.nextSteps.length > 0);
    assert.ok(Array.isArray(result.issues) && result.issues.length >= 4);
    assert.deepEqual(result.issues.flatMap((issue: {evidenceIds: string[]}) => issue.evidenceIds).sort(), ['F101', 'F102', 'F103', 'F104', 'F105', 'F106']);
    assert.ok(result.issues.some((issue: {evidenceIds: string[]}) => issue.evidenceIds.includes('F101') && issue.evidenceIds.includes('F102')));
    const nodes = installed!.lines.flatMap(line => line.stations.map(node => ({...node, key: `${line.id}/${node.id}`})));
    const agents = nodes.filter(node => ['agent', 'review'].includes(node.kind));
    assert.ok(agents.length >= 2 && agents.some(node => node.kind === 'review'));
    for (const node of agents) assert.ok(attempts.some(attempt => attempt.node === node.key && attempt.ok && attempt.metrics?.dependency), `${node.key} needs a real model receipt`);
    assert.ok(agents.filter(node => node.kind === 'review').some(node => {
      const key = installed!.bindings[node.key].outputKey;
      return delivered.some(token => (token.data[key] as {verdict?: string} | undefined)?.verdict === 'pass') &&
        attempts.some(attempt => attempt.node === node.key && attempt.ok);
    }));
    if (improve) {
      assert.ok(history.includes('workflow_edit'), 'the actual coordinator must use incremental edits');
      assert.ok(Object.values(installed!.bindings).some(binding => binding.execute.kind === 'builtin' && binding.execute.name === 'compose-json'));
      const newToken = delivered.find(token => token.item === productionItem)!;
      const verified = (await new FactoryControl(factory).execute('workflow_result', {token: newToken.id})).result;
      assert.equal(verified.readyForDelivery, true, JSON.stringify(verified));
      assert.equal(agents.length, 2, 'the data-only merge no longer needs a model');
      assert.ok(receipts.some(receipt => receipt.value.tool === 'workflow_result' &&
        receipt.value.result?.token === newToken.id && receipt.value.result.readyForDelivery), 'the coordinator itself receives the verified file result');
      const activation = JSON.parse(fs.readFileSync(path.join(directory, 'workflow-authoring', 'activated', `${packId}.json`), 'utf8'));
      const trialReceipt = receipts.find(receipt => receipt.value.tool === 'workflow_trial' && receipt.value.result?.id === activation.trialId);
      const trialCall = calls.find(call => call.id === trialReceipt?.callId);
      const args = trialCall?.arguments as {arguments?: {samples?: {expect?: {values?: Record<string, unknown>}}[]}} | undefined;
      const values = args?.arguments?.samples?.[0]?.expect?.values ?? {};
      assert.ok(Object.entries(values).some(([key, value]) => key.endsWith('.feedbackCount') && value === 3), 'trial must retain the requested feedback count assertion');
      assert.ok(Object.entries(values).some(([key, value]) => key.endsWith('.paragraphs') && value === 3), 'trial must retain the requested program statistic assertion');
      const report = trialReceipt!.value.result;
      assert.equal(report.passed, true);
      assert.deepEqual(report.uncovered, []);
      for (const [field, expected] of Object.entries(values)) {
        const actual = field.split('.').reduce((value, key) => value?.[key], report.tokens[0].data);
        assert.ok(isDeepStrictEqual(actual, expected), `trial assertion ${field} matches its persisted actual output`);
      }
      summary.verification = {trialId: activation.trialId, revision: activation.revision, outputAssertions: values,
        uncovered: report.uncovered, verifiedToken: newToken.id, readyForDelivery: verified.readyForDelivery};
    }
  }
  fs.writeFileSync(path.join(directory, improve ? 'improved-acceptance.json' : 'acceptance.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ok: summary.ok, installed: summary.installed, published: summary.published,
    artifacts: artifacts.map(({content, ...artifact}) => artifact), tools: history, directory}));
} catch (error) {
  fs.writeFileSync(path.join(directory, improve ? 'improved-acceptance.json' : 'acceptance.json'), JSON.stringify({ok: false, scenario, directory,
    error: error instanceof Error ? error.message : String(error)}, null, 2));
  fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({error: error instanceof Error ? error.message : String(error),
    tools, status: dispatcher.status, tokens: Object.values(factory.state.tokens), attempts: Object.values(factory.state.attempts)}, null, 2));
  throw error;
} finally {
  clearTimeout(deadline);
  clearInterval(heartbeat);
  dispatcher.abort();
  await factory.sources.close(); factory.channels?.close(); factory.recovery?.close();
  await factory.runtime.close(); factory.docs.flush(); factory.lessons.close();
  await factory.closeSnapshots(); factory.journal.close();
  await closeBrowser(); await closeNetwork(); await closeModelTransport();
}
