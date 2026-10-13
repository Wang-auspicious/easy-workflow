import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-batch-'));
process.env.FACTORY_VAR = dir;
process.env.FACTORY_PREFLIGHT = '0';
process.env.FACTORY_HTTP_CACHE = '0';
process.env.VISLEXICON_ROOT = path.join(dir, 'unconnected');
const { Factory: BaseFactory } = await import('../server/factory.ts');
const { FactoryControl } = await import('../server/control.ts');
const { SourceSupervisor } = await import('../server/sources.ts');
const { batchSummary } = await import('../shared/batch.ts');
const close = async (factory: InstanceType<typeof Factory>) => {
  await factory.sources?.close(); factory.channels?.close();
  await factory.runtime.close(); factory.docs.flush(); factory.lessons.close(); factory.journal.close();
};
const catalog = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `site-${i}`, name: `Site ${i}`, canonicalUrl: `https://site-${i}.example/` }));
// These cases use in-memory executors. Test admission independently of the host's
// free RAM; browser/memory backpressure has its own broker coverage.
class Factory extends BaseFactory {
  override async boot() { await super.boot(); this.broker.memoryFloorMB = 0; }
}

test('legacy system-created manual stops with a missing sibling become resumable without overriding real human review', async () => {
  let factory=new Factory();
  try {
    await factory.boot();factory.broker.memoryFloorMB=0;factory.runtime.start('legacy frontier');
    factory.runtime.executors=()=>async()=>({ok:true,summary:'fixture'});
    const token=factory.runtime.create('curation/shot-review',{item:'legacy-frontier',url:'https://site.example/',source:'candidates/pool',data:{canonical:'https://site.example/',recoveryRoot:'curation/plan',recoveryStation:'curation/shot-review'}});
    token.entry='curation/plan';token.closure=factory.runtime.closureOf(token.entry);
    token.done=new Set(['curation/plan','curation/identity','curation/breadth','curation/proof','curation/process','curation/facts']);
    factory.journal.append({kind:'token.data',token:token.id,patch:{checkpointDone:[...token.done]}});
    factory.runtime.restoreFlow(token);
    factory.runtime.resumeFrontier=()=>{}; // Reproduce the previous scheduler.
    await factory.runtime.settle();
    assert.equal(factory.state.tokens[token.id].status,'manual');factory.runtime.pause();
    await close(factory);factory=new Factory();await factory.boot();
    assert.equal(factory.state.tokens[token.id].status,'parked');
    assert.equal(factory.state.recoveries[token.item].failure?.code,'RESTORED_FRONTIER_MISSING');
    assert.equal(factory.state.tokens[token.id].finishedAtNode,'curation/fact-review');
    factory.runtime.executors=node=>async()=>({ok:true,summary:'fixture',data:node.key==='curation/gate'?{gate:'pass'}:undefined});
    factory.runtime.resume();const [retry]=factory.retryCandidates({items:[token.item],count:1});await factory.runtime.settle();
    assert.equal(factory.state.tokens[retry.id].status,'published');
  } finally {await close(factory);fs.rmSync(dir,{recursive:true,force:true});}
});

test('retrying a failed screenshot review also restores the cancelled facts-review sibling', async () => {
  const factory=new Factory();let siblingStarted=false;
  try {
    await factory.boot();factory.broker.memoryFloorMB=0;
    factory.runtime.start('interrupted parallel reviews');
    factory.runtime.executors=node=>async ctx=>{
      if(node.key==='curation/fact-review') {siblingStarted=true; await new Promise((resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true}));}
      if(node.key==='curation/shot-review') {for(let i=0;i<100&&!siblingStarted;i++)await new Promise(r=>setTimeout(r,5));return {ok:false,summary:'fixture interruption',failure:{tag:'tool_error',category:'system',message:'interrupted review',retryable:true}};}
      return {ok:true,summary:'fixture complete'};
    };
    const old=factory.runtime.create('curation/plan',{item:'parallel-item',url:'https://site.example/',source:'candidates/pool',data:{canonical:'https://site.example/'}});
    await factory.runtime.settle();assert.equal(siblingStarted,true);
    assert.equal(factory.state.tokens[old.id].status,'parked');
    const nodes:string[]=[];
    factory.runtime.executors=node=>async()=>{nodes.push(node.key);return {ok:true,summary:'fixture recovered',data:node.key==='curation/gate'?{gate:'pass'}:undefined};};
    const [retry]=factory.retryCandidates({items:[old.item],count:1});await factory.runtime.settle();
    assert.equal(factory.state.tokens[retry.id].status,'published');
    assert.ok(nodes.includes('curation/fact-review'),'cancelled sibling must rejoin the live frontier');
    assert.ok(!nodes.includes('curation/facts'),'completed facts are not recomputed');
    assert.equal(nodes.filter(n=>n==='curation/shot-review').length,1);
  } finally {await close(factory);fs.rmSync(dir,{recursive:true,force:true});}
});

