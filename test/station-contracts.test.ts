import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { arbiter, audit, classify, copy, facts, factReview, FACT_FIELDS, shotReview, style } from '../packs/vislexicon/agents.ts';
import { KINDS } from '../packs/vislexicon/env.ts';
import { rememberRead, withEvidenceReads } from '../server/network.ts';
import {EvidenceStore, runFfmpeg} from '../server/evidence.ts';
import {readRole} from '../server/roles.ts';
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
    rememberRead('https://site.example/#/components', 'A component-specific routed page.');
    assert.deepEqual(arbiter.check!({ ...answer, quote: 'A component-specific routed page.', sourceUrl: 'https://site.example/#/components' }, ctx), []);
    assert.ok(arbiter.check!({ ...answer, quote: 'A component-specific routed page.', sourceUrl: 'https://site.example/#/pricing' }, ctx).length, 'a SPA route is a separate source page');
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
    rememberRead('https://site.example/#!/license', quote);
    out.license.sourceUrl = 'https://site.example/#!/license';
    assert.deepEqual(facts.check!(out, ctx), []);
    out.license.sourceUrl = 'https://site.example/#!/pricing';
    assert.ok(facts.check!(out, ctx).length, 'a fact cannot cite a different SPA route from the one read');
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

test('final audit receives complete records and sources for static and video preview contracts', async () => {
  const role = readRole('curation/audit').content;
  assert.match(role, /静态模式[\s\S]*identity[\s\S]*breadth[\s\S]*proof/);
  assert.match(role, /录屏模式[\s\S]*identity[\s\S]*src[\s\S]*card[\s\S]*poster[\s\S]*posterCard/);
  assert.doesNotMatch(role, /以及三张截图|三张图是否齐全|三条导览和 alt/);
  assert.match(role, /不把产出者填写的 quote 本身当成独立证据/);
  assert.match(role, /逐字段审/);
  assert.match(role, /每个实际页面的导览和 alt/);
  const record = { editorial: { descriptionZh: 'Long but valid source-derived text. '.repeat(600) }, facts: [{ field: 'license', value: 'MIT', quote: 'MIT License' }], tailField: 'This last field must be reviewed.' };
  const source = 'The complete retained license source ends here.';
  const images = ['identity', 'breadth', 'proof'].map(role => ({
    role, src: `${role}.webp`, card: `${role}-card.webp`, href: `https://site.example/${role}`,
  }));
  const factPages = [{url: 'https://site.example/license', text: source}];
  const input = await audit(store).input(context({draftV3: record, images, factPages}));
  assert.ok(input.text.includes(JSON.stringify(record, null, 1)), 'never cut a JSON record in the middle of a field');
  assert.ok(input.text.includes(source), 'reviewers need the source, not only the producer’s quote');
  assert.deepEqual(input.images, images.map(image => ({file: image.card, label: `${image.role}: ${image.href}`})));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-audit-preview-contract-'));
  try {
    const evidence = new EvidenceStore(directory);
    const poster = evidence.put(await runFfmpeg([
      '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180',
      '-frames:v', '1', '-c:v', 'libwebp', '-f', 'webp', 'pipe:1',
    ]), 'webp');
    const clip = evidence.put(await runFfmpeg([
      '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=0.2',
      '-c:v', 'libx264', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1',
    ]), 'mp4');
    const video = {src: clip.src, card: clip.src, poster: poster.src, posterCard: poster.src, evidence: 'recorded-fixture', issues: []};
    const videoRecord = {
      ...record, preview: {mode: 'video', video},
      pages: [{role: 'identity', selectionRationale: 'Start at the actual home page.', shot: {alt: 'Blue fixture scene.'}}],
    };
    const videoInput = await audit(evidence).input(context({mode: 'video', video, draftV3: videoRecord, factPages}));
    assert.ok(videoInput.text.includes(JSON.stringify(videoRecord, null, 1)), 'the complete video references and identity rationale/alt stay in the final review');
    assert.ok(videoInput.text.includes(source));
    assert.equal(videoInput.images?.length, 1);
    assert.equal(videoInput.images[0].file, poster.file);
    assert.match(videoInput.images[0].label, /^identity/);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('copy numbers require complete source values after normalizing counting punctuation', () => {
  const definition = copy(store);
  const answer = {
    name: 'Email library', takeawayZh: '查找可参考的邮件版式', noteZh: '我们'.padEnd(130, '看'),
    rationale: {identity: '先看首页的邮件目录', breadth: '再看目录中的邮件分类', proof: '打开具体邮件查看版式'},
    alt: {identity: '邮件目录和筛选按钮', breadth: '多种邮件的预览网格', proof: '完整邮件和图片区域'},
    descriptionZh: '', descriptionEn: 'A directory of email examples.',
    reasons: [{statement: '提供邮件版式参考', evidenceUrl: 'https://site.example/'}], reply: '',
  };
  const check = (source: string, claim: string) => definition.check!(
    {...answer, descriptionZh: `目录包含 ${claim} 封邮件案例。`}, context({dossier: {text: source}}));
  for (const [source, claim] of [
    ['With 19,000+ curated emails and counting.', '19,000+'],
    ['With 19,000+ curated emails and counting.', '19000+'],
    ['已有 １９，０００＋ 封邮件。', '19,000+'],
    ['With 19\u202f000+ curated emails.', '１９，０００＋'],
    ['With 1,900 curated emails.', '1900'],
    ['Measured value: 19,000.5.', '19000.5'],
  ]) assert.deepEqual(check(source, claim), [], `${claim} is supported by the complete normalized source value`);
  for (const source of ['190', '1900', '19000', '190001']) {
    for (const claim of ['190', '1900', '19000', '190001']) {
      if (source === claim) assert.deepEqual(check(`There are ${source} examples.`, claim), []);
      else assert.ok(check(`There are ${source} examples.`, claim).some(issue => issue.includes('数字')),
        `${source} must not support a shorter prefix or longer invented number ${claim}`);
    }
  }
  for (const [source, claim] of [['19,000', '19000+'], ['19000', '19000%'], ['19.00', '1900'], ['1,90', '190']]) {
    assert.ok(check(`Source value: ${source}.`, claim).some(issue => issue.includes('数字')),
      'normalization must preserve qualifiers, decimals and malformed grouping');
  }
});

test('style validation reuses only its own completed pixel statistics and never accepts absent preparation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-style-contract-'));
  const file = path.join(directory, 'image.png');
  const globals = globalThis as typeof globalThis & {__styleLib?: unknown};
  const previous = globals.__styleLib;
  const answer = {subjectVisible: true, mixed: false, styles: [], signatureZh: ''};
  let verified = 0;
  globals.__styleLib = {
    checkStyle: (_out: unknown, stats: {luma: number; sat: number; vivid: number}[]) => {
      assert.equal(stats.length, 3);
      assert.ok(stats.every(stat => stat.sat > 0.9 && stat.vivid > 0.9));
      verified++;
      return [];
    },
    salvage: (out: unknown) => ({out}),
  };
  const definition = style(store);
  const ctx = context({kind: 'component-source', images: ['identity', 'breadth', 'proof'].map(role => ({role, card: file, href: `https://site.example/${role}`}))});
  try {
    assert.ok(definition.check!(answer, ctx).length);
    assert.equal(definition.salvage!(answer, ['not prepared'], ctx), null);
    fs.writeFileSync(file, await runFfmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x40', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1']));
    const prepared = await definition.input(ctx);
    assert.equal(prepared.images?.length, 3);
    fs.unlinkSync(file);
    assert.deepEqual(definition.check!(answer, ctx), [], 'synchronous submission checks do not decode the same files again');
    assert.deepEqual(definition.salvage!(answer, ['repair'], ctx), answer);
    assert.equal(verified, 1);
    ctx.attempt = 'next-attempt';
    assert.ok(definition.check!(answer, ctx).length, 'another attempt cannot reuse an old pixel preparation');
    assert.equal(definition.salvage!(answer, ['repair'], ctx), null);
    await assert.rejects(async () => definition.input(ctx), /ffmpeg|No such file|not found/i);
    ctx.attempt = 'contract-test';
    assert.ok(definition.check!(answer, ctx).length, 'a failed preparation clears earlier statistics');
    globals.__styleLib = {};
    await assert.rejects(async () => definition.input(ctx), /校验库/);
    assert.ok(definition.check!(answer, ctx).length, 'a missing verifier cannot silently approve the output');
  } finally {
    if (previous === undefined) delete globals.__styleLib;
    else globals.__styleLib = previous;
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
