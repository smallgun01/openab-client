import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectionStatus,
  TurnErrorCode,
  TurnOutcome,
  TurnStatus,
} from "../src/acp-connection/types.mjs";
import { chatView } from "../web/chat-view.mjs";

function connectionState(patch = {}) {
  return { status: ConnectionStatus.DISCONNECTED, sessionId: null, ...patch };
}

function turnState(patch = {}) {
  return { status: TurnStatus.IDLE, text: "", outcome: null, error: null, ...patch };
}

test("UI-06: chat remains guarded until a READY session exists", () => {
  assert.equal(chatView(connectionState(), turnState()).canSend, false);
  const ready = chatView(
    connectionState({ status: ConnectionStatus.READY, sessionId: "sess_fixture_2" }),
    turnState(),
  );
  assert.equal(ready.canSend, true);
  assert.equal(ready.inputLocked, false);
});

test("UI-07: Send and Stop follow the accepted turn-state guards", () => {
  const connection = connectionState({ status: ConnectionStatus.READY, sessionId: "sess_fixture_2" });
  for (const status of [TurnStatus.WAITING, TurnStatus.STREAMING]) {
    const view = chatView(connection, turnState({ status }));
    assert.equal(view.canSend, false);
    assert.equal(view.canStop, true);
    assert.equal(view.inputLocked, true);
  }
  const cancelling = chatView(connection, turnState({ status: TurnStatus.CANCELLING }));
  assert.equal(cancelling.canStop, false);
  assert.match(cancelling.statusText, /waiting locally/);
});

test("UI-08: turn errors map to fixed safe copy", () => {
  const secret = "provider-secret-bearing-detail";
  const view = chatView(
    connectionState({ status: ConnectionStatus.READY, sessionId: "sess_fixture_2" }),
    turnState({
      status: TurnStatus.INTERRUPTED,
      error: { code: TurnErrorCode.PROMPT_REJECTED, message: secret },
    }),
  );
  assert.equal(view.errorText.includes(secret), false);
  assert.match(view.errorText, /runtime rejected/);
});

test("UI-09: cancellation copy does not promise remote computation stopped", () => {
  const view = chatView(
    connectionState({ status: ConnectionStatus.READY, sessionId: "sess_fixture_2" }),
    turnState({ status: TurnStatus.SETTLED, outcome: TurnOutcome.CANCELLED_LOCAL }),
  );
  assert.match(view.statusText, /Remote work may continue/);
});
