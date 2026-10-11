import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
const target = path.join(dir, 'extensions', 'h2-factory.ts');
const source = path.join(root, 'integrations', 'pi', 'h2-factory.ts');
fs.mkdirSync(path.dirname(target), { recursive: true });
if (fs.existsSync(target) && !fs.readFileSync(target, 'utf8').startsWith('// H2\'s local Pi adapter.')) throw new Error('Refusing to replace an unrelated h2-factory.ts');
fs.copyFileSync(source, target);
console.log(`Installed H2 Pi adapter: ${target}`);
