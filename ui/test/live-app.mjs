// A real HTTP backend in an isolated temporary project. Never connects to saved projects.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

export async function liveApp(label) {
  const root = path.resolve(import.meta.dirname, '../..');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `easy-ui-${label}-`));
  const token = 'isolated-ui-acceptance-only';
  let child, vite, browser, output = '';
  const close = async () => {
    await browser?.close(); await vite?.close();
    if (child && child.exitCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill(), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send({ type: 'shutdown' }); else child.kill();
    });
    const absolute = path.resolve(directory), base = path.resolve(os.tmpdir()) + path.sep;
    if (!absolute.startsWith(base) || !path.basename(absolute).startsWith(`easy-ui-${label}-`)) throw new Error('Unsafe test cleanup path');
    await fs.rm(absolute, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  };
  try {
    child = fork(path.join(root, 'server/main.ts'), [], {
      cwd: root, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, FACTORY_ROOT: root, FACTORY_VAR: directory, FACTORY_LAYOUT: path.join(directory, 'layout.json'),
        VISLEXICON_ROOT: path.join(directory, 'unconnected'), FACTORY_PORT: '0', FACTORY_TOKEN: token,
        FACTORY_DISCOVERY: '0', FACTORY_PREFLIGHT: '0', FACTORY_HTTP_CACHE: '0', FACTORY_READONLY: '0', FACTORY_START_PAUSED: '0' },
    });
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const backend = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Isolated backend startup timeout: ${output}`)), 30000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Backend exited ${code}: ${output}`)); });
      child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(message.url); } });
    });
    const proxy = { target: backend, changeOrigin: false, headers: { authorization: `Bearer ${token}` } };
    vite = await createServer({ configFile: path.join(root, 'ui/vite.config.ts'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': proxy, '/evidence': proxy } } });
    await vite.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const url = `http://127.0.0.1:${vite.httpServer.address().port}`;
    const request = async (route, body) => {
      const response = await fetch(backend + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
      const result = await response.json();
      if (!response.ok || result.ok === false) throw new Error(`${route} ${response.status}: ${JSON.stringify(result)}`);
      return result;
    };
    return { root, directory, browser, url, request, close, logs: () => output };
  } catch (error) { await close(); throw error; }
}
