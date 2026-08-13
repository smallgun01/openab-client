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
    assert.equal(sessionId, "sess_fixture_1");
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

test("AC-03: session/new is rejected until initialization makes the connection READY", () => {
  const connection = new AcpConnection();
  assert.throws(() => connection.createSession(), ConnectionStateError);
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

test("AC-05: a stalled server reaches a bounded timeout, then a new key can retry", async () => {
  await withServer({ mode: "stall", authKey: "old-key" }, async (server) => {
    const connection = new AcpConnection({ timeoutMs: 30 });
    await assert.rejects(
      connection.connect({ endpoint: server.endpoint, authKey: "old-key", allowInsecureLocalhost: true }),
      ConnectionStateError,
    );
    assert.equal(connection.state.error.code, ConnectionErrorCode.TIMEOUT);
  });

  await withServer({}, async (server) => {
    const connection = new AcpConnection({ timeoutMs: 200 });
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
