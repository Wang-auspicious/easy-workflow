import { setTimeout as delay } from "node:timers/promises";
import { Runtime } from "../../server/runtime.ts";
import { openPage, closeBrowser } from "../../server/browser.ts";
import { Broker } from "../../server/broker.ts";
import { Journal } from "../../server/journal.ts";
import { compile } from "../../server/spec/compile.ts";
import { pack } from "../../packs/vislexicon/pack.ts";
import { initialState, apply } from "../../shared/project.ts";

const compiled = compile([pack]), journal = new Journal(":memory:"), state = initialState(compiled);
journal.subscribe(event => apply(state, event));
let calls = 0;
const runtime = new Runtime(compiled, journal, new Broker({ browser: 3 }, 0), pack.conditions, () => async ctx => {
  calls++;
  const page = await openPage(undefined, undefined, ctx.signal);
  await page.close();
  return { ok: true, summary: "unexpected successful bridge" };
});
runtime.ensureWorkers([]); runtime.start("lost desktop bridge");
const token = runtime.create("curation/identity", { item: "bridge", url: "https://fixture.test", source: "manual" });
try {
  for (let i = 0; i < 500 && !token.finished; i++) await delay(10);
  if (!token.finished) throw new Error("desktop bridge recovery did not settle");
  console.log(JSON.stringify({ calls, status: state.tokens[token.id].status, failed: state.nodes["curation/identity"].failed, failure: token.data.failure }));
} finally { await runtime.close(); await closeBrowser(); journal.close(); }
