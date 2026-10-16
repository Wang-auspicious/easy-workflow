import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {withDecisionClient, type DecisionClientLike, type DecisionRequest, type DecisionResponse} from '../server/decision-model.ts';
import type {StationContext} from '../server/runtime.ts';
import type {EvidenceStore} from '../server/evidence.ts';
import {readRole} from '../server/roles.ts';
import {KINDS} from '../packs/vislexicon/env.ts';
import {classify, classifyReview, factReview, copyReview} from '../packs/vislexicon/agents.ts';
import {chooseSourceLinks, classifyEvidence, prioritizeCaptureCandidates, prioritizeFactSources} from '../packs/vislexicon/decisions.ts';
import {scout, type Dossier} from '../packs/vislexicon/scout.ts';
import {closeNetwork, configureNetwork} from '../server/network.ts';
import {runAgentStation} from '../server/agent-station.ts';
import type {Docs} from '../server/docs.ts';
import {Toolbox} from '../server/toolbox.ts';
import {Broker} from '../server/broker.ts';
import type {Journal} from '../server/journal.ts';

const sentence = 'Copy and paste our ready-made interface components into your apps.';
const role = readRole('curation/classify').content;

function context(data: Record<string, unknown> = {}): StationContext {
  return {token: {id: 'decision-fixture', item: 'fixture', url: 'https://fixture.test', data},
    node: {key: 'curation/classify', line: 'curation'}, attempt: 'decision-attempt',
    worker: {id: 'fixture-worker'}, signal: new AbortController().signal,
    progress: () => {}, activity: () => {}, addEvidence: (evidence: unknown) => evidence} as unknown as StationContext;
}

function response(answers: DecisionResponse['answers']): DecisionResponse {
  return {answers, model: 'kev-9b-v1.0', usage: {inputTokens: 30, outputTokens: 2}, latencyMs: 1, requestId: 'fixture-request'};
}

function choice(value: string, confidence = 0.99): DecisionResponse['answers'][string] {
  return {type: 'choice', choice: value, confidence, probabilities: {[value]: confidence, none: 1 - confidence}};
}

function classification(firstYes = 2): DecisionResponse {
  return response({...Object.fromEntries(KINDS.map((_, index) => [`q${index + 1}`, {type: 'noul' as const, noul: index + 1 === firstYes ? 0.99 : 0.01}])), quote: choice('s0')});
}

function client(run: (request: DecisionRequest) => DecisionResponse | null): DecisionClientLike {
  return {decide: async request => run(request)};
}

function dossier(text = sentence): Dossier {
  return {url: 'https://fixture.test', finalUrl: 'https://fixture.test', status: 200, title: 'Fixture', description: '', text,
    headings: [], links: [], framework: [], files: {llms: null, llmsFull: null, sitemap: [], sitemapCount: 0}, pages: [], repo: null, via: ['fixture']};
}