test('waiting for browser capacity stays queued and never consumes a website recovery', async () => {
  const factory=new Factory();let calls=0;
  try {
    await factory.boot();factory.catalog=catalog(1);
    factory.runtime.executors=()=>async()=> ++calls===1
      ? {ok:false,summary:'capacity wait',failure:{tag:'tool_error',category:'system',code:'BROWSER_CAPACITY_TIMEOUT',message:'pool full',retryable:true,owner:'system'}}
      : {ok:true,summary:'fixture',finish:{status:'published',reason:'fixture'}};
    const [token]=factory.pull(1);await factory.runtime.settle();
    assert.equal(factory.state.tokens[token.id].status,'active');
    assert.equal(factory.state.recoveries[token.item],undefined);
    await new Promise(r=>setTimeout(r,5100));await factory.runtime.settle();
    assert.equal(factory.state.tokens[token.id].status,'published');
    assert.equal(factory.runtime.tokens.size,1);assert.equal(calls,2);
    assert.equal(Object.values(factory.state.attempts).filter(a=>!a.ok&&!a.cancelled).length,0);
  } finally {await close(factory);fs.rmSync(dir,{recursive:true,force:true});}
});

test('provider circuit and checkpoints survive restart without treating a paused run as authorization to retry', async () => {
  let factory=new Factory();
  try {
    await factory.boot();factory.catalog=catalog(1);
    factory.runtime.executors=()=>async()=>({ok:false,summary:'模型调用失败',failure:{tag:'model_transport',category:'system',message:'Connection error.',retryable:true,owner:'system'}});
    factory.batch.configure({target:1});await factory.runtime.settle();factory.runtime.pause();
    await close(factory);factory=new Factory();await factory.boot();
    const count=factory.runtime.tokens.size;
    assert.equal(factory.state.batch?.modelCircuit?.state,'open');assert.ok(factory.broker.modelHold);
    factory.batch.pump(Date.now()+3600000);await factory.runtime.settle();
    assert.equal(factory.runtime.tokens.size,count);assert.equal(factory.runtime.paused,true);
  } finally {await close(factory);fs.rmSync(dir,{recursive:true,force:true});}
});

test('a shared provider outage stops intake and recovers one real checkpoint before reopening the batch', async () => {
  const factory=new Factory(); let broken=true;
  try {
    await factory.boot(); factory.catalog=catalog(10);
    factory.runtime.executors=()=>async()=>broken
      ? {ok:false,summary:'模型调用失败',failure:{tag:'model_transport',category:'system',message:'Connection error.',retryable:true,owner:'system'}}
      : {ok:true,summary:'real checkpoint fixture',finish:{status:'published',reason:'fixture'}};
    factory.batch.configure({target:6,maxInFlight:4,intakeWindow:2});
    await factory.runtime.settle();
    assert.ok(batchSummary(factory.state)!.admitted<=2,'an outage must not feed the remaining catalog');
    assert.equal(factory.state.batch!.modelCircuit?.state,'open');
    assert.ok(factory.broker.modelHold);
    assert.ok(Object.values(factory.state.tokens).every(t=>!t.data.batchRecovery),'provider downtime is not a website retry');
    broken=false;
    factory.batch.pump(Date.now()+60000); await factory.runtime.settle();
    assert.equal(factory.state.batch!.modelCircuit,undefined);
    assert.equal(factory.broker.modelHold,null); assert.equal(factory.broker.recoveryToken,null);
    assert.equal(batchSummary(factory.state)!.published,6);
  } finally {await close(factory);fs.rmSync(dir,{recursive:true,force:true});}
});

