// Factory server: JSON API + Server-Sent Events + evidence files (Spec §11). The Electron
// shell starts it; it also runs alone (`npm run server`) for development and tests.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { Factory, ROOT, VAR } from "./factory.ts";
import { Dispatcher, MODEL_ID } from "./dispatcher.ts";
import { apiKeyPresent } from "./agent-station.ts";
import { piStatus, closeModelTransport } from "./pi.ts";
import { publishConnection } from "./discovery.ts";
import { readReportJson, closeReportReaders } from './report-reader.ts';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { JournalEventStream } from './event-stream.ts';
import { closeBrowser, browserCommand, browserEvents } from "./browser.ts";
import { closeNetwork } from "./network.ts";
import { layoutFactory } from "../shared/layout.ts";
import { FactoryControl } from "./control.ts";
import { ControlError } from "./errors.ts";

const PORT = Number(process.env.FACTORY_PORT ?? 4317);
const TOKEN = process.env.FACTORY_TOKEN;
const READONLY = process.env.FACTORY_READONLY === "1";
const factory = new Factory();
await factory.boot();
const control = new FactoryControl(factory);
const dispatcher = new Dispatcher(factory, control);
let latestBrowserState: import('../shared/browser.ts').BrowserState | undefined;
browserEvents.add(state => {
  latestBrowserState = state;
  factory.emit({kind: 'browser.state', state});
  void factory.resumeVerified(state);
});
let chatTask: Promise<unknown> | null = null;

const MIME: Record<string, string> = { ".webp": "image/webp", ".mp4": "video/mp4", ".json": "application/json", ".js": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".py": "text/plain; charset=utf-8", ".pdf": "application/pdf", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".zip": "application/zip" };

function send(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end(text);
}

async function body(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1024 * 1024) throw new ControlError(413, "body_too_large", "请求不能超过 1 MiB");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { throw new ControlError(400, "invalid_json", "请求必须是有效 JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ControlError(400, "invalid_body", "请求必须是 JSON 对象");
  return parsed;
}

function serveFile(res: http.ServerResponse, file: string, req: http.IncomingMessage) {
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  const stat = fs.statSync(file);
  if (!stat.isFile()) { res.writeHead(404); res.end(); return; }
  const type = MIME[path.extname(file)] ?? "application/octet-stream";
  const range = req.headers.range;
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": type,
    "Cache-Control": file.includes(`${path.sep}evidence${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
    "Access-Control-Allow-Origin": "*",
  };
  let span: { start: number; end: number } | undefined;
  if (type === "video/mp4") {
    headers["Accept-Ranges"] = "bytes";
    // Chromium seeks using both suffix and open ranges. Unsupported multipart
    // ranges may be ignored, but an invalid single range must never reach fs.
    if (range?.startsWith("bytes=") && !range.includes(",")) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start = 0, end = stat.size - 1;
      let valid = Boolean(match && (match[1] || match[2]) && stat.size > 0);
      if (valid && match) {
        if (!match[1]) {
          const suffix = Number(match[2]);
          valid = Number.isSafeInteger(suffix) && suffix > 0;
          start = Math.max(0, stat.size - suffix);
        } else {
          start = Number(match[1]);
          end = match[2] ? Number(match[2]) : end;
          valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < stat.size && start <= end;
          end = Math.min(end, stat.size - 1);
        }
      }
      if (!valid) {
        res.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}`, "Content-Length": 0 });
        res.end(); return;
      }
      span = { start, end };
      headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    }
  }
  headers["Content-Length"] = span ? span.end - span.start + 1 : stat.size;
  res.writeHead(span ? 206 : 200, headers);
  const stream = fs.createReadStream(file, span);
  // Leaving a preview or seeking again cancels the old read. A removed evidence
  // file must terminate this response, rather than crash the entire backend.
  res.once("close", () => stream.destroy());
  stream.once("error", error => res.destroy(error));
  stream.pipe(res);
}