test('classification candidates preserve source and documents, and only the original agent submit produces kind1', async () => {
  const evidence: unknown[] = [];
  const ctx = context({dossier: dossier(), kind2: {kind: 'gallery', reason: 'REVIEW_SECRET'},
    understanding: {takeaway: {text: 'READER_SECRET'}}, caseBrief: 'CASE_SECRET'});
  ctx.addEvidence = value => {evidence.push(value); return value as ReturnType<StationContext['addEvidence']>;};
  let calls = 0;
  await withDecisionClient(client(request => {
    calls++;
    assert.equal(request.purpose, 'curation.classify');
    assert.equal(Object.keys(request.questions).length, 8);
    assert.doesNotMatch(JSON.stringify(request.state), /REVIEW_SECRET|READER_SECRET|CASE_SECRET/);
    assert.match(request.questions.quote.instructions, /component-source/);
    return classification();
  }), async () => {
    const saved = JSON.stringify(ctx.token.data);
    const input = await classify.input(ctx);
    assert.match(input.text, /未批准/);
    assert.ok(input.text.includes(sentence));
    assert.match(input.text, /完整 PROJECT \/ CONTEXT \/ CASE/);
    assert.equal(JSON.stringify(ctx.token.data), saved);
    assert.equal(ctx.token.data.kind1, undefined);
    assert.ok(!evidence.some(value => (value as {id: string}).id === `kind1-${ctx.attempt}`));
    assert.equal(classify.skip, undefined);
    assert.equal(classifyReview.skip, undefined);
    const independent = await classifyReview.input(ctx);
    assert.ok(independent.text.includes(sentence));
    assert.doesNotMatch(independent.text, /Kev 文字分类候选/);
    ctx.redo = {reason: 'Human correction', byHuman: true};
    assert.doesNotMatch((await classify.input(ctx)).text, /Kev 文字分类候选/);
    delete ctx.redo;
    assert.equal(calls, 1);

    // Drive the real launcher/MCP submit boundary with a deterministic local
    // protocol fixture. No external model or production project is invoked.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-classify-docs-'));
    const docs = {dir, envelope: () => ({text: 'PROJECT_POLICY\nCONTEXT_POLICY\nCASE_POLICY',
      sizes: {role: 0, project: 14, context: 14, caseFile: 11}})} as unknown as Docs;
    const toolbox = new Toolbox({journal: {append: () => {throw new Error('Unexpected write');}} as unknown as Journal,
      broker: new Broker({browser: 1, http: 1, model: 1, cpu: 1}), docs: () => docs});
    const submitted = {kind: 'component-source', answers: [{q: 1, yes: false, quote: ''}, {q: 2, yes: true, quote: sentence}], confidence: 0.77};
    const launcher = `import assert from 'node:assert/strict';
import fs from 'node:fs';
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
const text = request.firstMessage.content[0].text;
for (const marker of ['PROJECT_POLICY', 'CONTEXT_POLICY', 'CASE_POLICY', 'Kev 文字分类候选', ${JSON.stringify(sentence)}]) assert.ok(text.includes(marker), marker);
if (request.model === 'fixture-submit') {
  const connection = JSON.parse(fs.readFileSync(request.mcpServers.h2_station.env.EASY_WORKFLOW_STATION_CONNECTION, 'utf8'));
  const result = await fetch(connection.url + '/call', {method: 'POST', headers: {authorization: 'Bearer ' + connection.token, 'content-type': 'application/json'}, body: JSON.stringify({name: 'submit', arguments: ${JSON.stringify(submitted)}})});
  assert.equal(result.status, 200);
}
process.stdout.write(JSON.stringify({model: request.model, usage: {input: 20, output: 5, cost: 0}}));`;
    try {
      const definition = {...classify, services: {docs: () => docs, toolbox: () => toolbox}};
      const noSubmit = await runAgentStation({...definition, agent: {adapter: 'launcher',
        command: [process.execPath, '--input-type=module', '-e', launcher], model: 'fixture-no-submit'}}, ctx);
      assert.equal(noSubmit.ok, false);
      assert.equal(noSubmit.data?.kind1, undefined);
      const result = await runAgentStation({...definition, agent: {adapter: 'launcher',
        command: [process.execPath, '--input-type=module', '-e', launcher], model: 'fixture-submit'}}, ctx);
      assert.equal(result.ok, true, result.error ?? 'The original agent must submit successfully');
      assert.deepEqual(result.data?.kind1, submitted, 'the final value comes from the original agent submit, not Kev');
      assert.equal(ctx.token.data.kind1, undefined, 'input preparation never mutates token state');
    } finally {
      assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(dir).startsWith('easy-workflow-classify-docs-'));
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
  assert.equal(calls, 3);
});

test('uncertain, ungrounded, visual-only and unavailable classifications fall back without accepting a result', async () => {
  const pages = [{url: 'https://fixture.test', text: sentence}];
  const uncertain = classification();
  uncertain.answers.q1 = {type: 'noul', noul: 0.5};
  const weakQuote = classification();
  weakQuote.answers.quote = choice('s0', 0.7);
  const invented = classification();
  invented.answers.quote = choice('s99');
  for (const result of [null, uncertain, weakQuote, invented, classification(7)]) {
    await withDecisionClient(client(() => result), async () => {
      assert.equal(await classifyEvidence(context(), KINDS, role, pages), null);
    });
  }
  let calls = 0;
  await withDecisionClient(client(() => {calls++; return classification();}), async () => {
    assert.equal(await classifyEvidence(context(), KINDS, 'No ordered role rules', pages), null);
    assert.equal(await classifyEvidence(context(), KINDS, role, [{url: pages[0].url, text: 'Sign in'}]), null);
    assert.equal(await classifyEvidence(context(), KINDS, role, [{url: pages[0].url, text: 'x'.repeat(5000)}]), null);
  });
  assert.equal(calls, 0, 'missing rules and absent complete sentences do not spend a model request');
});

test('classification bounds shared context without cutting sentences or losing negation', async () => {
  const sentences = Array.from({length: 30}, (_, index) => `第${index}条：${'这是网站的真实公开文字，但不提供商用许可。'.repeat(5)}`);
  await withDecisionClient(client(request => {
    const state = request.state as {sourceSentences: {id: string; text: string}[]};
    assert.ok(state.sourceSentences.length <= 12);
    assert.ok(state.sourceSentences.reduce((sum, item) => sum + item.text.length, 0) <= 1200);
    assert.ok(state.sourceSentences.every(item => sentences.includes(item.text)));
    return null;
  }), () => classifyEvidence(context(), KINDS, role, [{url: 'https://fixture.test', text: sentences.join('\n')}]));
});

test('capture priorities preserve every candidate object and Storybook route', async () => {
  const candidates = [{href: 'https://fixture.test/pricing', why: 'fallback'},
    {href: 'https://fixture.test/?path=/docs/button--docs', why: 'storybook'},
    {href: 'https://fixture.test/gallery', why: 'other'}];
  const snapshot = JSON.stringify(candidates);
  await withDecisionClient(client(request => {
    assert.equal(request.purpose, 'curation.capture.proof.priority');
    return response({proof: choice('p1')});
  }), async () => {
    const ordered = await prioritizeCaptureCandidates(context(), candidates, [], 'proof');
    assert.equal(ordered[0], candidates[1]);
    assert.equal(ordered.length, candidates.length);
    assert.deepEqual(new Set(ordered), new Set(candidates));
    assert.equal(JSON.stringify(candidates), snapshot);
    assert.match(ordered[0].href, /\?path=\/docs\/button--docs/);
  });
  await withDecisionClient(client(() => response({proof: choice('p1', 0.6)})), async () => {
    assert.deepEqual(await prioritizeCaptureCandidates(context(), candidates, [], 'proof'), candidates);
  });
});

test('batched link and fact priorities respect choice limits while retaining full old evidence', async () => {
  const links = Array.from({length: 25}, (_, index) => ({href: `https://fixture.test/p${index}`, text: `Page ${index}`}));
  const pages = links.map(link => ({url: link.href, text: `FULL ORIGINAL QUOTE ${'evidence '.repeat(600)}`}));
  let calls = 0;
  await withDecisionClient(client(request => {
    calls++;
    const questions = Object.values(request.questions);
    assert.ok(questions.length <= 8);
    assert.ok(questions.every(question => question.type !== 'choice' || Object.keys(question.criteria).length <= 16));
    const options = questions.reduce((sum, question) => sum + (question.type === 'choice' ? Object.keys(question.criteria).length : 0), 0);
    assert.ok(options <= 64);
    return response(Object.fromEntries(Object.keys(request.questions).map(id => [id, choice('p1')])));
  }), async () => {
    const selected = await chooseSourceLinks(context(), links, ['catalogue', 'about', 'pricing', 'license', 'docs'].map(id => ({id, instructions: id})), 'fixture.links');
    assert.equal(selected.get('pricing'), links[1].href);
    const ordered = await prioritizeFactSources(context(), pages);
    assert.equal(ordered[0], pages[1]);
    assert.equal(ordered.length, pages.length);
    assert.deepEqual(new Set(ordered), new Set(pages));
    assert.ok(ordered.every(page => page.text.length > 3500), 'ranking previews never replace stored evidence');
  });
  assert.equal(calls, 2);
});

test('review hints cannot approve facts or copy and preserve original evidence and actual images', async () => {
  const quote = 'License permits personal use only. Commercial use requires the Pro plan.';
  const ctx = context({facts: {commercial: {value: 'allowed', scope: 'all plans', quote}},
    factPages: [{url: 'https://fixture.test/license', text: quote}],
    copy: {name: 'Fixture', takeawayZh: '免费商用所有组件'},
    images: [{role: 'identity', card: '/identity.webp', href: 'https://fixture.test'}]});
  const saved = JSON.stringify(ctx.token.data);
  const purposes: string[] = [];
  await withDecisionClient(client(request => {
    purposes.push(request.purpose);
    return response(Object.fromEntries(Object.keys(request.questions).map(id => [id, {type: 'noul', noul: 0.01}])));
  }), async () => {
    const factInput = await factReview.input(ctx);
    assert.match(factInput.text, /仅待核对线索/);
    assert.ok(factInput.text.includes(quote));
    const store = {resolve: (file: string) => file} as EvidenceStore;
    const copyInput = await copyReview(store).input(ctx);
    assert.match(copyInput.text, /不是自动拒收/);
    assert.equal(copyInput.images?.length, 1);
    assert.equal(copyInput.images?.[0].file, '/identity.webp');
    assert.equal(JSON.stringify(ctx.token.data), saved, 'prechecks do not mutate facts, verdicts, copy or image references');
    assert.equal(factReview.skip, undefined);
    assert.equal(copyReview(store).skip, undefined);
  });
  assert.deepEqual(purposes, ['curation.facts.review', 'curation.copy.review']);
});

test('scout uses semantic page selections in actual HTTP reads and retains deterministic fallbacks', async () => {
  configureNetwork({cacheDir: null});
  const visited: string[] = [];
  const server = http.createServer((request, result) => {
    const pathname = request.url ?? '/';
    visited.push(pathname);
    result.setHeader('content-type', 'text/html');
    if (pathname === '/') {
      result.end('<title>Fixture</title><main>Public component library with documented usage conditions.</main><nav><a href="/pricing">Pricing</a><a href="/offres">Tarifs actuels</a><a href="/conditions">Licence</a></nav>');
    } else if (['/pricing', '/offres', '/conditions'].includes(pathname)) {
      result.end(`<title>${pathname}</title><main>Original evidence of product terms on ${pathname}.</main>`);
    } else {
      result.writeHead(404);
      result.end('Not found');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  let calls = 0;
  try {
    await withDecisionClient(client(request => {
      calls++;
      assert.equal(request.purpose, 'curation.scout.key-pages');
      const pages = (request.state as {pages: {id: string; url: string}[]}).pages;
      return response({pricing: choice(pages.find(page => page.url.endsWith('/offres'))!.id),
        license: choice(pages.find(page => page.url.endsWith('/conditions'))!.id)});
    }), async () => {
      const result = await scout(context({canonical: base, host: '127.0.0.1'}), {});
      assert.equal(result.ok, true);
      const output = result.data?.dossier as Dossier;
      assert.ok(output.pages.some(page => page.url === `${base}/offres`));
      assert.ok(output.pages.some(page => page.url === `${base}/conditions`));
      assert.ok(output.pages.some(page => page.url === `${base}/pricing`));
      assert.equal(output.links.length, 3);
      assert.equal(output.pages[0].url, `${base}/offres`);
    });
    assert.equal(calls, 1);
    assert.ok(visited.includes('/offres'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await closeNetwork();
  }
});
