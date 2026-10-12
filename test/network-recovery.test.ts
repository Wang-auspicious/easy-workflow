import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../shared/failures.ts';
import { transientNetworkError } from '../server/network.ts';

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
