import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Broker } from "../server/broker.ts";

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
