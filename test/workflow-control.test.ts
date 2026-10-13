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
