import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { publishConnection } from "../server/discovery.ts";
import { controlConnectionPaths, findControlConnectionFile } from "../server/agent-connection.ts";
import extension, { requestEasyWorkflow } from "../integrations/pi/easy-workflow.ts";
import legacyExtension, { requestH2 } from "../integrations/pi/h2-factory.ts";

const keys = ["PI_CODING_AGENT_DIR", "FACTORY_AGENT_CONNECTION", "EASY_WORKFLOW_AGENT_CONNECTION", "FACTORY_DISCOVERY", "FACTORY_DESKTOP_TEST"];
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-branding-"));
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = directory;
  return { directory, restore: () => {
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()), "easy-workflow-branding-")));
    fs.rmSync(directory, { recursive: true, force: true });
  } };
}

test("connection publication prefers Easy Workflow, preserves installed clients and owns its cleanup", () => {
  const { directory, restore } = fixture();
  try {
    const paths = controlConnectionPaths();
    assert.deepEqual(paths, [path.join(directory, "easy-workflow", "connection.json"), path.join(directory, "h2", "connection.json")]);
    const closeFirst = publishConnection("http://127.0.0.1:4317", "fixture-private");
    assert.equal(findControlConnectionFile(), paths[0]);
    for (const file of paths) {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(value.product, "Easy Workflow"); assert.equal(value.protocol, "h2-agent/1");
      assert.equal(value.url, "http://127.0.0.1:4317");
    }
    const closeSecond = publishConnection("http://127.0.0.1:4318", "fixture-other-private");
    closeFirst(); assert.ok(paths.every(file => fs.existsSync(file)), "earlier publisher must not unlink the new session");
    closeSecond(); assert.ok(paths.every(file => !fs.existsSync(file)));
    fs.writeFileSync(paths[1], JSON.stringify({ protocol: "h2-agent/1", url: "http://127.0.0.1:4317" }));
    assert.equal(findControlConnectionFile(), paths[1]);
    process.env.FACTORY_AGENT_CONNECTION = path.join(directory, "explicit-old.json");
    assert.deepEqual(controlConnectionPaths(), [process.env.FACTORY_AGENT_CONNECTION]);
    process.env.EASY_WORKFLOW_AGENT_CONNECTION = path.join(directory, "explicit-new.json");
    assert.deepEqual(controlConnectionPaths(), [process.env.EASY_WORKFLOW_AGENT_CONNECTION]);
  } finally { restore(); }
});

test("standalone Pi adapter reads both paths and exposes branded tools with working aliases", async () => {
  const { directory, restore } = fixture(), secret = "private-fixture-credential";
  const registered = new Map<string, any>(), hooks = new Map<string, any>();
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/agent/bootstrap") res.end(JSON.stringify({ product: "Easy Workflow", instructions: "Easy Workflow: use easy_workflow_help and easy_workflow_call.", revision: "easy-workflow-v1:fixture", incidental: secret }));
    else res.end(JSON.stringify({ ok: true, route: req.url }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const connection = { protocol: "h2-agent/1", token: secret, url: `http://127.0.0.1:${(server.address() as any).port}` };
  try {
    assert.equal(legacyExtension, extension); assert.equal(requestH2, requestEasyWorkflow);
    const [current, old] = controlConnectionPaths(); fs.mkdirSync(path.dirname(old)); fs.writeFileSync(old, JSON.stringify(connection));
    assert.equal((await requestEasyWorkflow("/api/agent/bootstrap")).product, "Easy Workflow");
    fs.mkdirSync(path.dirname(current)); fs.writeFileSync(current, JSON.stringify(connection)); fs.rmSync(old);
    assert.equal((await requestH2("/api/agent/bootstrap")).product, "Easy Workflow");
    extension({ registerTool: tool => registered.set(tool.name, tool), on: (name, handler) => hooks.set(name, handler) });
    assert.deepEqual([...registered.keys()], ["easy_workflow_help", "easy_workflow_call", "h2_help", "h2_call"]);
    for (const tool of registered.values()) assert.ok(!/\bH2\b|\bH1\b|ZCode|Pi Factory/i.test(`${tool.label} ${tool.description}`));
    const hook = hooks.get("before_agent_start");
    const initial = await hook({ systemPrompt: "base\n<h2-agent>obsolete</h2-agent>" });
    const repeated = await hook({ systemPrompt: initial.systemPrompt });
    assert.equal((repeated.systemPrompt.match(/<easy-workflow-agent>/g) ?? []).length, 1);
    assert.ok(!repeated.systemPrompt.includes("h2-agent")); assert.ok(!repeated.systemPrompt.includes(secret));
    for (const name of ["easy_workflow_call", "h2_call"]) {
      const result = await registered.get(name).execute("test", { name: "status", arguments: {} });
      assert.equal(JSON.parse(result.content[0].text).ok, true);
    }
    const info = await registered.get("easy_workflow_help").execute("test", {});
    assert.ok(!JSON.stringify(info).includes(secret));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); restore(); }
});
