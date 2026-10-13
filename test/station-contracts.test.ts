import test from 'node:test';
import assert from 'node:assert/strict';
import { arbiter, audit, classify, facts, factReview, FACT_FIELDS, shotReview } from '../packs/vislexicon/agents.ts';
import { KINDS } from '../packs/vislexicon/env.ts';
import { rememberRead, withEvidenceReads } from '../server/network.ts';
import type { EvidenceStore } from '../server/evidence.ts';
import type { StationContext } from '../server/runtime.ts';

const context = (patch: Record<string, unknown> = {}) => ({
  signal: new AbortController().signal, attempt: 'contract-test',
  token: { data: {
    canonical: 'https://site.example/', host: 'site.example', mode: 'image', kind: 'tool',
    dossier: {
      url: 'https://old.example/', finalUrl: 'https://site.example/', status: 200,
      title: 'Library', description: '', text: 'A public library.', headings: [], framework: [], via: [],
      links: [{ text: 'LUTs', href: 'https://site.example/luts', region: 'footer' }],
      files: { llms: 'Machine-readable documentation for the library.', llmsFull: null, sitemap: [], sitemapCount: 0 },
      pages: [{ url: 'https://site.example/components', title: 'Components', text: 'Copy accessible components with source code.', why: 'catalogue' }], repo: null,
    }, ...patch,
  } }, addEvidence: () => {}, progress: () => {},
}) as unknown as StationContext;
const store = { resolve: (file: string) => file } as unknown as EvidenceStore;

test('classification answers must follow the decision order and stop at the first YES', () => {
  const ctx = context();
  const answer = { kind: KINDS[1], confidence: .9, answers: [
    { q: 1, yes: false, quote: '' }, { q: 2, yes: true, quote: 'Copy accessible components with source code.' },
  ] };
  assert.deepEqual(classify.check!(answer, ctx), []);
  for (const answers of [
    [...answer.answers].reverse(),
    [...answer.answers, { q: 3, yes: false, quote: '' }],
    [answer.answers[0], answer.answers[0], answer.answers[1]],
  ]) assert.ok(classify.check!({ ...answer, answers }, ctx).length, 'out-of-order, repeated or post-decision answers must be rejected');
});

test('arbitration binds its entire quote to the actual source page, including redirects and tool reads', async () => {
  await withEvidenceReads(async () => {
    const ctx = context(), answer = { kind: KINDS[1], reason: 'The source provides components.', quote: 'Copy accessible components with source code.', sourceUrl: 'https://site.example/components' };
    assert.deepEqual(arbiter.check!(answer, ctx), []);
    for (const sourceUrl of ['', 'javascript:alert(1)', 'https://unread.example/', 'https://site.example/'])
      assert.ok(arbiter.check!({ ...answer, sourceUrl }, ctx).length, `cannot attribute the quote to ${sourceUrl}`);
    assert.deepEqual(arbiter.check!({ ...answer, quote: 'A public library.', sourceUrl: 'https://old.example/' }, ctx), []);
    assert.deepEqual(arbiter.check!({ ...answer, quote: 'LUTs → https://site.example/luts', sourceUrl: 'https://site.example/' }, ctx), []);
    assert.deepEqual(arbiter.check!({ ...answer, quote: 'Machine-readable documentation for the library.', sourceUrl: 'https://site.example/llms.txt' }, ctx), []);
    rememberRead('https://site.example/detail?variant=one', 'One rendered component, ready to copy.');
    assert.deepEqual(arbiter.check!({ ...answer, quote: 'One rendered component, ready to copy.', sourceUrl: 'https://site.example/detail?variant=one' }, ctx), []);
    assert.ok(arbiter.check!({ ...answer, quote: 'One rendered component, ready to copy.', sourceUrl: 'https://site.example/detail?variant=two' }, ctx).length);
    assert.deepEqual(arbiter.check!({ ...answer, kind: '', sourceUrl: '' }, ctx), [], 'uncertainty may still be sent to a human');
  });
});

test('fact repair reuses the persisted cited text instead of invalidating unrelated known facts', async () => {
  await withEvidenceReads(async () => {
    const quote = 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.';
    const text = 'Earlier page content. '.repeat(300) + quote;
    const out: any = { ...Object.fromEntries(FACT_FIELDS.map(field => [field, { value: 'unknown', sourceUrl: '', quote: '', evidence: 'Not found.', scope: '' }])), pricingNote: '', conflicts: [], reply: '' };
    out.license = { value: 'MIT', sourceUrl: 'https://site.example/', quote, evidence: 'Original license text.', scope: 'source code' };
    const ctx = context({ facts: out, factPages: [{ url: 'https://site.example/', text }] });
    const input = await facts.input(ctx);
    assert.ok(input.text.includes(text), 'the repair sees the source supporting an unchanged fact');
    assert.deepEqual(facts.check!(out, ctx), []);
    const result = await facts.after(out, ctx, { rounds: 1, issues: [] });
    assert.ok((result.data!.factPages as { text: string }[]).some(page => page.text === text));
  });
});

test('a pass cannot coexist with unresolved review problems', () => {
  const ctx = context();
  assert.deepEqual(factReview.check!({ verdict: 'pass', problems: [], reason: 'The evidence supports the facts.' }, ctx), []);
  assert.ok(factReview.check!({ verdict: 'pass', problems: [{ field: 'facts.license', problem: 'Quote does not support this license.' }], reason: 'Almost correct.' }, ctx).length);
  assert.ok(factReview.check!({ verdict: 'fix', problems: [{ field: '', problem: '' }], reason: 'Fix.' }, ctx).length);
});

test('screenshot approval accounts for each required image exactly once and never hides a failed image', () => {
  const def = shotReview(store), ctx = context();
  const perImage = ['identity', 'breadth', 'proof'].map(role => ({ role, ok: true, reason: 'Shows its assigned subject.' }));
  const answer = { verdict: 'pass' as const, perImage, reason: 'All required images checked.' };
  assert.deepEqual(def.check!(answer, ctx), []);
  for (const images of [[], perImage.slice(0, 2), [...perImage, perImage[0]], perImage.map(image => ({ ...image, ok: image.role !== 'proof' }))])
    assert.ok(def.check!({ ...answer, perImage: images }, ctx).length);
  assert.deepEqual(def.check!({ verdict: 'return', perImage: perImage.map(image => ({ ...image, ok: image.role !== 'proof' })), returnTo: 'proof', repair: 'reframe', reason: 'The component is below the captured area.' }, ctx), []);
  assert.deepEqual(def.check!({ ...answer, perImage: [{ role: 'poster', ok: true, reason: 'The video subject is visible.' }] }, context({ mode: 'video' })), []);
});

test('final audit receives the complete record and the persisted source material', async () => {
  const record = { editorial: { descriptionZh: 'Long but valid source-derived text. '.repeat(600) }, facts: [{ field: 'license', value: 'MIT', quote: 'MIT License' }], tailField: 'This last field must be reviewed.' };
  const source = 'The complete retained license source ends here.';
  const input = await audit(store).input(context({ draftV3: record, factPages: [{ url: 'https://site.example/license', text: source }] }));
  assert.ok(input.text.includes(JSON.stringify(record, null, 1)), 'never cut a JSON record in the middle of a field');
  assert.ok(input.text.includes(source), 'reviewers need the source, not only the producer’s quote');
});
