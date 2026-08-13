import assert from "node:assert/strict";
import test from "node:test";
import { AcpConnection } from "../src/acp-connection/connection.mjs";
import {
  ConnectionStatus,
  TurnErrorCode,
  TurnOutcome,
  TurnStateError,
  TurnStatus,
} from "../src/acp-connection/types.mjs";
import { startFakeAcpServer } from "./fixtures/fake-acp-server.mjs";

async function waitFor(predicate, timeoutMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached before the test deadline");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function withSession(serverOptions, run, connectionOptions = {}) {
  const server = await startFakeAcpServer(serverOptions);
  const connection = new AcpConnection({
    timeoutMs: 200,
    promptTimeoutMs: 200,
    cancelGraceMs: 40,
    ...connectionOptions,
  });
  try {
    await connection.connect({
      endpoint: server.endpoint,
      authKey: "valid-test-key",
      allowInsecureLocalhost: true,
    });
    await connection.createSession();
    await run({ connection, server });
  } finally {
    connection.disconnect();
    await server.close();
  }
}

function cancelFailingWebSocketFactory(url, protocols) {
  const socket = new WebSocket(url, protocols);
  return {
    get protocol() {
      return socket.protocol;
    },
    addEventListener(...args) {
      return socket.addEventListener(...args);
    },
    send(data) {
      const payload = JSON.parse(String(data));
      if (payload.method === "session/cancel") throw new Error("fixture cancel send failure");
      return socket.send(data);
    },
    close() {
      return socket.close();
    },
  };
}

test("CHAT-01: one text chunk and end_turn complete one agent reply", async () => {
  await withSession({
    promptHandler({ update, finish }) {
      update("Hello back");
      finish("end_turn");
    },
  }, async ({ connection, server }) => {
    const transitions = [];
    connection.subscribeTurn((state) => transitions.push(state.status));
    const result = await connection.sendPrompt("Hello");

    assert.deepEqual(result, {
      outcome: TurnOutcome.COMPLETED,
      stopReason: "end_turn",
      text: "Hello back",
    });
    assert.deepEqual(server.observations.promptRequests[0].params.prompt, [{ type: "text", text: "Hello" }]);
    assert.deepEqual(transitions, [TurnStatus.IDLE, TurnStatus.WAITING, TurnStatus.STREAMING, TurnStatus.SETTLED, TurnStatus.IDLE]);
    assert.equal(connection.state.status, ConnectionStatus.READY);
  });
});

test("CHAT-02: ordered chunks append once without duplication", async () => {
  await withSession({
    promptHandler({ update, finish }) {
      update("one ");
      update("two ");
      update("three");
      finish();
    },
  }, async ({ connection }) => {
    const result = await connection.sendPrompt("count");
    assert.equal(result.text, "one two three");
  });
});

test("CHAT-03: CJK and emoji chunks remain intact", async () => {
  await withSession({
    promptHandler({ update, finish }) {
      update("你好，");
      update("世界");
      update(" 🧙🏼‍♂️✨");
      finish();
    },
  }, async ({ connection }) => {
    const result = await connection.sendPrompt("Unicode");
    assert.equal(result.text, "你好，世界 🧙🏼‍♂️✨");
  });
});

test("CHAT-04: a terminal response with no chunk completes an empty reply", async () => {
  await withSession({ promptHandler: ({ finish }) => finish() }, async ({ connection }) => {
    const result = await connection.sendPrompt("silent");
    assert.equal(result.outcome, TurnOutcome.COMPLETED);
    assert.equal(result.text, "");
  });
});

