import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { configureAgentStations, pickByImages, runAgentStation } from "../server/agent-station.ts";
import { EvidenceStore, type ImageProcessOptions } from '../server/evidence.ts';
import { models, closeModelTransport } from "../server/pi.ts";
import type { Docs } from "../server/docs.ts";
import type { Toolbox } from "../server/toolbox.ts";
import type { StationContext } from "../server/runtime.ts";

test("station clocks: real Pi requests and tools may outlive the old whole-loop timeout", { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-station-clocks-"));
  const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "FACTORY_MODEL", "FACTORY_PROVIDER", "FACTORY_STATION_COMMAND", "FACTORY_STATION_MODEL"].map(k => [k, process.env[k]]));
  process.env.PI_CODING_AGENT_DIR = dir;
  for (const key of ["FACTORY_MODEL", "FACTORY_PROVIDER", "FACTORY_STATION_COMMAND", "FACTORY_STATION_MODEL"]) delete process.env[key];
  const scenarios = new Map<string, { requests: any[]; tools: number; progress: string[]; hold?: number; socket?: number; toolCompleted?: boolean }>();
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const name = JSON.stringify(body).match(/clock-case:([a-z-]+)/)?.[1];
    const current = name ? scenarios.get(name) : undefined;
    const index = current ? current.requests.push(body) : 0;
    if (current?.hold === index || (name === 'tool-persist' && [2,3].includes(index))) return;
    res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
    if (current?.socket === index) { res.write(`data: ${JSON.stringify({ id: "clock", choices: [{ index: 0, delta: { role: "assistant", content: "partial before connection failure" }, finish_reason: null }] })}\n\n`); setTimeout(() => res.destroy(), 25); return; }
    if (current) await delay(400);
    const toolCase = name?.startsWith("tool-");
    const call = toolCase && index === 1 ? { name: "env_call", arguments: '{"name":"context_read","arguments":{}}' }
      : !toolCase && index > 0 && index < 4 ? { name: "env_help", arguments: "{}" } : { name: "submit", arguments: '{"value":7}' };
    for (const part of [
      { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `clock-${name}-${index}`, type: "function", function: call }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
    ]) res.write(`data: ${JSON.stringify({ id: "clock", object: "chat.completion.chunk", created: 1, model: "clock-model", ...part })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultProvider: "clock-fixture", defaultModel: "clock-model" }));
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "clock-fixture": { type: "api_key", key: "local-clock-secret" } }));
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { "clock-fixture": { api: "openai-completions", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, models: [{ id: "clock-model", input: ["text"] }] } } }));
  const docs = { dir, envelope: () => ({ text: "station clock fixture", sizes: { role: 0, context: 0, caseFile: 0 } }) } as unknown as Docs;
  let active = "";
  const toolbox = {
    help: () => { scenarios.get(active)!.tools++; return { ok: true, receipt: `observed-${scenarios.get(active)!.tools}` }; },
    call: async (_allowed: string[], _name: string, _args: unknown, ctx: { signal: AbortSignal }) => {
      const current = scenarios.get(active)!; current.tools++;
      await delay(1400, undefined, { signal: ctx.signal });
      current.toolCompleted = true; return { ok: true, receipt: "long-tool-completed" };
    },
  } as unknown as Toolbox;
  configureAgentStations({ docs: () => docs, toolbox: () => toolbox });
  const run = (name: string, signal = new AbortController().signal, extra = {}, tokenData = {}) => {
    active = name;
    const current = scenarios.get(name)!;
    const ctx = { node: { key: "curation/copy-review" }, token: { id: `t-${name}`, item: name, data:tokenData }, worker: { id: `w-${name}` }, attempt: `a-${name}`, signal, progress: (message: string) => current.progress.push(message) } as unknown as StationContext;
    return runAgentStation<{ value: number }>({ system: "Read the local fixture and submit.", schema: Type.Object({ value: Type.Number() }),
      input: () => ({ text: `clock-case:${name}` }), after: value => ({ ok: true, summary: "submitted", data: value }), ...extra }, ctx);
  };
  try {
    // Warm the real provider SDK before scaling the application clocks. The
    // network, Pi tool loop and 400ms response delays all remain real.
    const selection = models();
    await (await selection.stream(selection.model, normalizeContext({ messages: [{ role: "user", content: "warmup", timestamp: Date.now() }] }))).result();
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, "timeout", (ms: number) => originalTimeout(ms >= 120_000 ? Math.ceil(ms / 100) : ms));
    await t.test("four individually healthy 400ms requests complete past the scaled old 1200ms whole-loop cutoff", async () => {
      const current = { requests: [] as any[], tools: 0, progress: [] as string[] }; scenarios.set("healthy", current);
      const result = await run("healthy");
      assert.equal(result.ok, true, result.error ?? "healthy multi-turn station was discarded");
      assert.equal(current.requests.length, 4); assert.equal(current.tools, 3);
      assert.equal(result.metrics?.time?.modelCalls, 4);
      const requests = result.metrics!.activity!.spans.filter(span => span.kind === "model_request");
      assert.ok(requests.every(span => span.endedAt! - span.startedAt < 1200));
      assert.ok(requests.at(-1)!.endedAt! - requests[0]!.startedAt > 1200, "the work really exceeds the old whole-station cutoff");
    });
    await t.test("a timed-out request continues from completed tool receipts with a fresh request clock", async () => {
      const current = { requests: [] as any[], tools: 0, progress: [] as string[], hold: 2 }; scenarios.set("timeout", current);
      const result = await run("timeout");
      assert.equal(result.ok, true, result.error ?? "request timeout did not recover");
      assert.equal(current.requests.length, 4); assert.equal(current.tools, 2);
      const continuation = current.requests[2].messages;
      assert.equal(continuation.at(-1).role, "tool"); assert.ok(JSON.stringify(continuation).includes("observed-1"));
      assert.equal(continuation.filter((m: any) => m.role === "user").length, 1);
      assert.ok(current.progress.some(p => p.includes("保留已完成的工具结果")));
    });
    await t.test('provider recovery resumes the saved tool receipt across station attempts', async () => {
      const current={requests:[] as any[],tools:0,progress:[] as string[]}; scenarios.set('tool-persist',current);
      const failed=await run('tool-persist');
      assert.equal(failed.ok,false); assert.equal(failed.failure?.tag,'model_transport');
      assert.ok(failed.data?.stationSessions);
      assert.equal(current.tools,1);
      const recovered=await run('tool-persist',new AbortController().signal,{},failed.data);
      assert.equal(recovered.ok,true,recovered.error ?? 'checkpoint recovery failed');
      assert.equal(current.tools,1,'a provider disconnect must not repeat a completed page read');
      assert.match(JSON.stringify(current.requests.at(-1)),/long-tool-completed/);
      assert.deepEqual(recovered.data?.stationSessions,{});
    });
    await t.test("an explicit work deadline stays absolute and is never extended for recovery", async () => {
      const current = { requests: [] as any[], tools: 0, progress: [] as string[], hold: 1 }; scenarios.set("work-limit", current);
      const began = Date.now(), result = await run("work-limit", new AbortController().signal, { timeoutMs: 100 });
      assert.equal(result.ok, false); assert.equal(current.requests.length, 1);
      assert.ok(Date.now() - began < 1000);
    });
    await t.test("a tool longer than one request budget completes without the old request timer cancelling it", async () => {
      const current = { requests: [] as any[], tools: 0, progress: [] as string[], toolCompleted: false }; scenarios.set("tool-long", current);
      const result = await run("tool-long");
      assert.equal(result.ok, true, result.error ?? "long tool was incorrectly cancelled by a model request clock");
      assert.equal(current.requests.length, 2); assert.equal(current.tools, 1); assert.equal(current.toolCompleted, true);
      assert.ok(result.metrics!.time!.toolMs! >= 1200);
      assert.equal(current.progress.some(message => message.includes("1 秒后续答")), false);
    });
    await t.test("the absolute work deadline still aborts a running tool and prevents submission", async () => {
      const current = { requests: [] as any[], tools: 0, progress: [] as string[], toolCompleted: false }; scenarios.set("tool-deadline", current);
      const began = Date.now(), result = await run("tool-deadline", new AbortController().signal, { timeoutMs: 600 });
      assert.equal(result.ok, false); assert.equal(result.summary, "工位工作预算已用完");
      assert.equal(current.requests.length, 1); assert.equal(current.tools, 1); assert.equal(current.toolCompleted, false);
      assert.ok(Date.now() - began < 1300);
      assert.ok(result.metrics?.activity?.spans.some(span => span.kind === "tool" && span.status === "cancelled"));
    });
    await t.test("an already-aborted owner signal cannot be replaced by a fresh request clock", async () => {
      const current = { requests: [] as any[], tools: 0, progress: [] as string[] }; scenarios.set("cancelled", current);
      const ctrl = new AbortController(); ctrl.abort();
      await assert.rejects(run("cancelled", ctrl.signal), { name: "AbortError" });
      assert.equal(current.requests.length, 0); assert.equal(current.tools, 0);
    });
    await t.test('image preparation forwards cancellation before either Pi input path can charge a request', async () => {
      const image = path.join(dir, 'input.ppm');
      fs.writeFileSync(image, Buffer.concat([Buffer.from('P6\n4 6\n255\n'), Buffer.alloc(4 * 6 * 3, 128)]));
      for (const picker of [false, true]) {
        const current = { requests: [] as any[], tools: 0, progress: [] as string[] }; scenarios.set('image-cancel', current);
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const convert = t.mock.method(EvidenceStore, 'jpegAsync', async (_file: string, _width?: number, options?: ImageProcessOptions) => {
          assert.ok(options?.signal); entered();
          await delay(10000, undefined, { signal: options.signal });
          return Buffer.alloc(0);
        });
        try {
          const controller = new AbortController();
          const images = [{ file: image, label: 'image input' }];
          const pending = picker
            ? pickByImages({ node: { key: 'curation/copy-review' }, signal: controller.signal } as StationContext, 'Choose image', images)
            : run('image-cancel', controller.signal, { input: () => ({ text: 'clock-case:image-cancel', images }) });
          const rejected = assert.rejects(pending, { name: 'AbortError' });
          await started; controller.abort(); await rejected;
          assert.equal(current.requests.length, 0); assert.equal(current.tools, 0);
        } finally { convert.mock.restore(); }
      }
    });
    await t.test('local codec timeouts do not open the model provider circuit', async () => {
      const image = path.join(dir, 'input.ppm');
      const current = { requests: [] as any[], tools: 0, progress: [] as string[] }; scenarios.set('image-timeout', current);
      const convert = t.mock.method(EvidenceStore, 'jpegAsync', async () => {
        throw Object.assign(new Error('Image conversion timed out'), { name: 'TimeoutError', code: 'FFMPEG_TIMEOUT' });
      });
      try {
        const result = await run('image-timeout', new AbortController().signal, { input: () => ({ text: 'clock-case:image-timeout', images: [{ file: image, label: 'image input' }] }) });
        assert.equal(result.failure?.tag, 'tool_error'); assert.equal(result.failure?.category, 'system');
        assert.equal(result.failure?.code, 'FFMPEG_TIMEOUT'); assert.equal(current.requests.length, 0);
        assert.equal(result.metrics?.execution?.model, 'unreported', 'image preparation is not a real model response');
      } finally { convert.mock.restore(); }
    });
  } finally {
    t.mock.restoreAll(); await closeModelTransport(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith("easy-workflow-station-clocks-")); fs.rmSync(dir, { recursive: true, force: true });
  }
});
