import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { StationContext } from '../server/runtime.ts';

test('breadth and proof keep public captures when an optional page redirects to login', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-optional-auth-'));
  const keys = ['FACTORY_VAR', 'PI_CODING_AGENT_DIR', 'FACTORY_MODEL', 'FACTORY_PROVIDER', 'FACTORY_STATION_COMMAND', 'FACTORY_STATION_MODEL'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.FACTORY_VAR = root; process.env.PI_CODING_AGENT_DIR = root;
  const tiles = Array.from({ length: 9 }, (_, i) => `<section style="display:inline-block;vertical-align:top;width:250px;height:175px;margin:12px;background:hsl(${i * 39} 65% 62%);border:3px solid #16304a;border-radius:${i * 3}px"><h2>Public prototype ${i + 1}</h2><svg width="180" height="80"><circle cx="45" cy="40" r="30" fill="white"/><path d="M85 15h80v50H85z" fill="#133455"/></svg></section>`).join('');
  const fixture = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/cloud') { res.writeHead(302, { location: '/login' }); res.end(); return; }
    if (req.url === '/login') { res.end('<title>Log in | Cloud</title><main><h1>Log in to continue</h1><input type=password><button>Log in</button></main>'); return; }
    if (req.url === '/') { res.end('<title>Public product homepage</title><h1>Build prototypes</h1><p>Explore the public gallery.</p>'); return; }
    res.end(`<!doctype html><style>body{margin:24px;font:16px sans-serif;color:#102235}main{width:1000px}</style><title>Public gallery</title><main><h1>Public interactive prototypes</h1>${tiles}</main>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const { TOOLS } = await import('../packs/vislexicon/tools.ts');
  const { EvidenceStore } = await import('../server/evidence.ts');
  const { compile } = await import('../server/spec/compile.ts');
  const { pack } = await import('../packs/vislexicon/pack.ts');
  const { closeBrowser, browserCommand } = await import('../server/browser.ts');
  const { closeModelTransport } = await import('../server/pi.ts');
  const compiled = compile([pack]);
  const svc = { store: new EvidenceStore(path.join(root, 'evidence')), workDir: path.join(root, 'work'), publishDir: path.join(root, 'published'), inFlight: () => new Set<string>() };
  const run = async (role: 'breadth' | 'proof') => {
    const messages: string[] = [];
    const links = ['/gallery', '/cloud'].map((pathname, order) => ({ href: base + pathname, text: pathname.slice(1), inNav: true, inMain: true, hasImage: true, visible: true, order }));
    const context = {
      token: { id: role, item: 'fixture', url: base, data: { canonical: base, kind: 'assets', host: '127.0.0.1', title: 'Public fixture', home: { finalUrl: base + '/', navLinks: links }, homeLinks: links, readerPlan: role === 'proof' ? { proof: { url: base + '/cloud', alternatives: [{ url: base + '/gallery' }] } } : undefined, shots: {} } },
      node: compiled.nodes.find(node => node.key === `curation/${role}`), attempt: `a-${role}`, worker: { id: role }, signal: new AbortController().signal,
      progress: (message: string) => messages.push(message), activity() {}, addEvidence: (evidence: unknown) => evidence,
    } as unknown as StationContext;
    const result = await TOOLS[`curation.${role}`](context, svc);
    assert.equal(result.ok, true, messages.join('\n'));
    assert.equal((result.data!.shots as any)[role].href, base + '/gallery');
    const failures = result.data!.candidateAccessFailures as any[];
    assert.equal(failures.length, 1);
    assert.equal(failures[0].requestedUrl, base + '/cloud');
    assert.equal(failures[0].url, base + '/login');
    assert.equal(failures[0].owner, 'agent');
    assert.equal(failures[0].tag, 'needs_selection');
    assert.ok((await browserCommand({ action: 'state' })).tabs.some((tab: any) => tab.url === base + '/login' && tab.attentionKind === 'auth'), 'the real access wall stays available without blocking capture');
  };
  try {
    await t.test('breadth still compares the gallery captured before the private Cloud page', () => run('breadth'));
    await t.test('proof skips the private Cloud page and visits the public alternative', () => run('proof'));
  } finally {
    await closeBrowser(); await closeModelTransport(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), 'easy-workflow-optional-auth-')));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