test("CHAT-05: pinned and future stop reasons map without breaking the connection", async () => {
  const expected = new Map([
    ["end_turn", TurnOutcome.COMPLETED],
    ["max_tokens", TurnOutcome.COMPLETED_LIMIT],
    ["max_turn_requests", TurnOutcome.COMPLETED_LIMIT],
    ["refusal", TurnOutcome.REFUSED],
    ["cancelled", TurnOutcome.CANCELLED],
  ]);
  await withSession({
    promptHandler({ request, finish }) {
      finish(request.params.prompt[0].text);
    },
  }, async ({ connection }) => {
    for (const [stopReason, outcome] of expected) {
      const result = await connection.sendPrompt(stopReason);
      assert.equal(result.stopReason, stopReason);
      assert.equal(result.outcome, outcome);
    }
    const future = await connection.sendPrompt("future_stop_reason");
    assert.equal(future.stopReason, "future_stop_reason");
    assert.equal(future.outcome, TurnOutcome.UNKNOWN);
    assert.equal(connection.state.status, ConnectionStatus.READY);
  });
});

test("CHAT-06: a JSON-RPC error clears the turn and exposes only safe core copy", async () => {
  await withSession({
    promptHandler({ fail }) {
      fail(-32603, "provider-secret-bearing-fixture-detail");
    },
  }, async ({ connection }) => {
    const transitions = [];
    connection.subscribeTurn((state) => transitions.push(state));
    await assert.rejects(
      connection.sendPrompt("fail"),
      (error) => error instanceof TurnStateError
        && error.code === TurnErrorCode.PROMPT_REJECTED
        && !error.message.includes("provider-secret"),
    );
    const interrupted = transitions.find((state) => state.status === TurnStatus.INTERRUPTED);
    assert.equal(interrupted.error.code, TurnErrorCode.PROMPT_REJECTED);
    assert.equal(JSON.stringify(interrupted).includes("provider-secret"), false);
    assert.equal(connection.turnState.status, TurnStatus.IDLE);
  });
});

test("CHAT-06b: OpenAB busy code maps to a safe, distinct turn error", async () => {
  await withSession({
    promptHandler({ fail }) {
      fail(-32001, "sensitive upstream busy detail");
    },
  }, async ({ connection }) => {
    await assert.rejects(
      connection.sendPrompt("busy"),
      (error) => error.code === TurnErrorCode.PROMPT_BUSY
        && !error.message.includes("sensitive upstream"),
    );
    assert.equal(connection.state.status, ConnectionStatus.READY);
  });
});

test("CHAT-07: an idle prompt deadline clears pending state and permits the next turn", async () => {
  let promptCount = 0;
  await withSession({
    promptHandler({ update, finish }) {
      promptCount += 1;
      if (promptCount === 1) return;
      update("recovered");
      finish();
    },
  }, async ({ connection }) => {
    await assert.rejects(
      connection.sendPrompt("stall"),
      (error) => error.code === TurnErrorCode.TIMEOUT,
    );
    const result = await connection.sendPrompt("retry");
    assert.equal(result.text, "recovered");
    assert.equal(connection.turnState.status, TurnStatus.IDLE);
  }, { promptTimeoutMs: 100 });
});

test("CHAT-08: disconnect preserves partial text as an interrupted turn", async () => {
  await withSession({
    promptHandler({ update, close }) {
      update("partial answer");
      setTimeout(close, 5);
    },
  }, async ({ connection }) => {
    const transitions = [];
    connection.subscribeTurn((state) => transitions.push(state));
    await assert.rejects(
      connection.sendPrompt("disconnect"),
      (error) => error.code === TurnErrorCode.CONNECTION_FAILED,
    );
    const interrupted = transitions.find((state) => state.status === TurnStatus.INTERRUPTED);
    assert.equal(interrupted.text, "partial answer");
    assert.equal(connection.state.status, ConnectionStatus.DISCONNECTED);
  });
});

