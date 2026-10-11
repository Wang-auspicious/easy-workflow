// Offline production build. Native TS stripping preserves module-relative assets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { build as viteBuild } from 'vite';
import { build as bundleVendor } from 'rolldown';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const output = path.join(root, 'dist', 'desktop');

export function safeRemove(target, boundary) {
  const resolved = path.resolve(target), parent = path.resolve(boundary);
  if (resolved === parent || !resolved.startsWith(parent + path.sep)) throw new Error(`Refusing removal outside ${parent}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const file = path.join(dir, item.name);
    return item.isDirectory() ? walk(file) : [file];
  });
}

function findPackage(name, from) {
  let at = from;
  while (true) {
    const dir = path.join(at, 'node_modules', name);
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const next = path.dirname(at); if (next === at) return null; at = next;
  }
}

function copyRuntimeDependencies(destination) {
  const seen = new Set();
  const queue = ['playwright-core', 'undici'].map((name) => [name, root, false]);
  while (queue.length) {
    const [name, from, optional] = queue.shift();
    const source = findPackage(name, from);
    if (!source) { if (optional) continue; throw new Error(`Missing runtime dependency ${name}`); }
    if (seen.has(source)) continue;
    const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    if (metadata.os && !metadata.os.includes(process.platform) && !metadata.os.every((s) => s.startsWith('!'))) continue;
    seen.add(source);
    const relative = path.relative(root, source);
    if (relative.startsWith('..')) throw new Error(`Dependency outside workspace: ${name}`);
    const target = path.join(destination, relative);
    fs.cpSync(source, target, { recursive: true, filter: (file) => {
      const rel = path.relative(source, file);
      if (!rel) return true;
      const parts = rel.split(path.sep);
      return !parts.some((p) => ['node_modules', 'test', 'tests', '__tests__', 'docs', 'examples', '.github', 'coverage', '.local-browsers', '.cache'].includes(p))
        && !/\.(map|tsbuildinfo)$|\.d\.(ts|mts|cts)$/.test(file);
    } });
    for (const dep of Object.keys(metadata.dependencies || {})) queue.push([dep, source, false]);
    for (const dep of Object.keys(metadata.optionalDependencies || {})) queue.push([dep, source, true]);
  }
  return seen.size;
}

export async function buildDesktop() {
  const configuredRoot = process.env.VISLEXICON_ROOT?.trim();
  if (!configuredRoot) throw new Error('Set VISLEXICON_ROOT to the connected VisLexicon repository before building; no personal-directory fallback is used.');
  const visRoot = path.resolve(configuredRoot);
  const ruleSources = [
    [path.join(visRoot, 'Spec.md'), 'Spec.md'],
    ...['vocab.json', 'preview-rules.json'].map((name) => [path.join(visRoot, 'VisLexicon-browser-design-kit', 'frontend', 'public', 'spec', 'v1', name), path.join('public', 'spec', 'v1', name)]),
    ...['style/site-style.mjs', 'ingest-v5/common.mjs'].map((name) => [path.join(visRoot, 'VisLexicon-browser-design-kit', 'frontend', 'scripts', name), path.join('scripts', name)]),
    [path.join(visRoot, 'VisLexicon-browser-design-kit', 'frontend', 'src', 'data', 'curation-taxonomy.js'), path.join('src', 'data', 'curation-taxonomy.js')],
  ];
  // Check source availability before rebuilding UI or replacing a previous distribution.
  for (const [source, relative] of ruleSources) if (!fs.existsSync(source)) throw new Error(`Required rule source is missing under VISLEXICON_ROOT: ${relative}`);
  await viteBuild({ configFile: path.join(root, 'ui', 'vite.config.ts') });
  safeRemove(output, root);
  fs.mkdirSync(output, { recursive: true });
  await bundleVendor({
    cwd: root, input: 'factory-vendor', platform: 'node',
    plugins: [{ name: 'factory-vendor',
      resolveId(id) { if (id === 'factory-vendor') return '\0factory-vendor'; },
      load(id) { if (id === '\0factory-vendor') return 'export {Agent} from "@earendil-works/pi-agent-core"; export {createModels,createProvider,envApiKeyAuth} from "@earendil-works/pi-ai"; export {opencodeGoProvider} from "@earendil-works/pi-ai/providers/opencode-go"; export {withOpenCodeSessionHeader} from "@earendil-works/pi-ai/providers/opencode-headers"; export {openAICompletionsApi} from "@earendil-works/pi-ai/api/openai-completions.lazy"; export {openAIResponsesApi} from "@earendil-works/pi-ai/api/openai-responses.lazy"; export {anthropicMessagesApi} from "@earendil-works/pi-ai/api/anthropic-messages.lazy"; export {Type} from "typebox"; export {Check,Errors} from "typebox/value";'; },
    }],
    output: { dir: path.join(output, 'vendor'), format: 'esm', entryFileNames: 'pi.js', minify: true, codeSplitting: false },
  });
  for (const folder of ['server', 'shared', 'packs']) {
    for (const file of walk(path.join(root, folder))) {
      const rel = path.relative(root, file);
      if (!/\.(ts|md|json)$/.test(file)) continue;
      const target = path.join(output, rel.replace(/\.ts$/, '.js'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (file.endsWith('.ts')) {
        const vendor = path.relative(path.dirname(target), path.join(output, 'vendor', 'pi.js')).split(path.sep).join('/');
        const js = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'strip' })
          .replace(/(["'])(\.\.?\/[^"']+)\.ts\1/g, '$1$2.js$1')
          .replace(/(["'])(@earendil-works\/pi-agent-core|@earendil-works\/pi-ai(?:\/(?:providers\/opencode-(?:go|headers)|api\/[a-z-]+\.lazy))?|typebox(?:\/value)?)\1/g, JSON.stringify(vendor));
        fs.writeFileSync(target, js);
      } else fs.copyFileSync(file, target);
    }
  }
  fs.cpSync(path.join(root, 'app'), path.join(output, 'app'), { recursive: true });
  fs.cpSync(path.join(root, 'ui', 'dist'), path.join(output, 'ui', 'dist'), { recursive: true });
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify({ name: sourcePackage.name, version: sourcePackage.version, type: 'module', main: 'app/main.cjs', description: sourcePackage.description }, null, 2));
  const bundle = path.join(output, 'resources', 'vislexicon');
  for (const [source, rel] of ruleSources) {
    const target = path.join(bundle, rel); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
  }
  const packages = copyRuntimeDependencies(output);
  const licenses = path.join(output, 'licenses'); fs.mkdirSync(licenses, { recursive: true });
  fs.copyFileSync(path.join(root, 'ui/src/vendor/pi-web-ui/LICENSE'), path.join(licenses, 'pi-web-ui-LICENSE'));
  fs.copyFileSync(path.join(root, 'ui/src/vendor/pi-web-ui/UPSTREAM.md'), path.join(licenses, 'pi-web-ui-UPSTREAM.md'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  for (const rel of Object.keys(lock.packages).filter((p) => p && !lock.packages[p].dev)) {
    const dir = path.join(root, rel); if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((n) => /^(license|copying|notice)(\.|$)/i.test(n))) {
      const file = path.join(dir, name); if (!fs.statSync(file).isFile()) continue;
      fs.copyFileSync(file, path.join(licenses, rel.replace(/[\\/]/g, '__') + '__' + name));
    }
  }
  const files = walk(output);
  const bytes = files.reduce((n, file) => n + fs.statSync(file).size, 0);
  fs.writeFileSync(path.join(root, 'dist', 'build-manifest.json'), JSON.stringify({ packages, files: files.length, bytes, exclusions: ['user data', 'credentials', 'legacy', 'tests', 'source maps', 'development dependencies', 'extra Chromium'], builtAt: new Date().toISOString() }, null, 2));
  console.log(`Desktop payload: ${(bytes / 1048576).toFixed(1)} MiB, ${files.length} files, ${packages} runtime packages.`);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildDesktop();
