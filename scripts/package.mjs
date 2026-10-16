import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { buildDesktop, output, root, safeRemove } from './build.mjs';

const zipOnly = process.argv.includes('--zip-only');
const packageName = process.argv.find(argument => argument.startsWith('--name='))?.slice(7)
  ?? `EasyWorkflow-${process.platform}-${process.arch}`;
if (!/^EasyWorkflow-[a-zA-Z0-9_-]+$/.test(packageName)) {
  throw new Error('Package name must start with EasyWorkflow- and contain only letters, digits, hyphens or underscores.');
}
const target = path.join(root, 'release', packageName);
if (!zipOnly) {
if (!process.argv.includes('--no-build')) await buildDesktop();
const require = createRequire(import.meta.url);
const electronExe = require('electron');
const runtime = path.dirname(electronExe);
safeRemove(target, root);
fs.mkdirSync(target, { recursive: true });
fs.cpSync(runtime, target, { recursive: true, filter: (file) => {
  const rel = path.relative(runtime, file);
  if (rel === path.join('resources', 'default_app.asar')) return false;
  if (rel.startsWith('locales' + path.sep) && !['en-US.pak', 'zh-CN.pak'].includes(path.basename(file))) return false;
  return true;
} });
fs.cpSync(output, path.join(target, 'resources', 'app'), { recursive: true });
if (process.platform === 'win32') fs.renameSync(path.join(target, 'electron.exe'), path.join(target, 'EasyWorkflow.exe'));
function inventory(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => item.isDirectory() ? inventory(path.join(dir, item.name)) : [path.join(dir, item.name)]);
  return files;
}
const files = inventory(target);
const bytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
const appBytes = files.filter((file) => file.startsWith(path.join(target, 'resources', 'app') + path.sep)).reduce((sum, file) => sum + fs.statSync(file).size, 0);
fs.writeFileSync(path.join(root, 'release', 'package-manifest.json'), JSON.stringify({ target, bytes, appBytes, runtimeBytes: bytes - appBytes, files: files.length, chromiumRuntimes: 1, dataIncluded: false, secretsIncluded: false }, null, 2));
console.log(`Portable app: ${target}\n${(bytes / 1048576).toFixed(1)} MiB total; app ${(appBytes / 1048576).toFixed(1)} MiB; Electron ${( (bytes - appBytes) / 1048576).toFixed(1)} MiB.`);
}
if (process.argv.includes('--zip') || zipOnly) {
  if (process.platform !== 'win32') throw new Error('The portable zip helper currently targets Windows.');
  const archive = target + '.zip';
  const info = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'package-zip.ps1'), '-Source', target, '-Destination', archive], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }));
  fs.writeFileSync(path.join(root, 'release', 'zip-manifest.json'), JSON.stringify(info, null, 2));
  console.log(`Verified portable ZIP: ${(info.bytes / 1048576).toFixed(1)} MiB\n${info.path}\nSHA-256 ${info.sha256}`);
}