test("CHAT-09: Stop sends one no-id cancel and settles on the prompt response", async () => {
  await withSession({
    promptHandler({ update }) {
      update("before stop");
    },
  }, async ({ connection, server }) => {
    const prompt = connection.sendPrompt("stop me");
    await waitFor(() => connection.turnState.status === TurnStatus.STREAMING);
    assert.equal(connection.cancelPrompt(), true);
    const result = await prompt;

    assert.equal(result.outcome, TurnOutcome.CANCELLED);
    assert.equal(result.text, "before stop");
    assert.equal(server.observations.cancelNotifications.length, 1);
    assert.equal(Object.hasOwn(server.observations.cancelNotifications[0], "id"), false);
  });
});

test("CHAT-09b: cancel send failure fences only the turn and keeps the connection READY", async () => {
  let promptContext;
  await withSession({
    promptHandler(context) {
      promptContext = context;
      context.update("safe partial");
    },
  }, async ({ connection }) => {
    const transitions = [];
    connection.subscribeTurn((state) => transitions.push(state));
    const prompt = connection.sendPrompt("cancel send fails");
    await waitFor(() => connection.turnState.status === TurnStatus.STREAMING);

    assert.equal(connection.cancelPrompt(), false);
    await assert.rejects(prompt, (error) => error.code === TurnErrorCode.CANCEL_FAILED);
    assert.equal(connection.state.status, ConnectionStatus.READY);

    promptContext.update("late");
    promptContext.finish("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 15));
    const interrupted = transitions.find((state) => state.status === TurnStatus.INTERRUPTED);
    assert.equal(interrupted.text, "safe partial");
    assert.equal(interrupted.error.code, TurnErrorCode.CANCEL_FAILED);
    assert.equal(transitions.some((state) => state.text.includes("late")), false);
  }, { webSocketFactory: cancelFailingWebSocketFactory });
});

test("CHAT-09c: a second Stop while CANCELLING is rejected locally", async () => {
  await withSession({ promptHandler: ({ update }) => update("before stop") }, async ({ connection, server }) => {
    const prompt = connection.sendPrompt("stop once");
    await waitFor(() => connection.turnState.status === TurnStatus.STREAMING);
    assert.equal(connection.cancelPrompt(), true);
    assert.throws(
      () => connection.cancelPrompt(),
      (error) => error.code === TurnErrorCode.NOT_READY,
    );
    assert.equal((await prompt).outcome, TurnOutcome.CANCELLED);
    assert.equal(server.observations.cancelNotifications.length, 1);
  });
});

test("CHAT-09d: disconnect while CANCELLING preserves partial text as interrupted", async () => {
  let promptContext;
  await withSession({
    promptHandler(context) {
      promptContext = context;
      context.update("partial before cancel");
    },
    cancelHandler() {},
  }, async ({ connection }) => {
    const transitions = [];
    connection.subscribeTurn((state) => transitions.push(state));
    const prompt = connection.sendPrompt("cancel then disconnect");
    await waitFor(() => connection.turnState.status === TurnStatus.STREAMING);
    connection.cancelPrompt();
    assert.equal(connection.turnState.status, TurnStatus.CANCELLING);
    promptContext.close();

    await assert.rejects(prompt, (error) => error.code === TurnErrorCode.CONNECTION_FAILED);
    const interrupted = transitions.find((state) => state.status === TurnStatus.INTERRUPTED);
    assert.equal(interrupted.text, "partial before cancel");
    assert.equal(connection.state.status, ConnectionStatus.DISCONNECTED);
  });
});

test("CHAT-10: absent cancel confirmation reaches local cancellation and fences late frames", async () => {
  let promptContext;
  await withSession({
    promptHandler(context) {
      promptContext = context;
      context.update("kept");
    },
    cancelHandler() {},
  }, async ({ connection }) => {
    const transitions = [];
    connection.subscribeTurn((state) => transitions.push(state));
    const prompt = connection.sendPrompt("local stop");
    await waitFor(() => connection.turnState.status === TurnStatus.STREAMING);
    connection.cancelPrompt();
    const result = await prompt;
    assert.equal(result.outcome, TurnOutcome.CANCELLED_LOCAL);
    assert.equal(result.text, "kept");

    promptContext.update("late");
    promptContext.finish("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 15));
    const streamingTexts = transitions.filter((state) => state.status === TurnStatus.STREAMING).map((state) => state.text);
    assert.deepEqual(streamingTexts, ["kept"]);
    assert.equal(connection.turnState.status, TurnStatus.IDLE);
  }, { cancelGraceMs: 20 });
});

test("CHAT-11: chunks and responses after settlement cannot mutate the turn", async () => {
  let promptContext;
  await withSession({
    promptHandler(context) {
      promptContext = context;
      context.update("final");
      context.finish();
    },
  }, async ({ connection }) => {
    const transitions = [];
    connection.subscribeTurn((state) => transitions.push(state));
    const result = await connection.sendPrompt("settle");
    promptContext.update("late");
    promptContext.send({ jsonrpc: "2.0", id: promptContext.request.id, result: { stopReason: "refusal" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(result, { outcome: TurnOutcome.COMPLETED, stopReason: "end_turn", text: "final" });
    assert.deepEqual(
      transitions.filter((state) => state.status === TurnStatus.STREAMING).map((state) => state.text),
      ["final"],
    );
  });
});

test("CHAT-12: a concurrent prompt is rejected locally without a second wire request", async () => {
  await withSession({ promptHandler() {} }, async ({ connection, server }) => {
    const first = connection.sendPrompt("first");
    await waitFor(() => server.observations.promptRequests.length === 1);
    await assert.rejects(
      connection.sendPrompt("second"),
      (error) => error.code === TurnErrorCode.PROMPT_IN_PROGRESS,
    );
    assert.equal(server.observations.promptRequests.length, 1);
    connection.cancelPrompt();
    assert.equal((await first).outcome, TurnOutcome.CANCELLED);
  });
});

test("CHAT-13: wrong-session and unsupported updates are ignored", async () => {
  await withSession({
    promptHandler({ request, send, update, finish }) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_someone_else",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wrong" } },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: { sessionUpdate: "tool_call", title: "ignored" },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "ignored" } },
        },
      });
      update("accepted");
      finish();
    },
  }, async ({ connection }) => {
    const result = await connection.sendPrompt("filter");
    assert.equal(result.text, "accepted");
  });
});

