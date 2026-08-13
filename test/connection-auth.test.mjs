import assert from "node:assert/strict";
import test from "node:test";
import { AcpConnection } from "../src/acp-connection/connection.mjs";
import { ConnectionErrorCode, ConnectionStateError, ConnectionStatus } from "../src/acp-connection/types.mjs";
import { startFakeAcpServer } from "./fixtures/fake-acp-server.mjs";

async function withServer(options, run) {
  const server = await startFakeAcpServer(options);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

test("AC-01: valid pairing initializes and creates a server-minted session", async () => {
  await withServer({}, async (server) => {
    const connection = new AcpConnection({ timeoutMs: 200 });
    const capability = await connection.connect({ endpoint: server.endpoint, authKey: "valid-test-key", allowInsecureLocalhost: true });
    const sessionId = await connection.createSession();

    assert.equal(capability.agentName, "fake-openab");
    assert.equal(sessionId, "sess_fixture_2");
    assert.equal(connection.state.status, ConnectionStatus.READY);
    connection.disconnect();
  });
});

test("AC-02: rejected pairing fails safely without putting the key in the URL", async () => {
  const secret = "invalid-key-must-not-leak";
  await withServer({ mode: "reject" }, async (server) => {
    const connection = new AcpConnection({ timeoutMs: 200 });
    await assert.rejects(
      connection.connect({ endpoint: server.endpoint, authKey: secret, allowInsecureLocalhost: true }),
      ConnectionStateError,
    );
    assert.equal(connection.state.status, ConnectionStatus.FAILED);
    assert.equal(connection.state.error.code, ConnectionErrorCode.CONNECTION_FAILED);
    assert.equal(server.observations.keyInPath, false);
    assert.equal(server.observations.paths.some((path) => path.includes(secret)), false);
    assert.equal(JSON.stringify(connection.state).includes(secret), false);
  });
});

test("AC-03: session/new is rejected until initialization makes the connection READY", async () => {
  const connection = new AcpConnection();
  await assert.rejects(connection.createSession(), ConnectionStateError);
});

test("AC-04: the bearer is offered only as a WebSocket subprotocol, never in the URL", async () => {
  await withServer({}, async (server) => {
    const connection = new AcpConnection({ timeoutMs: 200 });
    await connection.connect({ endpoint: server.endpoint, authKey: "valid-test-key", allowInsecureLocalhost: true });
    assert.equal(server.observations.bearerPresented, true);
    assert.equal(server.observations.keyInPath, false);
    connection.disconnect();
  });
});

test("AC-05: a stalled server reaches a bounded timeout, then the same client can retry with a new key", async () => {
  const connection = new AcpConnection({ timeoutMs: 30 });
  await withServer({ mode: "stall", authKey: "old-key" }, async (server) => {
    await assert.rejects(
      connection.connect({ endpoint: server.endpoint, authKey: "old-key", allowInsecureLocalhost: true }),
      ConnectionStateError,
    );
    assert.equal(connection.state.error.code, ConnectionErrorCode.TIMEOUT);
  });

  await withServer({}, async (server) => {
    await connection.connect({ endpoint: server.endpoint, authKey: "valid-test-key", allowInsecureLocalhost: true });
    assert.equal(connection.state.status, ConnectionStatus.READY);
    connection.disconnect();
  });
});

test("AC-05b: timer adapters are invoked without a browser-host receiver", async () => {
  function browserTimer(...args) {
    assert.equal(this, undefined);
    return setTimeout(...args);
  }
  function browserClearTimer(...args) {
    assert.equal(this, undefined);
    return clearTimeout(...args);
  }

  await withServer({}, async (server) => {
    const connection = new AcpConnection({
      timeoutMs: 200,
      setTimer: browserTimer,
      clearTimer: browserClearTimer,
    });
    await connection.connect({ endpoint: server.endpoint, authKey: "valid-test-key", allowInsecureLocalhost: true });
    assert.equal(connection.state.status, ConnectionStatus.READY);
    connection.disconnect();
  });
});

test("AC-06: server disconnect clears session state and pairing material", async () => {
  await withServer({ mode: "disconnect" }, async (server) => {
    const connection = new AcpConnection({ timeoutMs: 200 });
    await connection.connect({ endpoint: server.endpoint, authKey: "valid-test-key", allowInsecureLocalhost: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(connection.state.status, ConnectionStatus.DISCONNECTED);
    assert.equal(connection.state.sessionId, null);
    assert.equal(connection.state.error, null);
  });
});

test("AC-07: session/new rejects on its own deadline and clears the loading state", async () => {
  await withServer({ mode: "session-stall" }, async (server) => {
    const connection = new AcpConnection({ timeoutMs: 30 });
    await connection.connect({ endpoint: server.endpoint, authKey: "valid-test-key", allowInsecureLocalhost: true });
    await assert.rejects(connection.createSession(), (error) => error.code === ConnectionErrorCode.TIMEOUT);
    assert.equal(connection.state.status, ConnectionStatus.READY);
    assert.equal(connection.state.sessionPending, false);
    assert.equal(connection.state.error.code, ConnectionErrorCode.TIMEOUT);
    connection.disconnect();
  });
});

test("AC-08: a remote close rejects a pending session/new rather than leaving it loading", async () => {
  await withServer({ mode: "session-disconnect" }, async (server) => {
    const connection = new AcpConnection({ timeoutMs: 1_000 });
    await connection.connect({ endpoint: server.endpoint, authKey: "valid-test-key", allowInsecureLocalhost: true });
    await assert.rejects(connection.createSession(), (error) => error.code === ConnectionErrorCode.CONNECTION_FAILED);
    assert.equal(connection.state.status, ConnectionStatus.DISCONNECTED);
    assert.equal(connection.state.sessionPending, false);
  });
});

test("AC-09: explicit disconnect rejects a pending session/new", async () => {
  await withServer({ mode: "session-stall" }, async (server) => {
    const connection = new AcpConnection({ timeoutMs: 200 });
    await connection.connect({ endpoint: server.endpoint, authKey: "valid-test-key", allowInsecureLocalhost: true });
    const session = connection.createSession();
    connection.disconnect();
    await assert.rejects(session, (error) => error.code === ConnectionErrorCode.CONNECTION_FAILED);
    assert.equal(connection.state.status, ConnectionStatus.DISCONNECTED);
  });
});

test("AC-10: concurrent session/new calls are rejected locally while one request is in flight", async () => {
  await withServer({ sessionDelayMs: 25 }, async (server) => {
    const connection = new AcpConnection({ timeoutMs: 200 });
    await connection.connect({ endpoint: server.endpoint, authKey: "valid-test-key", allowInsecureLocalhost: true });
    const first = connection.createSession();
    await assert.rejects(connection.createSession(), ConnectionStateError);
    assert.equal(await first, "sess_fixture_2");
    assert.equal(connection.state.sessionPending, false);
    connection.disconnect();
  });
});

test("AC-11: a late session/new response cannot overwrite a timed-out request", async () => {
  await withServer({ sessionDelayMs: 60 }, async (server) => {
    const connection = new AcpConnection({ timeoutMs: 20 });
    await connection.connect({ endpoint: server.endpoint, authKey: "valid-test-key", allowInsecureLocalhost: true });
    await assert.rejects(connection.createSession(), (error) => error.code === ConnectionErrorCode.TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(connection.state.status, ConnectionStatus.READY);
    assert.equal(connection.state.sessionId, null);
    assert.equal(connection.state.error.code, ConnectionErrorCode.TIMEOUT);
    connection.disconnect();
  });
});

test("AC-12: connection fails when the server does not negotiate acp.v1", async () => {
  await withServer({ mode: "no-subprotocol" }, async (server) => {
    const connection = new AcpConnection({ timeoutMs: 200 });
    await assert.rejects(
      connection.connect({ endpoint: server.endpoint, authKey: "valid-test-key", allowInsecureLocalhost: true }),
      ConnectionStateError,
    );
    assert.equal(connection.state.status, ConnectionStatus.FAILED);
  });
});