test('persistent provider failures enter a slow single-site probe schedule without exhausting site repair budgets', async () => {
  const factory=new Factory();
  try {
    await factory.boot(); factory.catalog=catalog(10);
    factory.runtime.executors=()=>async()=>({ok:false,summary:'模型调用失败',failure:{tag:'model_transport',category:'system',message:'Request timed out.',retryable:true,owner:'system'}});
    factory.batch.configure({target:10,maxInFlight:4,intakeWindow:1}); await factory.runtime.settle();
    for(let i=0;i<3;i++){factory.batch.pump(factory.state.batch!.modelCircuit!.nextAt);await factory.runtime.settle();}
    assert.equal(batchSummary(factory.state)!.admitted,1);
    assert.equal(factory.runtime.tokens.size,4);
    assert.ok(factory.state.batch!.modelCircuit!.nextAt >= Date.now() + 14 * 60 * 1000);
    factory.batch.pump(factory.state.batch!.modelCircuit!.nextAt - 1); await factory.runtime.settle();
    assert.equal(factory.runtime.tokens.size,4,'the fifteen-minute cooldown cannot create more trials early');
    assert.ok(Object.values(factory.state.tokens).every(t=>!t.data.batchRecovery));
    assert.ok(factory.broker.modelHold);
  } finally {await close(factory);fs.rmSync(dir,{recursive:true,force:true});}
});

