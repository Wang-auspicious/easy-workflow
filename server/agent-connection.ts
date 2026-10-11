// One rendezvous policy for Easy Workflow. Legacy readers keep their wire/file contract.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Retained on disk because existing installed clients strictly validate this value.
export const CONTROL_PROTOCOL = "h2-agent/1";
export const CONTROL_HELP = "easy_workflow_help";
export const CONTROL_CALL = "easy_workflow_call";

export function controlConnectionPaths(env: NodeJS.ProcessEnv = process.env) {
  const explicit = env.EASY_WORKFLOW_AGENT_CONNECTION ?? env.FACTORY_AGENT_CONNECTION;
  if (explicit) return [explicit];
  const directory = env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  return [path.join(directory, "easy-workflow", "connection.json"), path.join(directory, "h2", "connection.json")];
}

export function findControlConnectionFile(env: NodeJS.ProcessEnv = process.env) {
  const files = controlConnectionPaths(env);
  return files.find(file => fs.existsSync(file)) ?? files[0];
}
