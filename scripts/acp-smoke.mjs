#!/usr/bin/env node
/**
 * Minimal, model-free ACP smoke harness.
 * Requires a pre-started OpenAB /acp endpoint. It never prints the auth key.
 */
const url = process.env.OPENAB_ACP_URL;
const authKey = process.env.OPENAB_ACP_AUTH_KEY;
const deadlineMs = Number.parseInt(process.env.OPENAB_ACP_DEADLINE_MS ?? "15000", 10);

if (!url || !authKey) {
  console.error("OPENAB_ACP_URL and OPENAB_ACP_AUTH_KEY are required");
  process.exit(2);
}

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("ACP deadline exceeded")), deadlineMs);
  const socket = new WebSocket(url, ["acp.v1", `openab.bearer.${authKey}`]);
  let stage = "connect";

  const fail = (message) => {
    clearTimeout(timer);
    socket.close();
    reject(new Error(message));
  };

  socket.addEventListener("error", () => fail(`WebSocket error during ${stage}`), { once: true });
  socket.addEventListener("open", () => {
    stage = "initialize";
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "openab-client-smoke", version: "0.1.0" },
      },
    }));
  });
  socket.addEventListener("message", (event) => {
    let frame;
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      fail("ACP emitted a non-JSON frame");
      return;
    }
    if (frame.id === 1) {
      if (frame.result?.protocolVersion !== 1 || frame.result?.agentInfo?.name !== "openab") {
        fail("unexpected initialize response");
        return;
      }
      stage = "session/new";
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: "/tmp", mcpServers: [] },
      }));
    } else if (frame.id === 2) {
      if (typeof frame.result?.sessionId !== "string" || !frame.result.sessionId.startsWith("sess_")) {
        fail("session/new did not return a server-minted session id");
        return;
      }
      clearTimeout(timer);
      socket.close();
      console.log(JSON.stringify({ protocolVersion: 1, agent: "openab", sessionCreated: true }));
      resolve();
    }
  });
});
