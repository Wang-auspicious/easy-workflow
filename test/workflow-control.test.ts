import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-control-packs-'));
process.env.FACTORY_VAR = root;
process.env.FACTORY_PREFLIGHT = '0';
process.env.FACTORY_START_PAUSED = '1';
process.env.VISLEXICON_ROOT = path.join(root, 'not-connected');
const { Factory } = await import('../server/factory.ts');
const { FactoryControl } = await import('../server/control.ts');
const close = async (factory: InstanceType<typeof Factory>) => { await factory.runtime.close(); factory.docs.flush(); factory.lessons.close(); factory.journal.close(); };

test('real control installs a generic-only pack, validates input, runs programs and reloads the durable workflow', { timeout: 20000 }, async () => {
  let factory = new Factory(), closed = false;
  try {
    await factory.boot();
    let control = new FactoryControl(factory);
    assert.equal((await control.execute('workflow_templates', {})).result.templates.length, 4);
    await assert.rejects(control.execute('workflow_template', { templateId: 'fanout', id: 'analysis', name: 'Text analysis', includeBuiltins: false }), /站长|用户/);
    const installed = await control.execute('workflow_template', { templateId: 'fanout', id: 'analysis', name: 'Text analysis', includeBuiltins: false }, 'user');
    assert.equal(installed.result.manifest.entry, 'analysis/prepare');
    assert.deepEqual(factory.compiled.packs.map(pack => pack.id), ['analysis']);
    assert.equal(factory.project.pack, 'analysis');
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'PROJECT.md'), 'utf8'), /把 VisLexicon 候选库/);
    const role = factory.runtime.roleResolver('analysis/prepare'); assert.match(role.content, /Unicode/);
    assert.match(factory.docs.envelope(factory.compiled.nodes.find(node => node.key === 'analysis/prepare')!).text, /文本标准化/);
    await assert.rejects(control.execute('workflow_feed', { packId: 'analysis', item: 'invalid', input: { text: 42 } }), (error: any) => error.code === 'workflow_input_invalid');
    const fed = await control.execute('workflow_feed', { packId: 'analysis', item: 'first', input: { text: 'A real program result with repeated repeated words.' } });
    await factory.runtime.settle();
    assert.equal(factory.state.tokens[fed.result.token].status, 'published');
    assert.ok(fs.readdirSync(path.join(root, 'outputs', 'analysis')).length > 0);
    await assert.rejects(control.execute('workflow_template', { templateId: 'fanout', id: 'blocked', name: 'Blocked' }, 'user'), /结束/);
    factory.runtime.pause();
    await assert.rejects(control.execute('workflow_template', { templateId: 'fanout', id: 'blocked', name: 'Blocked' }, 'user'), /结束/);
    factory.runtime.end(); await factory.runtime.settle();
    const originalDigest = factory.compiled.digest;
    const document = path.join(root, 'PROJECT.md'), custom = '# My independent work\n\nPreserve this user-authored purpose exactly.\n';
    fs.writeFileSync(document, custom);
    await close(factory); closed = true;
    factory = new Factory(); closed = false; await factory.boot(); control = new FactoryControl(factory);
    assert.equal(factory.compiled.digest, originalDigest);
    assert.equal(factory.state.tokens[fed.result.token].status, 'published');
    assert.equal(fs.readFileSync(document, 'utf8'), custom, 'pack synchronization never overwrites human project notes');
    const again = await control.execute('workflow_feed', { packId: 'analysis', item: 'second', input: { text: 'The same installed programs still work after a real restart.' } });
    await factory.runtime.settle(); assert.equal(factory.state.tokens[again.result.token].status, 'published');
    assert.equal([...factory.journal.read()].filter(event => event.kind === 'token.finished' && event.token === fed.result.token && event.status === 'published').length, 1);
  } finally {
    if (!closed) await close(factory);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

for (const kernel of ['v1', 'v2'] as const) test(`coordinator creates, verifies, activates and resumes its own real workflow on ${kernel}`, {timeout: 45000}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `easy-workflow-author-${kernel}-`));
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({kernel}));
  let factory = new Factory(directory);
  let closed = false;
  try {
    await factory.boot();
    let control = new FactoryControl(factory);
    const call = async (name: string, args: Record<string, unknown>) => {
      const tool = control.agentTools().find(tool => tool.name === 'easy_workflow_call')!;
      const reply = await tool.execute('coordinator-test', {name, arguments: args});
      return (reply.details.result as {result: any}).result;
    };
    const guide = await call('workflow_authoring', {template: {templateId: 'fanout', id: 'my-analysis', name: 'Coordinator analysis'}});
    const original = factory.compiled.digest;
    const saved = await call('workflow_draft', guide.source);
    assert.equal(saved.validation.valid, true, JSON.stringify(saved.validation.issues));
    assert.equal(factory.compiled.digest, original, 'drafting never activates a partial graph');
    await assert.rejects(call('workflow_draft', guide.source), (error: any) => error.code === 'workflow_draft_stale');
    const bad = await call('workflow_trial', {id: saved.id, revision: saved.revision,
      samples: [{name: 'bad assertion', input: {text: 'one two two'}, expect: {values: {'report.statistics.words': 999}}}]});
    assert.equal(bad.passed, false);
    await assert.rejects(call('workflow_activate', {id: saved.id, revision: saved.revision, trialId: bad.id}), (error: any) => error.code === 'workflow_trial_required');
    const trial = await call('workflow_trial', {id: saved.id, revision: saved.revision, samples: [
      {name: 'words', input: {text: 'one two two'}, expect: {values: {'report.statistics.words': 3, 'report.keywords.0.word': 'two'}}},
      {name: 'unicode', input: {text: '  汉字  example\r\nnew  '}, expect: {values: {'report.text': '汉字 example\nnew'}}},
    ]});
    assert.equal(trial.passed, true, JSON.stringify(trial.samples));
    assert.deepEqual(trial.uncovered, []);
    assert.equal(trial.artifacts.length, 2);
    assert.equal(Object.keys(factory.state.tokens).length, 0, 'trial tasks do not enter production');
    assert.equal(fs.existsSync(path.join(directory, 'outputs')), false, 'trial output is isolated');
    assert.equal((await call('workflow_drafts', {trialId: trial.id})).passed, true);
    assert.equal((await call('workflow_drafts', {id: saved.id})).trials.length, 2);
    const proof = path.join(directory, trial.directory, trial.artifacts[0].path);
    const proofBytes = fs.readFileSync(proof);
    fs.writeFileSync(proof, 'changed');
    await assert.rejects(call('workflow_activate', {id: saved.id, revision: saved.revision, trialId: trial.id}), (error: any) => error.code === 'workflow_trial_artifact_changed');
    fs.writeFileSync(proof, proofBytes);
    const activated = await call('workflow_activate', {id: saved.id, revision: saved.revision, trialId: trial.id});
    assert.ok(activated.installedRevision);
    assert.ok(factory.compiled.nodes.some(node => node.key === 'curation/gate'), 'existing built-in gates are preserved');
    assert.equal((await call('workflow_activate', {id: saved.id, revision: saved.revision, trialId: trial.id})).alreadyActive, true);
    const fed = await call('workflow_feed', {packId: saved.id, item: 'production', input: {text: 'actual production data'}});
    await factory.runtime.settle();
    assert.equal(factory.state.tokens[fed.token].status, 'published');
    await assert.rejects(call('workflow_activate', {id: saved.id, revision: saved.revision, trialId: bad.id}), /试跑|样本/);
    factory.runtime.end(); await factory.runtime.settle();
    await close(factory); closed = true;
    factory = new Factory(directory); closed = false; await factory.boot(); control = new FactoryControl(factory);
    assert.equal((await call('workflow_drafts', {id: saved.id})).revision, saved.revision);
    assert.equal((await call('workflow_activate', {id: saved.id, revision: saved.revision, trialId: trial.id})).alreadyActive, true);
    const changed = structuredClone(guide.source);
    changed.manifest.name = 'Improved analysis';
    const revised = await call('workflow_draft', {...changed, expectedRevision: saved.revision});
    await assert.rejects(call('workflow_activate', {id: saved.id, revision: revised.revision, trialId: trial.id}), /当前 revision/);
    const second = await call('workflow_trial', {id: saved.id, revision: revised.revision, samples: [{name: 'revision', input: {text: 'improved result'}}]});
    await call('workflow_activate', {id: saved.id, revision: revised.revision, trialId: second.id});
    assert.equal(factory.workflowPacks?.manifests.find(value => value.id === saved.id)?.name, 'Improved analysis');
    const unsafe = structuredClone(guide.source);
    unsafe.manifest.bindings['my-analysis/prepare'].execute = {kind: 'node', module: 'tools/run.mjs'};
    unsafe.files['tools/run.mjs'] = 'throw new Error("must never execute");';
    const rejected = await call('workflow_draft', {...unsafe, expectedRevision: revised.revision});
    assert.equal(rejected.validation.valid, false);
    await assert.rejects(call('workflow_trial', {id: rejected.id, revision: rejected.revision, samples: [{name: 'unsafe', input: {text: 'input'}}]}), /未通过/);
  } finally {
    if (!closed) await close(factory);
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
  }
});
