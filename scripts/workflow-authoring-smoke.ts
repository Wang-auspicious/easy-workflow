// Opt-in, real-model acceptance. Creates an isolated project and keeps evidence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-authoring-live-'));
process.env.FACTORY_VAR = directory;
process.env.FACTORY_DISCOVERY = '0';
process.env.FACTORY_PREFLIGHT = '0';
const {instantiateWorkflowTemplate} = await import('../server/templates.ts');
const {Factory} = await import('../server/factory.ts');
const {FactoryControl} = await import('../server/control.ts');
const {Dispatcher} = await import('../server/dispatcher.ts');
const {closeModelTransport} = await import('../server/pi.ts');
const {closeNetwork} = await import('../server/network.ts');
const {closeBrowser} = await import('../server/browser.ts');
await instantiateWorkflowTemplate(directory, {templateId: 'fanout', id: 'baseline', name: 'Baseline', includeBuiltins: false}, {running: false});
fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({kernel: 'v2', model: 1, modelWorkers: 1}));
const factory = new Factory(directory);
await factory.boot();
const dispatcher = new Dispatcher(factory, new FactoryControl(factory), {requestTimeoutMs: 90000, maxAttempts: 2});
const tools: string[] = [];
factory.journal.subscribe(event => {
  if (event.kind === 'control.executed') {tools.push(event.tool); console.log(`CONTROL ${event.tool}`);}
});
const deadline = setTimeout(() => dispatcher.abort(), 360000);
let summary: Record<string, unknown>;
try {
  const response = await dispatcher.chat('请实际自主创建一套新工作流，包 id 为 authored-analysis，名称“自主文本分析”。把文本标准化后并行统计字词和提取关键词，再汇合、保存 JSON。用你自己的自主建线能力读取模板、设计并保存完整草稿、真实隔离试跑、修正任何错误，启用通过版本。试跑输入 alpha beta beta，断言报告词数为 3。然后正式投料 gamma gamma delta，任务名 live-proof，核对实际交付。不要修改 baseline，不要只告诉我操作步骤。这个隔离项目已经授权你创建和执行，不必再确认。', []);
  await factory.runtime.settle();
  const installed = factory.workflowPacks?.manifests.find(manifest => manifest.id === 'authored-analysis');
  const delivered = Object.values(factory.state.tokens).filter(token => token.data.workflowPack === 'authored-analysis' && token.status === 'published');
  const required = ['workflow_draft', 'workflow_trial', 'workflow_activate', 'workflow_feed'];
  summary = {ok: Boolean(installed) && delivered.length > 0 && required.every(name => tools.includes(name)),
    model: factory.dispatcherModelStatus(), tools, installed: installed?.id, published: delivered.length, directory, response};
  fs.writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ok: summary.ok, installed: summary.installed, published: summary.published, tools, directory}));
  assert.equal(summary.ok, true, 'The real coordinator must create, trial, activate and publish through its own tools');
} finally {
  clearTimeout(deadline);
  dispatcher.abort();
  await factory.sources.close(); factory.channels?.close(); factory.recovery?.close();
  await factory.runtime.close(); factory.docs.flush(); factory.lessons.close();
  await factory.closeSnapshots(); factory.journal.close();
  await closeBrowser(); await closeNetwork(); await closeModelTransport();
}
