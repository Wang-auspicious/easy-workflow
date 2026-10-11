// Private connection rendezvous for local Pi sessions; no credentials enter prompts.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { controlConnectionPaths, CONTROL_PROTOCOL } from "./agent-connection.ts";

export function publishConnection(url: string, token?: string) {
  if (process.env.FACTORY_DISCOVERY === "0" || process.env.FACTORY_DESKTOP_TEST === "1") return () => {};
  const files = controlConnectionPaths(), instanceId = crypto.randomUUID();
  const payload = JSON.stringify({ protocol: CONTROL_PROTOCOL, product: "Easy Workflow", url, token, pid: process.pid, instanceId, startedAt: new Date().toISOString() });
  const cleanup = () => {
    for (const file of files) try {
      if (JSON.parse(fs.readFileSync(file, "utf8")).instanceId === instanceId) fs.unlinkSync(file);
    } catch { /* already replaced or removed */ }
  };
  try {
    // Publishing the legacy path keeps already installed clients connected after a rename.
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${instanceId}.tmp`;
      try { fs.writeFileSync(tmp, payload, { mode: 0o600 }); fs.renameSync(tmp, file); }
      finally { fs.rmSync(tmp, { force: true }); }
    }
  } catch (error) { cleanup(); throw error; }
  return cleanup;
}
