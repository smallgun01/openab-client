import { buildAcpSubprotocols, validateAcpEndpoint } from "./auth.mjs";
import { ConnectionErrorCode, ConnectionStateError, ConnectionStatus } from "./types.mjs";

const INITIALIZE_ID = 1;
const SESSION_NEW_ID = 2;

/**
 * Browser-compatible ACP connection state machine.
 * Secrets deliberately remain private and only for the active socket lifetime.
 */
export class AcpConnection {
  #webSocketFactory;
  #setTimer;
  #clearTimer;
  #timeoutMs;
  #socket;
  #timer;
  #authKey;
  #listeners = new Set();
  #state = Object.freeze({ status: ConnectionStatus.DISCONNECTED, sessionId: null, error: null, capability: null });

  constructor({ webSocketFactory = (url, protocols) => new WebSocket(url, protocols), timeoutMs = 10_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be a positive number");
    this.#webSocketFactory = webSocketFactory;
    this.#timeoutMs = timeoutMs;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  get state() {
    return this.#state;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  connect({ endpoint, authKey, allowInsecureLocalhost = false }) {
    if (this.#socket) throw new ConnectionStateError("A connection attempt is already active");

    let url;
    try {
      url = validateAcpEndpoint(endpoint, { allowInsecureLocalhost });
    } catch (error) {
      this.#transition(ConnectionStatus.FAILED, { error: { code: ConnectionErrorCode.INVALID_ENDPOINT, message: error.message } });
      return Promise.reject(error);
    }

    let protocols;
    try {
      protocols = buildAcpSubprotocols(authKey);
    } catch (error) {
      this.#transition(ConnectionStatus.FAILED, { error: { code: ConnectionErrorCode.INVALID_ENDPOINT, message: error.message } });
      return Promise.reject(error);
    }

    this.#authKey = authKey;
    this.#transition(ConnectionStatus.CONNECTING);

    return new Promise((resolve, reject) => {
      let settled = false;
      const settleReject = (code, message) => {
        if (settled) return;
        settled = true;
        this.#fail(code, message);
        reject(new ConnectionStateError(message));
      };
      const settleResolve = (result) => {
        if (settled) return;
        settled = true;
        this.#clearDeadline();
        resolve(result);
      };

      try {
        this.#socket = this.#webSocketFactory(url.toString(), protocols);
      } catch {
        settleReject(ConnectionErrorCode.CONNECTION_FAILED, "Unable to open ACP connection");
        return;
      }

      this.#timer = this.#setTimer(() => {
        settleReject(ConnectionErrorCode.TIMEOUT, "ACP connection timed out");
      }, this.#timeoutMs);

      this.#socket.addEventListener("open", () => {
        if (settled) return;
        this.#transition(ConnectionStatus.INITIALIZING);
        this.#send({
          jsonrpc: "2.0",
          id: INITIALIZE_ID,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "openab-client", version: "0.1.0" },
          },
        }, settleReject);
      }, { once: true });

      this.#socket.addEventListener("message", (event) => {
        if (settled) return;
        let frame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          settleReject(ConnectionErrorCode.PROTOCOL_ERROR, "ACP returned a non-JSON response");
          return;
        }

        if (frame.id !== INITIALIZE_ID) return;
        if (frame.error) {
          settleReject(ConnectionErrorCode.INITIALIZE_REJECTED, "ACP rejected initialization");
          return;
        }
        if (frame.result?.protocolVersion !== 1 || typeof frame.result?.agentInfo?.name !== "string") {
          settleReject(ConnectionErrorCode.PROTOCOL_ERROR, "ACP returned an incompatible initialize response");
          return;
        }

        const capability = Object.freeze({
          protocolVersion: frame.result.protocolVersion,
          agentName: frame.result.agentInfo.name,
          loadSession: Boolean(frame.result.capabilities?.loadSession),
        });
        this.#transition(ConnectionStatus.READY, { capability });
        settleResolve(capability);
      });

      // Browser WebSocket deliberately hides HTTP handshake status. A 401 and a
      // network refusal therefore become the same safe, non-secret-bearing state.
      this.#socket.addEventListener("error", () => {
        settleReject(ConnectionErrorCode.CONNECTION_FAILED, "Unable to connect to ACP; check the endpoint and pairing key");
      }, { once: true });

      this.#socket.addEventListener("close", () => {
        if (!settled) {
          settleReject(ConnectionErrorCode.CONNECTION_FAILED, "ACP connection closed before initialization completed");
          return;
        }
        if (this.#state.status !== ConnectionStatus.FAILED) this.#clearConnection();
      });
    });
  }

  createSession({ cwd = "/tmp", mcpServers = [] } = {}) {
    if (this.#state.status !== ConnectionStatus.READY || !this.#socket) {
      throw new ConnectionStateError("ACP session/new is only allowed while READY");
    }

    return new Promise((resolve, reject) => {
      const onMessage = (event) => {
        let frame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (frame.id !== SESSION_NEW_ID) return;
        this.#socket.removeEventListener("message", onMessage);
        if (frame.error || typeof frame.result?.sessionId !== "string" || !frame.result.sessionId.startsWith("sess_")) {
          this.#transition(ConnectionStatus.READY, { error: { code: ConnectionErrorCode.SESSION_REJECTED, message: "ACP did not create a session" } });
          reject(new ConnectionStateError("ACP did not create a session"));
          return;
        }
        this.#transition(ConnectionStatus.READY, { sessionId: frame.result.sessionId });
        resolve(frame.result.sessionId);
      };
      this.#socket.addEventListener("message", onMessage);
      this.#send({ jsonrpc: "2.0", id: SESSION_NEW_ID, method: "session/new", params: { cwd, mcpServers } }, (code, message) => {
        this.#socket.removeEventListener("message", onMessage);
        reject(new ConnectionStateError(message));
      });
    });
  }

  disconnect() {
    this.#clearDeadline();
    if (this.#socket) this.#socket.close();
    this.#clearConnection();
  }

  #send(frame, onFailure) {
    try {
      this.#socket.send(JSON.stringify(frame));
    } catch {
      onFailure(ConnectionErrorCode.CONNECTION_FAILED, "ACP connection could not send a request");
    }
  }

  #fail(code, message) {
    this.#clearDeadline();
    if (this.#socket) this.#socket.close();
    this.#socket = null;
    this.#authKey = null;
    this.#transition(ConnectionStatus.FAILED, { sessionId: null, error: { code, message }, capability: null });
  }

  #clearDeadline() {
    if (this.#timer) this.#clearTimer(this.#timer);
    this.#timer = null;
  }

  #clearConnection() {
    this.#clearDeadline();
    this.#socket = null;
    this.#authKey = null;
    this.#transition(ConnectionStatus.DISCONNECTED, { sessionId: null, error: null, capability: null });
  }

  #transition(status, patch = {}) {
    this.#state = Object.freeze({
      status,
      sessionId: patch.sessionId ?? (status === ConnectionStatus.READY ? this.#state.sessionId : null),
      error: patch.error ?? null,
      capability: patch.capability ?? (status === ConnectionStatus.READY ? this.#state.capability : null),
    });
    for (const listener of this.#listeners) listener(this.#state);
  }
}