const clients = new Set<JournalEventStream>();
factory.ephemeral.add(event => {
  for (const client of clients) client.sendLive(event);
});
const ping = setInterval(() => {
  for (const client of clients) client.ping();
}, 15000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const p = url.pathname;
  try {
    if (TOKEN) {
      const cookie = (req.headers.cookie ?? "").split(";").map((c) => c.trim()).find((c) => c.startsWith("pf_auth="))?.slice(8) ?? "";
      const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
      const supplied = Buffer.from(bearer ?? cookie), expected = Buffer.from(TOKEN);
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return send(res, 401, { ok: false, code: "unauthorized", error: "Bearer token or desktop session required" });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: "Origin not allowed" });
    }
    if (READONLY && req.method === "POST" && p !== "/api/layout" && !p.startsWith("/api/tools/")) return send(res, 403, { ok: false, code: "read_only", error: "当前为只读查看；请在工作区菜单切换到独立工作区。" });
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type,authorization", "Access-Control-Allow-Methods": "GET,POST" }); res.end(); return; }
    if (req.method !== "GET" && req.method !== "POST") throw new ControlError(405, "method_not_allowed", "只支持 GET 或 POST");
    if (req.method === "GET" && p === "/api/agent/bootstrap") return send(res, 200, control.bootstrap());
    if (req.method === "GET" && p.startsWith("/api/agent/tools/")) return send(res, 200, control.describe(decodeURIComponent(p.slice("/api/agent/tools/".length))));
    if (req.method === "GET" && ["/api/tools", "/api/capabilities", "/.well-known/agent.json"].includes(p)) return send(res, 200, control.manifest());
    if (req.method === "POST" && p.startsWith("/api/tools/")) return send(res, 200, await control.execute(decodeURIComponent(p.slice("/api/tools/".length)), await body(req)));
    const readRoute = p.startsWith("/evidence/") || p.startsWith("/api/report/") || p.startsWith("/api/agent/") || ["/api/factory", "/api/state", "/api/events", "/api/journal", "/api/runs", "/api/tools", "/api/capabilities", "/.well-known/agent.json"].includes(p);
    if (readRoute && req.method !== "GET") throw new ControlError(405, "method_not_allowed", "此资源只支持 GET");
    if (p.startsWith("/evidence/")) { const file = factory.store.resolve(p); if (!file) { res.writeHead(404); res.end(); return; } serveFile(res, file, req); return; }
    if (p === "/api/factory") {
      const c = factory.compiled;
      const pi = piStatus();
      return send(res, 200, { factory: c, layout: factory.readLayout(), defaultLayout: layoutFactory(c.nodes, c.edges, c.ui.order, c.ui.hints, c.ui.collapsed), settings: factory.settings, model: pi.id, pi, keyPresent: pi.ready, patches: factory.patches, agentBindings: factory.agentBindings().bindings });
    }
    if (p === "/api/state") return send(res, 200, { ...factory.state, dispatcher: dispatcher.status });
    if (p === "/api/browser" && req.method === "GET") return send(res, 200, await browserCommand({action:"state"}));
    if (p === "/api/events") {
      const since = Number(req.headers["last-event-id"] ?? url.searchParams.get("since") ?? 0);
      if (!Number.isSafeInteger(since) || since < 0) throw new ControlError(400, "invalid_cursor", "since 必须是非负整数");
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
      res.flushHeaders();
      const client = new JournalEventStream(factory.journal, res, since, () => {
        const snapshot: unknown[] = [{kind: 'chat.reset', turn: dispatcher.status.turn}];
        if (dispatcher.busy) {
          snapshot.push({kind: 'chat.start', id: dispatcher.status.turn});
          if (dispatcher.live) snapshot.push({kind: 'chat.pi', ...dispatcher.live});
        }
        // Reconnecting after chat.end clears the client's stale busy state too.
        snapshot.push({kind: 'chat.status', ...dispatcher.status});
        if (latestBrowserState) snapshot.push({kind: 'browser.state', state: latestBrowserState});
        return snapshot;
      });
      clients.add(client);
      res.once('close', () => clients.delete(client));
      return;
    }
    if (p === "/api/journal") {
      const run = url.searchParams.get("run") ?? undefined;
      const since = Number(url.searchParams.get("since") ?? 0);
      if (!Number.isSafeInteger(since) || since < 0) throw new ControlError(400, "invalid_cursor", "since 必须是非负整数");
      const through = Number(url.searchParams.get('through') ?? factory.journal.seq);
      if (!Number.isSafeInteger(through) || through < since) {
        throw new ControlError(400, 'invalid_cursor', 'through 必须是大于或等于 since 的整数');
      }
      if (url.searchParams.has('limit')) {
        const limit = Number(url.searchParams.get('limit'));
        try {
          return send(res, 200, factory.journal.readPage({since, run, through, limit}));
        } catch (error) {
          if (error instanceof RangeError) {
            throw new ControlError(400, 'invalid_cursor', 'limit 必须是1–500的整数');
          }
          throw error;
        }
      }
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      let cursor = since;
      while (!res.destroyed) {
        const page = factory.journal.readPage({since: cursor, run, through, limit: 200});
        for (const event of page.events) {
          if (res.destroyed) break;
          if (!res.write(JSON.stringify(event) + '\n')) {
            await new Promise<void>(resolve => {
              const done = () => {
                res.off('drain', done);
                res.off('close', done);
                resolve();
              };
              res.once('drain', done);
              res.once('close', done);
            });
          }
        }
        if (page.done) break;
        cursor = page.nextSeq;
        await yieldLoop();
      }
      if (res.destroyed) return;
      res.end();
      return;
    }
    if (p === "/api/runs") return send(res, 200, factory.journal.runs().map((r) => ({ ...r, report: fs.existsSync(path.join(VAR, "runs", r.run, "report.json")) })));
    if (p.startsWith("/api/report/")) {
      const id = decodeURIComponent(p.slice("/api/report/".length));
      if (!/^run-[a-zA-Z0-9-]+$/.test(id)) throw new ControlError(400, "invalid_run_id", "无效运行编号");
      if (!factory.journal.lastSequence(id)) return send(res, 404, {error: 'no report'});
      const controller = new AbortController();
      const disconnected = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once('close', disconnected);
      try {
        const result = await readReportJson(factory, id, controller.signal);
        if (res.destroyed) return;
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Report-Sequence': String(result.seq),
        });
        res.end(result.body);
        return;
      } catch (error) {
        if (controller.signal.aborted || res.destroyed) return;
        throw error;
      } finally {
        res.off('close', disconnected);
      }
    }
    if (req.method === "POST") {
      const b = await body(req);
      switch (p) {
        case '/api/agents/binding': return send(res, 200, await control.execute('set_agent_binding', b, 'user'));
        case '/api/sources/configure': return send(res, 200, await control.execute('source_configure', b, 'user'));
        case '/api/sources/enable': return send(res, 200, await control.execute('source_enable', b, 'user'));
        case '/api/sources/poll': return send(res, 200, await control.execute('source_poll', b, 'user'));
        case "/api/workflows/template": return send(res, 200, await control.execute("workflow_template", b, "user"));
        case "/api/workflows/install": return send(res, 200, await control.execute("workflow_install", b, "user"));
        case "/api/workflows/line": return send(res, 200, await control.execute("workflow_line", b, "user"));
        case "/api/workflows/feed": return send(res, 200, await control.execute("workflow_feed", b, "user"));
        case "/api/allocation-plan": return send(res, 200, await control.execute("allocation_plan", b, "user"));
        case "/api/correct/undo": return send(res, 200, await control.execute("undo_correction", b, "user"));
        case "/api/business/feed": return send(res, 200, await control.execute("business_feed", b, "user"));
        case "/api/browser": return send(res, 200, (await control.execute("browser", b, "user")).result);
        case "/api/chat/abort": dispatcher.abort(); return send(res, 200, { ok: true });
        case "/api/chat/continue": {
          if (dispatcher.busy) return send(res, 202, { ok: true, accepted: true, turn: dispatcher.status.turn, status: dispatcher.status });
          if (!dispatcher.status.recoverable) throw new ControlError(409, "nothing_to_resume", "没有需要恢复的回答");
          chatTask = dispatcher.resume().finally(() => { chatTask = null; });
          return send(res, 202, { ok: true, accepted: true, turn: dispatcher.status.turn, status: dispatcher.status });
        }
        case "/api/chat": {
          if (typeof b.text !== "string" || !b.text.trim() || b.attachments !== undefined && !Array.isArray(b.attachments)) throw new ControlError(400, "invalid_chat", "消息不能为空，attachments 必须是数组");
          if (b.requestId !== undefined && (typeof b.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,120}$/.test(b.requestId))) throw new ControlError(400, "invalid_request_id", "requestId 格式不正确");
          if (b.mode !== undefined && !["steer", "followUp"].includes(b.mode)) throw new ControlError(400, "invalid_chat_mode", "mode 必须是 steer 或 followUp");
          const receipt = b.requestId ? dispatcher.receipt(b.requestId) : null;
          if (receipt) return send(res, 202, receipt);
          if (dispatcher.busy) return send(res, 202, dispatcher.steer(b.text, b.attachments ?? [], b.mode ?? "steer", b.requestId));
          chatTask = dispatcher.chat(b.text, b.attachments ?? [], b.requestId).finally(() => { chatTask = null; });
          return send(res, 202, { ok: true, accepted: true, id: dispatcher.status.turn, turn: dispatcher.status.turn, status: dispatcher.status });
        }
        case "/api/run": {
          const receipt = await control.execute("run_control", b, "user");
          return send(res, 200, { ...receipt, run: receipt.result });
        }
        case "/api/pull": { const r = await control.execute("pull_candidates", b, "user"); return send(res, 200, { ...r, ...r.result }); }
        case "/api/feed": { const r = await control.execute("feed_urls", b, "user"); return send(res, 200, { ...r, ...r.result }); }
        case "/api/correct": {
          const items: { token: string; node: string; evidence?: string }[] = b.items ?? [{ token: b.token, node: b.node, evidence: b.evidence }];
          if (!Array.isArray(items) || !items.length || items.length > 200) throw new ControlError(400, "invalid_items", "纠错需要 1–200 个目标");
          const results = [];
          for (const it of items) {
            const args = { token: it.token, station: it.node, evidence: it.evidence, reason: b.reason, note: b.note };
            try { results.push((await control.execute("correct", JSON.parse(JSON.stringify(args)), "user")).result); }
            catch (err) { if (!(err instanceof ControlError)) throw err; results.push({ ok: false, message: err.message }); }
          }
          return send(res, 200, { ok: results.every((r) => r.ok), results });
        }
        case "/api/workers": {
          const r = await control.execute("workers", { station: b.node, action: b.action, reason: "站长手动操作" }, "user");
          return send(res, 200, { ...r, ...r.result });
        }
        case "/api/layout": factory.writeLayout(b); return send(res, 200, { ok: true });
        case "/api/settings": { const r = await control.execute("settings", { values: b }, "user"); return send(res, 200, { ...r, settings: r.result }); }
        case "/api/patch": return send(res, 200, await control.execute("decide_patch", b, "user"));
        case "/api/lessons/decision": return send(res, 200, await control.execute("decide_lesson", b, "user"));
      }
    }
    if (p.startsWith("/api/") || p.startsWith("/.well-known/") || req.method !== "GET") throw new ControlError(404, "not_found", "接口不存在");
    // Production: serve the built dashboard.
    const dist = process.env.FACTORY_DIST ?? path.join(ROOT, "ui", "dist");
    if (fs.existsSync(dist)) {
      const file = path.join(dist, p === "/" ? "index.html" : p);
      if (file.startsWith(dist) && fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file, req);
      return serveFile(res, path.join(dist, "index.html"), req);
    }
    res.writeHead(404); res.end();
  } catch (err) {
    if (!(err instanceof ControlError)) console.error(err);
    send(res, err instanceof ControlError ? err.status : 500, { ok: false, code: err instanceof ControlError ? err.code : "internal_error", error: (err as Error).message, ...(err instanceof ControlError && err.details ? { details: err.details } : {}) });
  }
});

let removeConnection = () => {};
server.listen(PORT, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  const url = `http://127.0.0.1:${port}`;
  removeConnection = publishConnection(url, TOKEN);
  console.log(`Easy Workflow server on ${url}  (var: ${VAR})`);
  process.send?.({ type: "ready", url });
  chatTask = dispatcher.recover().finally(() => { chatTask = null; });
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return; stopping = true;
  removeConnection();
  clearInterval(ping);
  factory.channels?.close();
  const sourceTask = factory.sources.close();
  closeReportReaders();
  factory.runtime.paused = true;
  dispatcher.interrupt();
  for (const client of clients) client.close();
  server.close(); server.closeAllConnections();
  await Promise.all([sourceTask, factory.runtime.close(), chatTask]);
  await Promise.all([closeBrowser(), closeModelTransport(), closeNetwork()]); factory.docs.flush(); factory.lessons.close(); factory.journal.close(); process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("message", (message: { type?: string }) => { if (message?.type === "shutdown") void shutdown(); });
process.on("disconnect", shutdown);
