import assert from "node:assert/strict";
import test from "node:test";
import { FactoryControl } from "../server/control.ts";
import type { Factory } from "../server/factory.ts";
import { apply, initialState } from "../shared/project.ts";
import type { JournalEvent, Stamped } from "../shared/types.ts";

function fixture() {
  const state = initialState(); let seq = 0;
  const record = (event: JournalEvent, at: number) => apply(state, { ...event, seq: ++seq, at, run: event.kind === "run.started" ? event.runId : state.run.id } as Stamped);
  const create = (id: string, item: string, at: number, host = "same.example") => {
    record({ kind: "token.created", token: id, line: "curation", item, title: id, url: `https://${host}`, source: "fixture" }, at);
    record({ kind: "token.data", token: id, patch: { host, marker: id } }, at);
  };
  const control = new FactoryControl({ state, compiled: { nodes: [] }, journal: { get seq() { return seq; }, append: () => { throw new Error("inspection must not mutate the journal"); } },
    docs: { renderCase: (item: string) => `case for ${item}`, caseFile: (item: string) => `cases/${item}/CASE.md` } } as unknown as Factory);
  return { state, record, create, control,
    inspect: async (token: string) => (await control.execute("inspect", { token })).result,
    readCase: async (item: string) => (await control.execute("read_case", { item })).result };
}

test("inspect resolves a four-token retry chain to its current leaf while an explicit ID keeps historical evidence", async () => {
  const f = fixture();
  f.record({ kind: "run.started", runId: "run-current", title: "current" }, 100);
  for (let i = 0; i < 4; i++) {
    f.create(`t-${i}`, "plasmic-entry", 110 + i * 10, "plasmic.app");
    if (i > 0) {
      f.record({ kind: "token.data", token: `t-${i - 1}`, patch: { retriedBy: `t-${i}` } }, 110 + i * 10);
      f.record({ kind: "token.data", token: `t-${i}`, patch: { retryOf: `t-${i - 1}` } }, 110 + i * 10);
    }
    if (i < 3) f.record({ kind: "token.finished", token: `t-${i}`, node: "curation/copy-review", status: "parked", reason: "old model timeout" }, 111 + i * 10);
  }
  // A later event on a superseded token must not let the old failure win.
  f.record({ kind: "token.queued", token: "t-0", node: "curation/copy-review" }, 200);
  assert.equal((await f.inspect("plasmic-entry")).id, "t-3");
  assert.equal((await f.inspect("plasmic.app")).id, "t-3");
  const historical = await f.inspect("t-0");
  assert.equal(historical.id, "t-0"); assert.equal(historical.status, "parked");
  assert.equal(historical.data.marker, "t-0");
});

test("host lookup and read_case prefer the current run, then fall back to latest historical work when absent", async () => {
  const f = fixture();
  f.record({ kind: "run.started", runId: "run-old", title: "old" }, 10);
  f.create("old-1", "old-entry", 20); f.create("old-2", "old-entry", 30);
  f.record({ kind: "run.started", runId: "run-new", title: "new" }, 100);
  f.create("new", "current-entry", 110);
  assert.equal((await f.inspect("same.example")).id, "new");
  const current = await f.readCase("same.example");
  assert.equal(current.item, "current-entry"); assert.equal(current.markdown, "case for current-entry");
  assert.equal((await f.inspect("old-entry")).id, "old-2");
  assert.equal((await f.readCase("old-1")).item, "old-entry");
});

test("equal timestamps use journal tokenOrder, never the tokens object insertion order", async () => {
  const f = fixture(); f.record({ kind: "run.started", runId: "run-ties", title: "ties" }, 100);
  f.create("z-first", "same-entry", 110); f.create("a-later", "same-entry", 110);
  assert.equal((await f.inspect("same-entry")).id, "a-later");
  f.state.tokens = Object.fromEntries(Object.entries(f.state.tokens).reverse());
  assert.equal((await f.inspect("same.example")).id, "a-later");
});

test("an older token resumed in this run follows the same touchedAt rule as current-run totals", async () => {
  const f = fixture(); f.create("older-resumed", "resumed-entry", 20);
  f.record({ kind: "run.started", runId: "run-resumed", title: "resumed" }, 100);
  f.create("newer-created", "resumed-entry", 110);
  f.record({ kind: "token.queued", token: "older-resumed", node: "curation/reader" }, 120);
  assert.equal((await f.inspect("resumed-entry")).id, "older-resumed");
});

test("exact token IDs beat item or host collisions in both read tools", async () => {
  const f = fixture(); f.record({ kind: "run.started", runId: "run-exact", title: "exact" }, 100);
  f.create("first", "exact-id", 110, "exact-id");
  f.create("exact-id", "historical-target", 120, "different.example");
  assert.equal((await f.inspect("exact-id")).item, "historical-target");
  assert.equal((await f.readCase("exact-id")).item, "historical-target");
});

test("retry pointers only supersede a token when they name a real token for the same item", async () => {
  const f = fixture(); f.record({ kind: "run.started", runId: "run-links", title: "links" }, 100);
  f.create("kept", "first-entry", 110); f.create("other", "other-entry", 120, "other.example");
  f.record({ kind: "token.data", token: "kept", patch: { retriedBy: "other" } }, 130);
  assert.equal((await f.inspect("first-entry")).id, "kept");
  f.record({ kind: "token.data", token: "kept", patch: { retriedBy: "missing" } }, 131);
  assert.equal((await f.inspect("first-entry")).id, "kept");
  await assert.rejects(f.inspect("missing-item"), (error: any) => error.code === "token_not_found");
  await assert.rejects(f.readCase("missing-item"), (error: any) => error.code === "case_not_found");
});

test("an exact item key takes precedence over a different entry's matching host", async () => {
  const f = fixture(); f.record({ kind: "run.started", runId: "run-items", title: "items" }, 100);
  f.create("host-match", "different-entry", 130, "entry-key");
  f.create("item-match", "entry-key", 120, "other.example");
  assert.equal((await f.inspect("entry-key")).id, "item-match");
  assert.equal((await f.readCase("entry-key")).item, "entry-key");
});

test("a host on a retry ancestor still resolves the current item before its latest host metadata is populated", async () => {
  const f = fixture(); f.record({ kind: "run.started", runId: "run-host", title: "host" }, 100);
  f.create("original", "same-entry", 110, "known.example");
  f.record({ kind: "token.created", token: "retry", line: "curation", item: "same-entry", url: "https://known.example", source: "fixture" }, 120);
  f.record({ kind: "token.data", token: "original", patch: { retriedBy: "retry" } }, 121);
  assert.equal((await f.inspect("known.example")).id, "retry");
});