test('a durable 100-site goal replenishes a bounded pipeline without a chat polling loop', async () => {
  const factory = new Factory();
  try {
    await factory.boot();
    factory.catalog = Array.from({ length: 120 }, (_, i) => ({ id: `site-${i}`, name: `Site ${i}`, canonicalUrl: `https://site-${i}.example/` }));
    let peak = 0;
    factory.runtime.executors = () => async () => {
      peak = Math.max(peak, [...factory.runtime.tokens.values()].filter(t => !t.finished).length);
      return { ok: true, summary: 'fixture publication', finish: { status: 'published', reason: 'fixture' } };
    };
    const control = new FactoryControl(factory);
    await control.execute('run_batch', { action: 'start', target: 100, maxInFlight: 6, intakeWindow: 3 }, 'user');
    await factory.runtime.settle();
    const result = (await control.execute('run_batch', { action: 'status' }, 'user')).result;
    assert.equal(result.target, 100);
    assert.equal(result.admitted, 100, 'a title saying 100 must not stop after the first 20');
    assert.equal(result.completed, 100);
    assert.equal(result.status, 'completed');
    assert.ok(peak <= 6, `in-flight peak ${peak} exceeds window`);
    assert.equal(new Set([...factory.runtime.tokens.values()].map(t => t.item)).size, 100);
  } finally {
    await factory.runtime.close(); factory.docs.flush(); factory.lessons.close(); factory.journal.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pause and process restart retain the total goal, original run and exact remaining admission', async () => {
  let factory = new Factory();
  try {
    await factory.boot(); factory.catalog = catalog(20);
    factory.batch.configure({ target: 9, maxInFlight: 4, intakeWindow: 2 });
    factory.runtime.pause();
    const runId = factory.state.run.id;
    assert.equal(batchSummary(factory.state)?.admitted, 2);
    await close(factory);
    factory = new Factory(); await factory.boot(); factory.catalog = catalog(20);
    assert.equal(factory.state.run.id, runId);
    assert.equal(factory.state.batch?.target, 9);
    assert.equal(batchSummary(factory.state)?.status, 'paused');
    assert.equal(batchSummary(factory.state)?.admitted, 2);
    factory.runtime.executors = () => async () => ({ ok: true, summary: 'fixture', finish: { status: 'published', reason: 'fixture' } });
    factory.batch.setMode('running');
    await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.admitted, 9);
    assert.equal(batchSummary(factory.state)?.completed, 9);
    assert.equal(factory.state.run.id, runId);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('transient failures resume automatically, reuse checkpoints and never count retries as more sites', async () => {
  const factory = new Factory();
  try {
    await factory.boot(); factory.catalog = catalog(10);
    factory.runtime.executors = () => async ctx => ctx.token.data.retryOf
      ? { ok: true, summary: 'fixture', finish: { status: 'published', reason: 'fixture' } }
      : { ok: false, summary: 'fixture connection timeout', failure: { tag: 'network_timeout', category: 'network', message: 'timeout', retryable: true, owner: 'system' } };
    factory.batch.configure({ target: 4, maxInFlight: 4, intakeWindow: 2 });
    await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.retrying, 4);
    assert.equal(batchSummary(factory.state)?.completed, 0);
    factory.batch.pump(Date.now() + 60000);
    await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.admitted, 4);
    assert.equal(batchSummary(factory.state)?.completed, 4);
    assert.equal(factory.runtime.tokens.size, 8);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('persistent failures exhaust a durable retry budget without becoming success or asking for login', async () => {
  const factory = new Factory();
  try {
    await factory.boot(); factory.catalog = catalog(2);
    factory.runtime.executors = () => async () => ({ ok: false, summary: 'timeout', failure: { tag: 'network_timeout', category: 'network', message: 'timeout', retryable: true, owner: 'system' } });
    factory.batch.configure({ target: 2, maxInFlight: 2, intakeWindow: 2 });
    await factory.runtime.settle();
    for (let pass = 0; pass < 4; pass++) { factory.batch.pump(Date.now() + 120000); await factory.runtime.settle(); }
    assert.equal(factory.runtime.tokens.size, 6, 'initial plus exactly two recovery attempts per site');
    assert.equal(batchSummary(factory.state)?.status, 'blocked');
    assert.equal(batchSummary(factory.state)?.completed, 0);
    assert.equal(batchSummary(factory.state)?.blocked, 2);
    assert.deepEqual(Object.values(factory.state.alerts), []);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed page selection goes to the reader with prior failures, not directly to the user', async () => {
  const factory = new Factory();
  try {
    await factory.boot(); factory.catalog = catalog(1);
    const stations: string[] = [];
    factory.runtime.executors = node => async ctx => {
      stations.push(node.key);
      if (ctx.token.data.retryOf) {
        assert.ok(ctx.token.data.repairContext);
        return { ok: true, summary: 'fixture repair', finish: { status: 'published', reason: 'fixture' } };
      }
      return { ok: false, summary: 'no public page selected', failure: { tag: 'needs_selection', category: 'system', message: 'candidate list was insufficient', retryable: true, owner: 'agent' } };
    };
    factory.batch.configure({ target: 1 }); await factory.runtime.settle();
    factory.batch.pump(Date.now() + 60000); await factory.runtime.settle();
    assert.deepEqual(stations, ['candidates/route', 'curation/reader']);
    assert.equal(batchSummary(factory.state)?.completed, 1);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy network login alerts are removed without dropping the failure or incrementing attempts', async () => {
  let factory = new Factory();
  try {
    await factory.boot(); factory.catalog = catalog(1);
    factory.runtime.executors = () => async () => ({ ok: false, summary: 'ECONNRESET', failure: { tag: 'network_connection', category: 'network', message: 'ECONNRESET', retryable: true, owner: 'user' } });
    const [token] = factory.pull(1); await factory.runtime.settle();
    assert.deepEqual(Object.values(factory.state.alerts), [], 'a network failure must not get a login alert even if its old owner is user');
    factory.journal.append({ kind: 'alert.raised', alert: { id: `auth:${token.item}`, kind: 'auth', level: 'red', item: token.item, token: token.id, message: 'legacy wrong login', url: token.url } });
    await close(factory);
    factory = new Factory(); await factory.boot();
    assert.deepEqual(Object.values(factory.state.alerts), []);
    assert.equal(factory.state.recoveries[token.item].failure?.tag, 'network_connection');
    assert.equal(factory.state.recoveries[token.item].failure?.owner, 'system');
    assert.equal(factory.state.recoveries[token.item].attempts, 1);
    assert.ok([...factory.journal.read()].some(event => event.kind === 'alert.cleared'));
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('desktop restart resumes an explicitly managed running goal, while a ended run cannot be resumed', async () => {
  let factory = new Factory();
  const saved = { FACTORY_START_PAUSED: process.env.FACTORY_START_PAUSED, FACTORY_RESUME_MANAGED: process.env.FACTORY_RESUME_MANAGED };
  try {
    await factory.boot();
    factory.batch.configure({ target: 4, maxInFlight: 3, intakeWindow: 2 });
    const run = factory.state.run.id;
    await close(factory);
    process.env.FACTORY_START_PAUSED = '1'; process.env.FACTORY_RESUME_MANAGED = '1';
    factory = new Factory(); await factory.boot();
    assert.equal(factory.runtime.paused, false);
    assert.equal(factory.state.run.id, run);
    factory.catalog = catalog(4);
    factory.runtime.executors = () => async () => ({ ok: true, summary: 'fixture', finish: { status: 'published', reason: 'fixture' } });
    factory.batch.pump(); await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.completed, 4);
    factory.runtime.end();
    assert.throws(() => factory.batch.setMode('running'), /本轮已经结束/);
  } finally {
    await close(factory); fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('late review recovery gets the available slot before another early reading attempt', async () => {
  const factory = new Factory();
  try {
    await factory.boot(); factory.runtime.start('prioritize completed evidence');
    factory.runtime.executors = () => async () => ({ ok: false, summary: 'timeout', failure: { tag: 'network_timeout', category: 'network', message: 'timeout', retryable: true, owner: 'system' } });
    for (const [item, node] of [['early', 'curation/reader'], ['late', 'curation/copy-review']]) factory.runtime.create(node, { item, url: `https://${item}.example/`, source: 'manual', data: { canonical: `https://${item}.example/` } });
    await factory.runtime.settle();
    const resumed: string[] = [];
    factory.runtime.executors = node => async () => { resumed.push(node.key); return { ok: true, summary: 'fixture', finish: { status: 'published', reason: 'fixture' } }; };
    factory.batch.configure({ target: 2, maxInFlight: 1, intakeWindow: 1 });
    factory.batch.pump(Date.now() + 60000); await factory.runtime.settle();
    assert.deepEqual(resumed, ['curation/copy-review']);
    assert.equal(batchSummary(factory.state)?.admitted, 2);
    assert.equal(batchSummary(factory.state)?.completed, 1);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('single-slot managed admission alternates durable sources and catalog across restart', async () => {
  let factory = new Factory();
  const order: string[] = [];
  let peak = 0;
  const execute = () => {
    factory.runtime.executors = () => async ctx => {
      order.push(ctx.token.source.startsWith('source:') ? 'source' : 'catalog');
      peak = Math.max(peak, [...factory.runtime.tokens.values()].filter(token => !token.finished).length);
      return {ok: true, summary: 'Fixture publication', finish: {status: 'published', reason: 'fixture'}};
    };
  };
  try {
    await factory.boot();
    await factory.sources.close();
    factory.sources = new SourceSupervisor(factory);
    factory.sources.configure({
      id: 'fresh', name: 'Fresh source', url: 'https://feed.fixture.test/items',
      platform: 'fixture', format: 'json', target: 'candidates/tidy',
      intervalMs: 86400000, enabled: true,
    });
    factory.journal.append({kind: 'source.polled', source: 'fresh', nextAt: Date.now() + 86400000, count: 0, duplicates: 0});
    for (let i = 0; i < 4; i++) {
      factory.journal.append({kind: 'source.candidate', candidate: {
        id: `fresh-${i}`, source: 'fresh', platform: 'fixture', sourceUrl: 'https://feed.fixture.test/items',
        url: `https://fresh-${i}.fixture.test/`, title: `Fresh ${i}`, discoveredAt: Date.now(), status: 'pending',
      }});
    }
    factory.catalog = catalog(12);
    execute();
    const unsubscribe = factory.journal.subscribe(event => {
      if (event.kind === 'token.finished' && order.length === 1) factory.runtime.pause();
    });
    factory.batch.configure({target: 6, maxInFlight: 1, intakeWindow: 1});
    await factory.runtime.settle();
    assert.deepEqual(order, ['source'], 'an already queued source must get a real admission');
    unsubscribe();
    await close(factory);
    factory = new Factory();
    await factory.boot();
    factory.catalog = catalog(12);
    execute();
    assert.equal(factory.runtime.paused, true);
    factory.runtime.resume();
    await factory.runtime.settle();
    assert.deepEqual(order, ['source', 'catalog', 'source', 'catalog', 'source', 'catalog']);
    assert.equal(peak, 1);
    assert.equal(batchSummary(factory.state)?.admitted, 6);
    assert.equal(batchSummary(factory.state)?.completed, 6);
    assert.equal(factory.sources.list()[0].counts.pending, 1, 'the target remains a hard bound');
  } finally {
    await close(factory);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('managed feeder rotation preserves filters, disabled sources, intake limits and empty-side fallback', async () => {
  for (const scenario of ['category', 'query', 'disabled', 'source-only', 'local-pause'] as const) {
    const factory = new Factory();
    const origins: string[] = [];
    let peak = 0;
    try {
      await factory.boot();
      await factory.sources.close();
      factory.sources = new SourceSupervisor(factory);
      factory.sources.configure({
        id: 'fresh', name: 'Fresh source', url: 'https://feed.fixture.test/items',
        platform: 'fixture', format: 'json', target: 'candidates/tidy',
        intervalMs: 86400000, enabled: scenario !== 'disabled',
      });
      for (let i = 0; i < 3; i++) factory.journal.append({kind: 'source.candidate', candidate: {
        id: `fresh-${i}`, source: 'fresh', platform: 'fixture', sourceUrl: 'https://feed.fixture.test/items',
        url: `https://fresh-${i}.fixture.test/`, title: `Fresh ${i}`, discoveredAt: Date.now(), status: 'pending',
      }});
      factory.catalog = scenario === 'source-only' ? [] : catalog(6).map(entry => ({...entry, category: 'fixture', name: 'Wanted ' + entry.id}));
      factory.runtime.executors = () => async ctx => {
        origins.push(ctx.token.source.startsWith('source:') ? 'source' : 'catalog');
        peak = Math.max(peak, [...factory.runtime.tokens.values()].filter(token => !token.finished).length);
        return {ok: true, summary: 'Fixture publication', finish: {status: 'published', reason: 'fixture'}};
      };
      if (scenario === 'local-pause') factory.runtime.setScopePaused({scope: 'line', key: 'candidates', paused: true, reason: 'Fixture pause'});
      factory.batch.configure({target: 2, maxInFlight: 3, intakeWindow: 1,
        ...(scenario === 'category' ? {category: 'fixture'} : {}),
        ...(scenario === 'query' ? {query: 'Wanted'} : {}),
      });
      await factory.runtime.settle();
      if (scenario === 'local-pause') {
        assert.equal(Object.keys(factory.state.tokens).length, 0, 'both feeders honor the paused entry line');
        factory.runtime.setScopePaused({scope: 'line', key: 'candidates', paused: false, reason: 'Fixture resumes'});
        await new Promise<void>(resolve => setImmediate(resolve));
        await factory.runtime.settle();
      }
      assert.deepEqual(origins, scenario === 'source-only' ? ['source', 'source']
        : scenario === 'local-pause' ? ['source', 'catalog'] : ['catalog', 'catalog'], scenario);
      assert.equal(peak, 1, 'intakeWindow remains binding even when maxInFlight is larger');
      assert.equal(batchSummary(factory.state)?.admitted, 2);
      assert.equal(batchSummary(factory.state)?.completed, 2);
      assert.equal(Boolean(batchSummary(factory.state)?.supplyExhausted), false, 'successful source intake is available supply even if the catalog is empty');
      if (scenario === 'disabled') assert.equal(factory.sources.list()[0].enabled, false);
    } finally {
      await close(factory);
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }
});
