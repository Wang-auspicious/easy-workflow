import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Broker } from "../server/broker.ts";
import {MemoryMonitor, type MemorySnapshot} from '../server/memory.ts';

test("broker wakes queued callers before admitting new work, without taking extra capacity", async () => {
  const broker = new Broker({ browser: 1 }, 0), first = broker.tryAcquire("browser")!;
  const queued = broker.acquire("browser", { timeoutMs: 1000 });
  let extra = false;
  broker.onRelease = () => { const lease = broker.tryAcquire("browser"); extra ||= Boolean(lease); lease?.release(); };
  first.release();
  const next = await queued;
  assert.ok(next); assert.equal(extra, false); assert.equal(broker.used.browser, 1);
  broker.onRelease = () => {}; next.release(); next.release(); assert.equal(broker.used.browser, 0);
});

test("broker cancellation is immediate and neither aborted nor timed-out callers consume future slots", async () => {
  const broker = new Broker({ browser: 1 }, 0), first = broker.tryAcquire("browser")!, ctrl = new AbortController();
  const cancelled = broker.acquire("browser", { signal: ctrl.signal, timeoutMs: 10000 });
  ctrl.abort(new Error("cancel wait"));
  await assert.rejects(cancelled, /cancel wait/);
  assert.equal(await broker.acquire("browser", { timeoutMs: 20 }), null);
  first.release(); await delay(30); assert.equal(broker.used.browser, 0);
  await assert.rejects(broker.acquire("browser", { signal: ctrl.signal }), /cancel wait/);
  assert.equal(broker.used.browser, 0, "already-cancelled callers never claim a free slot");
});

test("broker notices memory recovery even when no existing lease is released", async () => {
  const broker = new Broker({ browser: 2 }, 1024); let memory = 900;
  broker.freeMem = () => memory;
  const queued = broker.acquire("browser", { timeoutMs: 1000 });
  memory = 2048;
  const lease = await queued;
  assert.ok(lease); assert.equal(broker.used.browser, 1); lease.release();
});

test('broker admits one page under physical pressure only with verified commit headroom', () => {
  const broker = new Broker({browser: 8, http: 4, model: 3}, 1024);
  broker.memorySnapshot = () => ({
    physicalTotalMB: 16108, physicalAvailableMB: 900,
    commitLimitMB: 36199, commitAvailableMB: 6883,
    source: 'windows-performance', checkedAt: Date.now(),
  });
  assert.equal(broker.freeMemMB(), 900);
  assert.equal(broker.effectiveBrowser(), 1, 'paging space does not become eight RAM-backed pages');
  const page = broker.tryAcquire('browser');
  assert.ok(page, 'healthy commit capacity must avoid the old blanket physical-floor rejection');
  assert.equal(broker.tryAcquire('browser'), null, 'physical pressure permits only one page');
  page.release();
  broker.memorySnapshot = () => ({
    physicalTotalMB: 16108, physicalAvailableMB: 420,
    commitLimitMB: 36199, commitAvailableMB: 20000,
    source: 'windows-performance', checkedAt: Date.now(),
  });
  assert.equal(broker.tryAcquire('browser'), null, 'commit capacity cannot override physical emergency');
  broker.memoryFloorMB = 0;
  assert.equal(broker.tryAcquire('browser'), null, 'configuring a zero ordinary floor never removes physical emergency protection');
  assert.ok(broker.tryAcquire('http'), 'browser pressure must not prevent HTTP work');
  assert.ok(broker.tryAcquire('model'), 'browser pressure must not prevent remote model work');
});

test('broker refuses new pages when commit is exhausted or the pressure snapshot is stale', () => {
  const broker = new Broker({browser: 8}, 1024);
  broker.memorySnapshot = () => ({
    physicalTotalMB: 16108, physicalAvailableMB: 2717,
    commitLimitMB: 36199, commitAvailableMB: 600,
    source: 'windows-performance', checkedAt: Date.now(),
  });
  assert.equal(broker.tryAcquire('browser'), null, 'free RAM is insufficient when commit is exhausted');
  broker.memorySnapshot = () => ({
    physicalTotalMB: 16108, physicalAvailableMB: 900,
    commitLimitMB: 36199, commitAvailableMB: 6883,
    source: 'windows-performance', checkedAt: Date.now() - 60000,
  });
  assert.equal(broker.tryAcquire('browser'), null, 'old commit measurements cannot authorize pressure mode');
});

test('system memory collection coalesces asynchronous queries and expires stale commit without masking RAM pressure', async () => {
  let clock = 1000;
  let physicalAvailableMB = 900;
  let queries = 0;
  let resolveQuery!: (value: MemorySnapshot) => void;
  const physical = (): MemorySnapshot => ({
    physicalTotalMB: 16108, physicalAvailableMB,
    commitLimitMB: null, commitAvailableMB: null,
    source: 'physical-only', checkedAt: clock,
  });
  const monitor = new MemoryMonitor(() => {
    queries++;
    return new Promise(resolve => {resolveQuery = resolve;});
  }, physical, () => clock);
  const first = monitor.refresh();
  assert.equal(monitor.refresh(), first, 'concurrent requests share one query');
  assert.equal(monitor.snapshot().commitAvailableMB, null, 'an unfinished query grants no commit budget');
  let ticked = false;
  await delay(0).then(() => {ticked = true;});
  assert.equal(ticked, true, 'browser callbacks can progress while the inventory is pending');
  resolveQuery({...physical(), commitLimitMB: 36199, commitAvailableMB: 6883,
    source: 'windows-performance'});
  await first;
  assert.equal(queries, 1);
  assert.equal(monitor.snapshot().commitAvailableMB, 6883);
  physicalAvailableMB = 420;
  assert.equal(monitor.snapshot().physicalAvailableMB, 420, 'cached commit does not hide a live RAM emergency');
  clock += 16000;
  assert.equal(monitor.snapshot().commitAvailableMB, null, 'expired commit is unknown until refreshed');
  assert.equal(queries, 2);
  resolveQuery({...physical(), commitLimitMB: 36199, commitAvailableMB: 6000,
    source: 'windows-performance'});
  await monitor.refresh();
  assert.equal(monitor.snapshot().commitAvailableMB, 6000);
});
