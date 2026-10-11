import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
const canonical = path.join(dir, 'extensions', 'easy-workflow.ts');
const legacy = path.join(dir, 'extensions', 'h2-factory.ts');
const source = path.join(root, 'integrations', 'pi', 'easy-workflow.ts');
const known = file => /^(?:\/\/ (?:H2|Easy Workflow)'s local Pi adapter\.|\/\/ Easy Workflow)/.test(fs.readFileSync(file, 'utf8'));
for (const file of [canonical, legacy]) if (fs.existsSync(file) && !known(file)) throw new Error('Refusing to replace an unrelated Pi extension');
// Upgrade one installed entry in place so Pi never loads duplicate tool definitions.
const target = fs.existsSync(legacy) && !fs.existsSync(canonical) ? legacy : canonical;
fs.mkdirSync(path.dirname(target), { recursive: true });
if (target === canonical && fs.existsSync(legacy)) {
  const backup = `${legacy}.${Date.now()}.disabled`;
  fs.renameSync(legacy, backup);
}
fs.copyFileSync(source, target);
console.log('Installed Easy Workflow Pi adapter. Reload Pi to activate it.');
