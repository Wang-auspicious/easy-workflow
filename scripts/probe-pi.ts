// Probe: pi-ai + pi-agent-core against opencode-go deepseek-v4.1-flash with one structured tool.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

if (!process.env.OPENCODE_API_KEY) {
  const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".local/share/opencode/auth.json"), "utf8"));
  process.env.OPENCODE_API_KEY = auth["opencode-go"].key;
}
const models = createModels();
models.setProvider(opencodeGoProvider());
const model = models.getModel("opencode-go", "deepseek-v4.1-flash");
if (!model) throw new Error("no model");
let submitted: unknown;
const agent = new Agent({
  initialState: {
    systemPrompt: "You classify websites. Always answer by calling submit exactly once.",
    model,
    thinkingLevel: "off",
    tools: [{
      name: "submit", label: "Submit", description: "Submit the classification",
      parameters: Type.Object({ kind: Type.String(), confidence: Type.Number() }),
      execute: async (_id, params) => { submitted = params; return { content: [{ type: "text", text: "ok" }], details: {}, terminate: true }; },
    }],
  },
  streamFn: models.streamSimple.bind(models),
  sessionId: "probe-" + Date.now(),
});
const t0 = Date.now();
agent.subscribe((e) => { if (e.type === "turn_end") console.log("turn_end usage", JSON.stringify((e.message as any).usage)); });
await agent.prompt("Site: https://magicui.design — title 'Magic UI: UI library for Design Engineers'. Kinds: component-source, design-gallery, tool, other.");
console.log("submitted", submitted, Date.now() - t0, "ms", agent.state.errorMessage);