test("CHAT-14: empty and over-1-MiB prompts are rejected before wire send", async () => {
  await withSession({}, async ({ connection, server }) => {
    await assert.rejects(
      connection.sendPrompt("   \n\t"),
      (error) => error.code === TurnErrorCode.INVALID_PROMPT,
    );
    await assert.rejects(
      connection.sendPrompt("x".repeat(1 << 20)),
      (error) => error.code === TurnErrorCode.FRAME_TOO_LARGE,
    );
    assert.equal(server.observations.promptRequests.length, 0);

    const result = await connection.sendPrompt("within limit");
    assert.equal(result.text, "fixture reply");
    assert.equal(server.observations.promptRequests.length, 1);
  });
});

test("CHAT-14b: streamed text is capped by UTF-8 bytes and late frames are fenced", async () => {
  let promptContext;
  await withSession({
    promptHandler(context) {
      promptContext = context;
      context.update("A😀BC");
    },
  }, async ({ connection }) => {
    const transitions = [];
    connection.subscribeTurn((state) => transitions.push(state));
    const prompt = connection.sendPrompt("bounded output");
    await assert.rejects(prompt, (error) => error.code === TurnErrorCode.OUTPUT_TOO_LARGE);

    const interrupted = transitions.find((state) => state.status === TurnStatus.INTERRUPTED);
    assert.equal(interrupted.text, "A😀B");
    assert.equal(new TextEncoder().encode(interrupted.text).byteLength, 6);
    assert.equal(connection.state.status, ConnectionStatus.READY);

    promptContext.update("late");
    promptContext.finish();
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(transitions.some((state) => state.text.includes("late")), false);
  }, { maxTurnTextBytes: 6 });
});
