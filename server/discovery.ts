// Private connection rendezvous for local Pi sessions; no credentials enter prompts.
import fs from "node:fs";
import path from "node:path";
import { piDirectory } from "./pi.ts";

export function publishConnection(url: string, token?: string) {
  if (process.env.FACTORY_DISCOVERY === "0" || process.env.FACTORY_DESKTOP_TEST === "1") return () => {};
  const file = process.env.FACTORY_AGENT_CONNECTION ?? path.join(piDirectory(), "h2", "connection.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ protocol: "h2-agent/1", url, token, pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return () => {
    try {
      if (JSON.parse(fs.readFileSync(file, "utf8")).pid === process.pid) fs.unlinkSync(file);
    } catch { /* already replaced or removed */ }
  };
}
