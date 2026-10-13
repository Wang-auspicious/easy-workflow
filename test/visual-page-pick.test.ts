import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { StationContext } from "../server/runtime.ts";
import type { EvidenceStore } from "../server/evidence.ts";

// The first pure-contract test also imports capture -> browser. Configure the
// project before that import, not only before the later browser test.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-visual-pick-'));
const previousProject = process.env.FACTORY_VAR;
process.env.FACTORY_VAR = root;
after(async () => {
  const { closeBrowser } = await import('../server/browser.ts');
  const { closeNetwork } = await import('../server/network.ts');
  await closeBrowser(); await closeNetwork();
  if (previousProject === undefined) delete process.env.FACTORY_VAR; else process.env.FACTORY_VAR = previousProject;
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('easy-workflow-visual-pick-'));
  fs.rmSync(root, { recursive: true, force: true });
});

const pass = { perImage: [], verdict: "pass" as const, reason: "all visible" };
const hidden = { subjectVisible: false, mixed: false, styles: [], signatureZh: "" };
const ctx = (data: Record<string, unknown>) => ({ token: { data }, attempt: "fixture", addEvidence: () => ({}) }) as unknown as StationContext;

test("a catalogue confirmed by eye is not vetoed by the element count", async () => {
  const { breadthPreviewIssues } = await import("../packs/vislexicon/capture.ts");
  const { shotReview, style } = await import("../packs/vislexicon/agents.ts");
  for (const basis of ["rendered-items", "name-list", "owner-choice"] as const) assert.deepEqual(breadthPreviewIssues("component-source", 0, { basis }), [], basis);
  assert.ok(breadthPreviewIssues("component-source", 0).length, "without a visual comparison the count still decides");
  assert.ok(breadthPreviewIssues("component-source", 2, { basis: "unknown" as never }).length);

  const review = shotReview({} as EvidenceStore);
  const names = { kind: "component-source", shots: { breadth: { href: "https://fixture.test/docs/components", previews: 0, visual: { basis: "name-list", reason: "列出 150 个组件名", compared: 6 } } } };
  assert.equal((await review.after!(pass, ctx(names), { rounds: 1 } as never)).verdict?.verdict, "pass");
  const text = (await review.input(ctx({ ...names, title: "Fixture", canonical: "https://fixture.test", images: [] }))).text;
  assert.match(text, /no preview wall|none renders/, "the reviewer is told how the catalogue was chosen");

  const fixed = await style({} as EvidenceStore).after!(hidden, ctx(names), { rounds: 1 } as never);
  assert.deepEqual(fixed.verdict?.fixes?.map((f) => f.station), ["curation/proof"], "a names catalogue is not re-shot for missing previews");
});

