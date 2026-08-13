import assert from "node:assert/strict";
import test from "node:test";
import { ConnectionErrorCode, ConnectionStatus } from "../src/acp-connection/types.mjs";
import { connectionView } from "../web/connection-view.mjs";

function state(status, patch = {}) {
  return {
    status,
    sessionId: null,
    sessionPending: false,
    error: null,
    capability: null,
    ...patch,
  };
}

test("UI-01: disconnected state leaves the form editable and actions guarded", () => {
  const view = connectionView(state(ConnectionStatus.DISCONNECTED));
  assert.equal(view.statusText, "Not connected");
  assert.equal(view.formLocked, false);
  assert.equal(view.canDisconnect, false);
  assert.equal(view.canCreateSession, false);
});

test("UI-02: connecting and initializing lock credentials but remain cancellable", () => {
  for (const status of [ConnectionStatus.CONNECTING, ConnectionStatus.INITIALIZING]) {
    const view = connectionView(state(status));
    assert.equal(view.formLocked, true);
    assert.equal(view.canDisconnect, true);
    assert.equal(view.canCreateSession, false);
  }
});

test("UI-03: READY exposes capability and permits only one session action", () => {
  const ready = connectionView(state(ConnectionStatus.READY, {
    capability: { protocolVersion: 1, agentName: "fake-openab" },
  }));
  assert.equal(ready.statusText, "Ready");
  assert.match(ready.detailText, /fake-openab/);
  assert.equal(ready.canCreateSession, true);

  const pending = connectionView(state(ConnectionStatus.READY, { sessionPending: true }));
  assert.equal(pending.sessionText, "Creating session…");
  assert.equal(pending.canCreateSession, false);

  const created = connectionView(state(ConnectionStatus.READY, { sessionId: "sess_fixture_2" }));
  assert.match(created.sessionText, /sess_fixture_2/);
  assert.equal(created.canCreateSession, false);
});

test("UI-04: safe error mapping never echoes an arbitrary core message", () => {
  const secret = "pairing-key-must-not-render";
  const view = connectionView(state(ConnectionStatus.FAILED, {
    error: { code: ConnectionErrorCode.CONNECTION_FAILED, message: secret },
  }));
  assert.equal(view.statusText, "Connection failed");
  assert.equal(view.errorText.includes(secret), false);
  assert.match(view.errorText, /endpoint and pairing key/);
});

test("UI-05: session errors do not mislabel a healthy ACP connection", () => {
  const view = connectionView(state(ConnectionStatus.READY, {
    capability: { protocolVersion: 1, agentName: "fake-openab" },
    error: { code: ConnectionErrorCode.TIMEOUT, message: "internal detail" },
  }));
  assert.equal(view.statusText, "Ready");
  assert.match(view.errorText, /request deadline/);
  assert.equal(view.canCreateSession, true);
});
