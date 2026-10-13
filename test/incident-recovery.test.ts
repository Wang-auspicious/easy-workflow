import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../shared/failures.ts';
import { ModelRequests } from '../server/model-requests.ts';
import { withEvidenceReads, rememberRead } from '../server/network.ts';
import { classify, facts, FACT_FIELDS } from '../packs/vislexicon/agents.ts';
import { KINDS } from '../packs/vislexicon/env.ts';
import type { StationContext } from '../server/runtime.ts';
import { createRequire } from 'node:module';

test('provider outages, site timeouts and validation failures retain their own cause', () => {
  for (const message of ['Connection error.', 'Request timed out.', 'HTTP 429', 'HTTP 503', 'ECONNRESET']) {
    const failure = classifyFailure(message, { stage: 'model' });
    assert.equal(failure.tag, 'model_transport', message);
    assert.equal(failure.owner, 'system');
    assert.doesNotMatch(failure.nextAction!, /共享浏览器补取/);
  }
  assert.equal(classifyFailure('HTTP 401', {stage:'model'}).tag, 'model_unavailable');
  assert.equal(classifyFailure('net::ERR_TIMED_OUT at https://site.example').tag, 'network_timeout');
  assert.equal(classifyFailure('the quote is not verbatim', {stage:'model'}).tag, 'tool_error');
});

test('explicit provider service errors use model recovery only at the model boundary', () => {
  const message = 'server_error: The model failed to generate a response.';
  for (const error of [message, new Error(message),
    Object.assign(new Error('Provider could not complete the request'), {code: 'server_error'}),
    new Error('Provider request failed', {cause: Object.assign(new Error('Internal failure'), {code: 'internal_server_error'})}),
    'service_unavailable: Model service is unavailable',
  ]) {
    const failure = classifyFailure(error, {stage: 'model'});
    assert.equal(failure.tag, 'model_transport');
    assert.equal(failure.category, 'system');
    assert.equal(failure.owner, 'system');
    assert.equal(failure.retryable, true);
    assert.match(failure.nextAction!, /冷却/);
  }
  assert.equal(classifyFailure('Provider unavailable', {stage: 'model', status: 503}).tag, 'model_transport');
  assert.equal(classifyFailure(message).tag, 'tool_error', 'an ordinary tool error must not create a model circuit');
  assert.equal(classifyFailure(message, {stage: 'capture'}).tag, 'browser_capture');
  assert.equal(classifyFailure('Unknown submit property server_error', {stage: 'model'}).tag, 'tool_error');
  for (const error of ['server_error: invalid api key', 'server_error: insufficient balance',
    'server_error: certificate has expired', 'server_error: ERR_TLS_CERT_ALTNAME_INVALID']) {
    const failure = classifyFailure(error, {stage: 'model'});
    assert.equal(failure.tag, 'model_unavailable');
    assert.equal(failure.owner, 'user');
  }
});

test('model request slots include helpers and release cancelled waiters without leaking capacity', async () => {
  const slots = new ModelRequests(1), release = await slots.acquire();
  const abort = new AbortController();
  const cancelled = slots.acquire(abort.signal);
  const rejected = assert.rejects(cancelled, /cancelled/);
  abort.abort(new Error('cancelled')); await rejected;
  const next = slots.acquire(); assert.equal(slots.queued, 1);
  release(); release(); const done = await next;
  assert.equal(slots.active, 1); assert.equal(slots.queued, 0);
  done(); assert.equal(slots.active, 0);
});

const context = () => ({ signal:new AbortController().signal, attempt:'citation', token: { data: { canonical:'https://site.example/', dossier: {
  url:'https://site.example/', finalUrl:'https://site.example/', title:'Library', description:'', text:'A public library.', headings:[], framework:[], via:[],
  links:[{text:'LUTs',href:'https://site.example/luts',region:'footer'}], files:{llms:null,llmsFull:null,sitemap:[],sitemapCount:0}, pages:[], repo:null,
} } }, addEvidence:()=>{} }) as unknown as StationContext;

test('the classification validator accepts the exact link text it presented and the current attempt’s reads', async () => {
  await withEvidenceReads(async () => {
    const ctx=context(); const out={kind:KINDS[0],answers:[{q:1,yes:true,quote:'LUTs → https://site.example/luts'}],confidence:.9};
    assert.match((await classify.input(ctx)).text, /LUTs →/);
    assert.deepEqual(classify.check!(out,ctx), []);
    out.answers[0].quote='Unique evidence from a tool read';
    rememberRead('https://site.example/luts',out.answers[0].quote);
    assert.deepEqual(classify.check!(out,ctx), []);
  });
  await withEvidenceReads(async () => {
    assert.ok(classify.check!({kind:KINDS[0],answers:[{q:1,yes:true,quote:'Unique evidence from a tool read'}],confidence:.9},context()).length, 'another worker must not inherit this evidence');
  });
});

test('facts validate full quotes from later reads and carry them to the reviewer', async () => {
  await withEvidenceReads(async () => {
    const ctx=context(); await facts.input(ctx);
    const quote='Permission is hereby granted, free of charge, to any person obtaining a copy of this software.';
    const full='unrelated preface '.repeat(300)+quote;
    rememberRead('https://site.example/', full);
    const out:any={...Object.fromEntries(FACT_FIELDS.map(f=>[f,{value:'unknown',sourceUrl:'',quote:'',evidence:'Not found',scope:''}])),pricingNote:'',conflicts:[],reply:''};
    out.license={value:'MIT',sourceUrl:'https://site.example/',quote,evidence:'LICENSE text',scope:'source'};
    assert.deepEqual(facts.check!(out,ctx),[]);
    const result=await facts.after(out,ctx,{rounds:1,issues:[]});
    assert.ok((result.data!.factPages as {text:string}[]).some(p=>p.text.includes(quote)));
    out.license.quote=quote+' Invented tail after eighty real characters.';
    assert.ok(facts.check!(out,ctx).length, 'matching a prefix must not authorize an invented tail');
  });
});

test('desktop task popups cannot escape into persistent user tabs', () => {
  const {BrowserManager}=createRequire(import.meta.url)('../app/browser-manager.cjs');
  const manager=Object.create(BrowserManager.prototype), opened:string[]=[];
  manager.create=(url:string)=>opened.push(url);
  assert.deepEqual(manager.openWindow({owner:'agent'},{url:'https://ad.example'}),{action:'deny'});
  assert.equal(opened.length,0);
  manager.openWindow({owner:'user'},{url:'https://user.example'});
  assert.deepEqual(opened,['https://user.example']);
});
