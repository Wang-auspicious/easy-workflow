import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../shared/failures.ts';
import { transientNetworkError } from '../server/network.ts';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {ProxyAgent, fetch as undiciFetch} from 'undici';
import * as pi from '../server/pi.ts';

test('model POST reconnects once only when the local proxy drops TLS before HTTP bytes', {timeout: 10000}, async () => {
  let connections = 0;
  let dropTls = 1;
  let status = 200;
  let mode = 'normal';
  const bodies: string[] = [];
  const sockets = new Set<net.Socket>();
  // Public fixture key only; never installed in a system trust store.
  const cert = fs.readFileSync(new URL('./fixtures/model-transport-cert.pem', import.meta.url));
  const origin = https.createServer({cert,
    key: fs.readFileSync(new URL('./fixtures/model-transport-key.pem', import.meta.url))}, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    bodies.push(body);
    if (mode === 'request-reset') {req.socket.destroy(); return;}
    if (mode === 'redirect') {
      dropTls = 1;
      res.writeHead(307, {location: '/redirected', connection: 'close'});
      res.end();
      return;
    }
    res.writeHead(status, {'content-type': 'text/plain'});
    if (mode === 'stream-reset') {
      res.flushHeaders();
      res.write('partial');
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end('received once');
  });
  const proxy = http.createServer();
  for (const server of [origin, proxy]) server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  proxy.on('connect', (_req, socket) => {
    connections++;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (dropTls > 0) {
      dropTls--;
      socket.once('data', chunk => {
        assert.equal(chunk[0], 0x16, 'the failed tunnel contains TLS handshake, not an HTTP POST');
        socket.destroy();
      });
      return;
    }
    const upstream = net.connect((origin.address() as net.AddressInfo).port, '127.0.0.1');
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.pipe(socket).pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const agents: ProxyAgent[] = [];
  const makeAgent = (trusted = true) => {
    const agent = new ProxyAgent({uri: `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`,
      ...(trusted ? {requestTls: {ca: cert}} : {})});
    agents.push(agent);
    return agent;
  };
  let calls = 0;
  const sender = (agent: ProxyAgent): typeof fetch => (input, init) => {
    calls++;
    return undiciFetch(input as Parameters<typeof undiciFetch>[0],
      {...init, dispatcher: agent} as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
  };
  const send = sender(makeAgent());
  try {
    const request = {method: 'POST', body: '{"fixture":"one paid request"}',
      signal: AbortSignal.timeout(5000)};
    const response = await pi.fetchModelRequest('https://fixture.invalid/v1/response', request, send);
    assert.equal(await response.text(), 'received once');
    assert.equal(connections, 2);
    assert.deepEqual(bodies, [request.body], 'the first failed connection never reached the HTTPS application');
    assert.equal(calls, 2, 'there is precisely one additional connection attempt');

    for (const code of [401, 429, 500, 503]) {
      status = code;
      const before: number = calls;
      const response = await pi.fetchModelRequest('https://fixture.invalid/v1/response', request, send);
      assert.equal(response.status, code);
      await response.text();
      assert.equal(calls, before + 1, `HTTP ${code} is never retried by connection recovery`);
    }
    status = 200;
    for (const nextMode of ['request-reset', 'stream-reset', 'redirect']) {
      mode = nextMode;
      const before: number = calls;
      await assert.rejects(async () => {
        const response = await pi.fetchModelRequest('https://fixture.invalid/v1/response', request, send);
        await response.text();
      });
      assert.equal(calls, before + 1, `${mode} cannot replay a possibly received POST`);
    }
    mode = 'normal';
    dropTls = 0;
    let before: number = calls;
    await assert.rejects(pi.fetchModelRequest('https://fixture.invalid/v1/response', request, sender(makeAgent(false))));
    assert.equal(calls, before + 1, 'certificate validation failures are never retried');

    dropTls = Infinity;
    before = calls;
    await assert.rejects(pi.fetchModelRequest('https://fixture.invalid/v1/response', request, sender(makeAgent())));
    assert.equal(calls, before + 2, 'a second pre-TLS failure cannot start a third connection attempt');

    before = calls;
    await assert.rejects(pi.fetchModelRequest(new Request('https://fixture.invalid/v1/response', request), undefined, sender(makeAgent())));
    assert.equal(calls, before + 1, 'Request bodies are conservatively treated as non-replayable');

    const abort = new AbortController();
    const abortSend = sender(makeAgent());
    before = calls;
    await assert.rejects(pi.fetchModelRequest('https://fixture.invalid/v1/response', {...request, signal: abort.signal},
      async (input, init) => {
        try {return await abortSend(input, init);} catch (error) {abort.abort(); throw error;}
      }));
    assert.equal(calls, before + 1, 'the original abort/deadline prevents a subsequent connection');
  } finally {
    await Promise.all(agents.map(agent => agent.destroy()));
    for (const socket of sockets) socket.destroy();
    await Promise.all([origin, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
});

test('a reset before TLS establishment is recoverable networking, not certificate failure', () => {
  const reset = new Error('fetch failed', { cause: Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' }) });
  const failure = classifyFailure(reset);
  assert.equal(failure.tag, 'network_connection');
  assert.equal(failure.owner, 'system');
  assert.match(failure.nextAction!, /共享浏览器/);
  assert.equal(transientNetworkError(reset), true);
});

test('actual certificate and SSL protocol failures stay blocked', () => {
  for (const [code, message] of [['CERT_HAS_EXPIRED', 'certificate has expired'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'Hostname does not match certificate'], ['ERR_SSL_PROTOCOL_ERROR', 'SSL protocol error']]) {
    const error = new Error('fetch failed', { cause: Object.assign(new Error(message), { code }) });
    assert.equal(classifyFailure(error).tag, 'network_tls');
    assert.equal(classifyFailure(error).owner, 'user');
    assert.equal(transientNetworkError(error), false);
  }
});

test('a model SDK connection error stays recoverable without being mislabeled as a website failure', () => {
  const failure = classifyFailure(new Error('Connection error.（已自动重试一次）'), { stage: 'model' });
  assert.equal(failure.tag, 'model_transport');
  assert.equal(failure.owner, 'system');
  assert.equal(failure.retryable, true);
  assert.equal(classifyFailure(new Error('Unknown submit property'), { stage: 'model' }).tag, 'tool_error');
});