test("the catalogue page is chosen by comparing screenshots, including pages the count calls empty", { timeout: 120000 }, async (t) => {
  const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "FACTORY_MODEL", "FACTORY_PROVIDER", "FACTORY_STATION_COMMAND", "FACTORY_STATION_MODEL"].map((k) => [k, process.env[k]]));
  process.env.PI_CODING_AGENT_DIR = root;
  for (const key of ["FACTORY_MODEL", "FACTORY_PROVIDER", "FACTORY_STATION_COMMAND", "FACTORY_STATION_MODEL"]) delete process.env[key];
  const nav = '<nav><a href="/docs/components">Components</a> <a href="/showcase">Showcase</a> <a href="/gallery">Gallery</a></nav>';
  const page = (body: string) => `<!doctype html><style>body{margin:0;font:16px sans-serif}nav{height:48px}.fx{display:inline-block;width:260px;height:180px;margin:12px;border-radius:16px;background:linear-gradient(135deg,#7c3aed,#06b6d4)}.site{display:block;width:1100px;height:600px;margin:10px;background:#ddd}</style>${nav}<main>${body}</main>`;
  const pages: Record<string, string> = {
    "/": page('<h1 style="font-size:96px">Fixture UI</h1><p>Animated components for landing pages.</p>'),
    "/docs/components": page(`<h1>Components</h1><ul>${Array.from({ length: 60 }, (_, i) => `<li><a href="/docs/components/c${i}">Component ${i}</a></li>`).join("")}</ul>`),
    "/showcase": page(`<h1>Showcase</h1><p>Companies building with Fixture UI</p>${["acme.com", "globex.io"].map((name) => `<section class="site" style="background:#f4f4f5;padding:24px;box-sizing:border-box"><h2 style="font-size:48px">${name}</h2><p style="font-size:22px">A customer landing page made with Fixture UI.</p><div style="display:flex;gap:16px">${'<div style="width:240px;height:160px;background:#1f2937"></div>'.repeat(3)}</div></section>`).join("")}`),
    // Pure CSS effects: a person sees eight components, the element counter sees none.
    "/gallery": page(`<h1>Gallery</h1>${Array.from({ length: 8 }, () => '<div class="fx"></div>').join("")}`),
  };
  const fixture = http.createServer((req, res) => {
    const body = pages[(req.url ?? "/").split("?")[0]];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html" }); res.end(body ?? "<h1>404 not found</h1>");
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const site = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;

  let answer: "gallery" | "none" = "gallery";
  const requests: { labels: string[]; images: number }[] = [];
  const model = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const user = body.messages.filter((m: { role: string }) => m.role === "user").at(-1);
    const parts = Array.isArray(user.content) ? user.content : [{ type: "text", text: user.content }];
    const text = parts.filter((p: { type: string }) => p.type === "text").map((p: { text: string }) => p.text).join("\n");
    const labels = [...text.matchAll(/^image (\d+): (.+)$/gm)].map((m) => m[2]);
    requests.push({ labels, images: parts.filter((p: { type: string }) => p.type === "image_url").length });
    const index = answer === "gallery" ? labels.findIndex((l) => l.startsWith("/gallery")) + 1 : 0;
    const args = answer === "gallery" ? { index, basis: "rendered-items", reason: "八个渐变卡片组件铺满画面" } : { index: 0, basis: "none", reason: "都看不出范围" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "look", object: "chat.completion.chunk", created: 1, model: "look-fixture", choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    send({ role: "assistant", tool_calls: [{ index: 0, id: "pick", type: "function", function: { name: "submit", arguments: JSON.stringify(args) } }] });
    send({}, "tool_calls"); res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(model.address() as { port: number }).port}`;
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ defaultProvider: "look-fixture", defaultModel: "look-fixture" }));
  fs.writeFileSync(path.join(root, "auth.json"), JSON.stringify({ "look-fixture": { type: "api_key", key: "local-look-fixture" } }));
  fs.writeFileSync(path.join(root, "models.json"), JSON.stringify({ providers: { "look-fixture": { api: "openai-completions", baseUrl: `${origin}/v1`, models: [{ id: "look-fixture", input: ["text", "image"] }] } } }));

  const { TOOLS } = await import("../packs/vislexicon/tools.ts");
  const { EvidenceStore } = await import("../server/evidence.ts");
  const { compile } = await import("../server/spec/compile.ts");
  const { pack } = await import("../packs/vislexicon/pack.ts");
  const { closeBrowser } = await import("../server/browser.ts");
  const { closeModelTransport } = await import("../server/pi.ts");
  const node = compile([pack]).nodes.find((n) => n.key === "curation/breadth")!;
  const svc = { store: new EvidenceStore(path.join(root, "evidence")), workDir: path.join(root, "work"), publishDir: path.join(root, "published"), inFlight: () => new Set<string>() };
  const links = ["/docs/components", "/showcase", "/gallery"].map((p, order) => ({ href: site + p, text: p.split("/").pop()!, inNav: true, inMain: false, hasImage: false, visible: true, order }));
  const run = async (id: string) => {
    const progress: string[] = [];
    const context = {
      token: { id, item: "fixture", url: site, data: { kind: "component-source", host: "127.0.0.1", title: "Fixture UI", canonical: site, home: { finalUrl: site + "/", navLinks: links }, homeLinks: links, shots: {} } },
      node, attempt: `a-${id}`, worker: { id: `w-${id}` }, signal: new AbortController().signal,
      progress: (text: string) => progress.push(text), activity: () => {}, addEvidence: (ev: Record<string, unknown>) => ev,
    } as unknown as StationContext;
    return { result: await TOOLS["curation.breadth"](context, svc), progress };
  };
  try {
    await t.test("the model sees every candidate and the CSS-only gallery wins over a name list and a customer showcase", async () => {
      const { result, progress } = await run("pick");
      assert.equal(result.ok, true, progress.join("\n"));
      assert.ok(fs.existsSync(path.join(root, 'browser', 'profile')), 'browser profile belongs to this isolated test project');
      const breadth = (result.data!.shots as Record<string, { href: string; previews: number; visual?: { basis: string; compared: number } }>).breadth;
      assert.equal(new URL(breadth.href).pathname, "/gallery");
      assert.equal(breadth.visual?.basis, "rendered-items");
      assert.ok(breadth.previews < 4, "the element counter alone would have rejected this page");
      const last = requests.at(-1)!;
      assert.ok(last.labels.length >= 3, `compared ${last.labels.join(", ")}\n${progress.join("\n")}`);
      assert.equal(last.images, last.labels.length, "one screenshot per labelled candidate");
      assert.ok(last.labels.some((l) => l.startsWith("/docs/components")) && last.labels.some((l) => l.startsWith("/showcase")));
      assert.ok(!fs.readdirSync(path.join(svc.workDir, "pick")).some((f) => f.startsWith("breadth-look-")), "survey screenshots are cleaned up");
    });
    await t.test("when no screenshot shows the range, the station asks for a page instead of guessing", async () => {
      answer = "none";
      const { result } = await run("none");
      assert.equal(result.ok, false);
      assert.match(String(result.error), /所有候选都被拒收/);
      assert.ok(((result.data!.needsPick as { breadth: string[] }).breadth).length >= 3);
    });
  } finally {
    await closeBrowser();
    await closeModelTransport();
    await new Promise((resolve) => fixture.close(resolve));
    await new Promise((resolve) => model.close(resolve));
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
