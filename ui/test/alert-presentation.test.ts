import assert from "node:assert/strict";
import test from "node:test";
import { emptyBrowser } from "../../shared/browser.ts";
import type { Alert } from "../../shared/types.ts";
import type { CandidateRecovery } from "../../shared/failures.ts";
import { alertPresentation } from "../src/shell/alert-presentation.ts";

const oldAlert: Alert = { id: "old-alert", level: "red", kind: "auth", item: "angular-ui", url: "https://angular-ui.github.com", message: "angular-ui.github.com 连不上：net::ERR_CONNECTION_CLOSED", nextAction: "请登录" };

test("legacy network alerts are never presented as login work for the user", () => {
  const recovery: CandidateRecovery = { item: "angular-ui", token: "token-1", title: "Angular UI", source: "fixture", url: oldAlert.url!, disposition: "retry", at: 1, attempts: 1, failure: { tag: "network_connection", category: "network", owner: "system", retryable: true, message: oldAlert.message } };
  const view = alertPresentation(oldAlert, { "angular-ui": recovery }, emptyBrowser());
  assert.equal(view.requiresUser, false);
  assert.equal(view.label, "连接中断");
  assert.equal(view.title, "Angular UI");
  assert.ok(!view.nextAction!.includes("请登录"));
});

test("a historical auth label alone cannot prove the public page still requires login", () => {
  const view = alertPresentation({ ...oldAlert, message: "页面需要登录或验证" }, {}, emptyBrowser());
  assert.equal(view.requiresUser, false);
  assert.equal(view.label, "访问状态待复核");
});

test("a current browser login/challenge observation identifies an actual user action and its exact tab", () => {
  const browser = { ...emptyBrowser(), tabs: [{ id: "exact-tab", title: "ProtoPie account", url: "https://example.test/login", loading: false, owner: "agent" as const, attention: "需要登录", attentionKind: "auth" as const }] };
  const view = alertPresentation({ ...oldAlert, tab: "exact-tab" }, {}, browser);
  assert.equal(view.requiresUser, true);
  assert.equal(view.label, "登录");
  assert.equal(view.tab, "exact-tab");
});

test('same-named workflow alerts use the exact token and never guess an anonymous item match', () => {
  const first: CandidateRecovery = {key: 'first', item: 'same', token: 'first-token', title: 'First workflow',
    source: 'fixture', url: 'https://first.test/', disposition: 'retry', at: 1, attempts: 1,
    failure: {tag: 'network_timeout', category: 'network', retryable: true, message: 'First timed out'}};
  const second: CandidateRecovery = {...first, key: 'second', token: 'second-token', title: 'Second workflow',
    url: 'https://second.test/', failure: {tag: 'network_dns', category: 'network', retryable: true, message: 'Second DNS failed'}};
  const records = {first, second};
  const alert: Alert = {id: 'second-alert', kind: 'auth', level: 'red', item: 'same', token: 'second-token', message: 'Exact second alert'};
  const exact = alertPresentation(alert, records, emptyBrowser());
  assert.equal(exact.title, second.title);
  assert.equal(exact.url, second.url);
  assert.equal(exact.message, second.failure!.message);
  const unknown = alertPresentation({...alert, token: undefined}, records, emptyBrowser());
  assert.equal(unknown.title, 'same');
  assert.equal(unknown.url, undefined);
  assert.equal(unknown.message, alert.message);
});
