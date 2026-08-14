import { createHash } from "node:crypto";
import { createServer } from "node:net";

function acceptFor(key) {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

function frame(payload, opcode = 1) {
  const body = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  if (body.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
  if (body.length < 65_536) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

export function parseFrames(buffer, onFrame) {
  let remaining = buffer;
  while (remaining.length >= 2) {
    const masked = (remaining[1] & 0x80) !== 0;
    const lengthMarker = remaining[1] & 0x7f;
    let length = lengthMarker;
    let lengthBytes = 0;
    if (lengthMarker === 126) {
      if (remaining.length < 4) break;
      length = remaining.readUInt16BE(2);
      lengthBytes = 2;
    }
    if (lengthMarker === 127) {
      if (remaining.length < 10) break;
      const wideLength = remaining.readBigUInt64BE(2);
      if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("fixture frame is too large");
      length = Number(wideLength);
      lengthBytes = 8;
    }
    const header = 2 + lengthBytes + (masked ? 4 : 0);
    if (remaining.length < header + length) break;
    const mask = masked ? remaining.subarray(2 + lengthBytes, 6 + lengthBytes) : null;
    const payload = Buffer.from(remaining.subarray(header, header + length));
    if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    onFrame({ opcode: remaining[0] & 0x0f, payload: payload.toString("utf8") });
    remaining = remaining.subarray(header + length);
  }
  return remaining;
}

/**
 * @typedef {object} PromptContext
 * @property {object} request Parsed session/prompt request.
 * @property {(payload: object) => void} send Send an arbitrary server frame.
 * @property {(text: string, overrides?: object) => void} update Send a text update.
 * @property {(stopReason?: string) => void} finish Settle the prompt request.
 * @property {(code?: number, message?: string) => void} fail Reject the prompt request.
 * @property {() => void} close Close the fixture WebSocket.
 */

/**
 * A deliberately tiny, local ACP fixture; it never logs the bearer protocol.
 * @param {object} [options]
 * @param {(context: PromptContext) => void} [options.promptHandler]
 * @param {(context: object) => void} [options.cancelHandler]
 */
export async function startFakeAcpServer({
  mode = "normal",
  authKey = "valid-test-key",
  sessionDelayMs = 0,
  promptHandler = null,
  cancelHandler = null,
} = {}) {
  const observations = {
    paths: [],
    keyInPath: false,
    bearerPresented: false,
    promptRequests: [],
    cancelNotifications: [],
  };
  const sockets = new Set();
  const activePrompts = new Map();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let handshake = Buffer.alloc(0);
    let upgraded = false;
    let frames = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      if (socket.destroyed || socket.writableEnded) return;
      if (!upgraded) {
        handshake = Buffer.concat([handshake, chunk]);
        const boundary = handshake.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        const request = handshake.subarray(0, boundary).toString("utf8");
        const rest = handshake.subarray(boundary + 4);
        const [requestLine, ...headers] = request.split("\r\n");
        const [, path] = requestLine.split(" ");
        observations.paths.push(path);
        observations.keyInPath ||= path.includes(authKey);
        const headerMap = new Map(headers.map((line) => {
          const delimiter = line.indexOf(":");
          return [line.slice(0, delimiter).toLowerCase(), line.slice(delimiter + 1).trim()];
        }));
        const offered = headerMap.get("sec-websocket-protocol") ?? "";
        const bearerPresented = offered.includes(`openab.bearer.${authKey}`);
        observations.bearerPresented ||= bearerPresented;
        if (mode === "reject" || !bearerPresented) {
          socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        const key = headerMap.get("sec-websocket-key");
        const responseHeaders = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${acceptFor(key)}`,
        ];
        if (mode !== "no-subprotocol") responseHeaders.push("Sec-WebSocket-Protocol: acp.v1");
        responseHeaders.push("\r\n");
        socket.write(responseHeaders.join("\r\n"));
        upgraded = true;
        if (mode === "stall") return;
        if (rest.length) socket.emit("data", rest);
        return;
      }

      if (mode === "stall") return;
      frames = parseFrames(Buffer.concat([frames, chunk]), ({ opcode, payload }) => {
        if (opcode === 8) {
          if (!socket.writableEnded) socket.end(frame("", 8));
          return;
        }
        if (opcode !== 1) return;
        const request = JSON.parse(payload);
        if (request.method === "initialize") {
          if (mode === "protocol-error") {
            socket.write(frame({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 999, agentInfo: { name: "fake-openab" } } }));
          } else {
            socket.write(frame({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentInfo: { name: "fake-openab" }, capabilities: { loadSession: false } } }));
            if (mode === "disconnect") {
              setTimeout(() => {
                if (!socket.destroyed && !socket.writableEnded) socket.end(frame("", 8));
              }, 5);
            }
          }
        }
        if (request.method === "session/new") {
          if (mode === "session-stall") return;
          if (mode === "session-disconnect") {
            socket.end(frame("", 8));
            return;
          }
          const reply = () => {
            if (!socket.destroyed && !socket.writableEnded) socket.write(frame({ jsonrpc: "2.0", id: request.id, result: { sessionId: `sess_fixture_${request.id}` } }));
          };
          if (sessionDelayMs > 0) setTimeout(reply, sessionDelayMs);
          else reply();
        }
        if (request.method === "session/prompt") {
          observations.promptRequests.push(request);
          const sessionId = request.params?.sessionId;
          activePrompts.set(sessionId, request);
          const send = (payload) => {
            if (!socket.destroyed && !socket.writableEnded) socket.write(frame(payload));
          };
          const context = {
            request,
            send,
            update(text, overrides = {}) {
              send({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text },
                    ...overrides,
                  },
                },
              });
            },
            finish(stopReason = "end_turn") {
              activePrompts.delete(sessionId);
              send({ jsonrpc: "2.0", id: request.id, result: { stopReason } });
            },
            fail(code = -32603, message = "fixture prompt error") {
              activePrompts.delete(sessionId);
              send({ jsonrpc: "2.0", id: request.id, error: { code, message } });
            },
            close() {
              if (!socket.destroyed && !socket.writableEnded) socket.end(frame("", 8));
            },
          };
          if (promptHandler) promptHandler(context);
          else {
            context.update("fixture reply");
            context.finish();
          }
        }
        if (request.method === "session/cancel") {
          observations.cancelNotifications.push(request);
          const sessionId = request.params?.sessionId;
          const prompt = activePrompts.get(sessionId);
          const send = (payload) => {
            if (!socket.destroyed && !socket.writableEnded) socket.write(frame(payload));
          };
          const context = {
            request,
            prompt,
            send,
            finish(stopReason = "cancelled") {
              if (!prompt) return;
              activePrompts.delete(sessionId);
              send({ jsonrpc: "2.0", id: prompt.id, result: { stopReason } });
            },
          };
          if (cancelHandler) cancelHandler(context);
          else context.finish();
        }
      });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    endpoint: `ws://127.0.0.1:${address.port}/acp`,
    observations,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
