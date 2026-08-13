import { buildAcpSubprotocols, validateAcpEndpoint } from "./auth.mjs";
import { ConnectionErrorCode, ConnectionStateError, ConnectionStatus } from "./types.mjs";

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
  #authKey;
  #nextRequestId = 1;
  #pendingRequests = new Map();
  #sessionRequestId = null;
  #connectAttempt = null;
  #listeners = new Set();
  #state = Object.freeze({
    status: ConnectionStatus.DISCONNECTED,
    sessionId: null,
    sessionPending: false,
    error: null,
    capability: null,
  });

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
      this.#connectAttempt = { resolve, reject };
      let socket;
      try {
        socket = this.#webSocketFactory(url.toString(), protocols);
        this.#socket = socket;
      } catch {
        const error = new ConnectionStateError("Unable to open ACP connection", ConnectionErrorCode.CONNECTION_FAILED);
        this.#fail(error.code, error.message);
        return;
      }

      socket.addEventListener("open", () => {
        if (this.#socket !== socket) return;
        if (socket.protocol !== "acp.v1") {
          const error = new ConnectionStateError("ACP did not negotiate the acp.v1 subprotocol", ConnectionErrorCode.PROTOCOL_ERROR);
          this.#fail(error.code, error.message);
          return;
        }
        this.#transition(ConnectionStatus.INITIALIZING);
        void this.#initialize(socket);
      }, { once: true });

      socket.addEventListener("message", (event) => {
        if (this.#socket !== socket) return;
        let frame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          this.#fail(ConnectionErrorCode.PROTOCOL_ERROR, "ACP returned a non-JSON response");
          return;
        }
        this.#settleRequest(frame);
      });

      // Browser WebSocket deliberately hides HTTP handshake status. A 401 and a
      // network refusal therefore become the same safe, non-secret-bearing state.
      socket.addEventListener("error", () => {
        if (this.#socket === socket) this.#fail(ConnectionErrorCode.CONNECTION_FAILED, "Unable to connect to ACP; check the endpoint and pairing key");
      }, { once: true });

      socket.addEventListener("close", () => {
        if (this.#socket !== socket) return;
        if (this.#state.status === ConnectionStatus.CONNECTING || this.#state.status === ConnectionStatus.INITIALIZING) {
          this.#fail(ConnectionErrorCode.CONNECTION_FAILED, "ACP connection closed before initialization completed");
          return;
        }
        this.#clearConnection("ACP connection closed");
      }, { once: true });
    });
  }

  async createSession({ cwd = "/tmp", mcpServers = [] } = {}) {
    if (this.#state.status !== ConnectionStatus.READY || !this.#socket) {
      throw new ConnectionStateError("ACP session/new is only allowed while READY");
    }
    if (this.#sessionRequestId !== null) {
      throw new ConnectionStateError("ACP session/new is already in progress");
    }

    const request = this.#startRequest({
      method: "session/new",
      params: { cwd, mcpServers },
      timeoutMessage: "ACP session creation timed out",
    });
    this.#sessionRequestId = request.id;
    this.#transition(ConnectionStatus.READY, { sessionPending: true });

    try {
      const frame = await request.promise;
      if (frame.error || typeof frame.result?.sessionId !== "string" || !frame.result.sessionId.startsWith("sess_")) {
        throw new ConnectionStateError("ACP did not create a session", ConnectionErrorCode.SESSION_REJECTED);
      }
      this.#transition(ConnectionStatus.READY, { sessionId: frame.result.sessionId, sessionPending: false });
      return frame.result.sessionId;
    } catch (error) {
      if (this.#state.status === ConnectionStatus.READY) {
        this.#transition(ConnectionStatus.READY, {
          sessionPending: false,
          error: { code: error.code ?? ConnectionErrorCode.CONNECTION_FAILED, message: error.message },
        });
      }
      throw error;
    } finally {
      if (this.#sessionRequestId === request.id) {
        this.#sessionRequestId = null;
        if (this.#state.status === ConnectionStatus.READY && this.#state.sessionPending) {
          this.#transition(ConnectionStatus.READY, { sessionPending: false });
        }
      }
    }
  }

  disconnect() {
    const socket = this.#socket;
    this.#clearConnection("ACP connection disconnected");
    if (socket) socket.close();
  }

  async #initialize(socket) {
    const request = this.#startRequest({
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "openab-client", version: "0.1.0" },
      },
      timeoutMessage: "ACP connection timed out",
    });

    try {
      const frame = await request.promise;
      if (frame.error) {
        throw new ConnectionStateError("ACP rejected initialization", ConnectionErrorCode.INITIALIZE_REJECTED);
      }
      if (frame.result?.protocolVersion !== 1 || typeof frame.result?.agentInfo?.name !== "string") {
        throw new ConnectionStateError("ACP returned an incompatible initialize response", ConnectionErrorCode.PROTOCOL_ERROR);
      }

      const capability = Object.freeze({
        protocolVersion: frame.result.protocolVersion,
        agentName: frame.result.agentInfo.name,
        loadSession: Boolean(frame.result.capabilities?.loadSession),
      });
      this.#transition(ConnectionStatus.READY, { capability });
      this.#resolveConnect(capability);
    } catch (error) {
      if (this.#socket === socket) this.#fail(error.code ?? ConnectionErrorCode.CONNECTION_FAILED, error.message);
    }
  }

  #startRequest({ method, params, timeoutMessage }) {
    if (!this.#socket) throw new ConnectionStateError("ACP connection is not active", ConnectionErrorCode.CONNECTION_FAILED);
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;

    let rejectRequest;
    const promise = new Promise((resolve, reject) => {
      rejectRequest = reject;
      const timer = this.#setTimer(() => {
        const pending = this.#pendingRequests.get(id);
        if (!pending) return;
        this.#pendingRequests.delete(id);
        reject(new ConnectionStateError(timeoutMessage, ConnectionErrorCode.TIMEOUT));
      }, this.#timeoutMs);
      this.#pendingRequests.set(id, { resolve, reject, timer });
    });

    try {
      this.#socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    } catch {
      const pending = this.#pendingRequests.get(id);
      this.#pendingRequests.delete(id);
      this.#clearTimer(pending.timer);
      rejectRequest(new ConnectionStateError("ACP connection could not send a request", ConnectionErrorCode.CONNECTION_FAILED));
    }

    return { id, promise };
  }

  #settleRequest(frame) {
    const pending = this.#pendingRequests.get(frame.id);
    if (!pending) return;
    this.#pendingRequests.delete(frame.id);
    this.#clearTimer(pending.timer);
    pending.resolve(frame);
  }

  #rejectAllPending(message, code = ConnectionErrorCode.CONNECTION_FAILED) {
    for (const [id, pending] of this.#pendingRequests) {
      this.#pendingRequests.delete(id);
      this.#clearTimer(pending.timer);
      pending.reject(new ConnectionStateError(message, code));
    }
  }

  #resolveConnect(capability) {
    if (!this.#connectAttempt) return;
    const { resolve } = this.#connectAttempt;
    this.#connectAttempt = null;
    resolve(capability);
  }

  #rejectConnect(message, code) {
    if (!this.#connectAttempt) return;
    const { reject } = this.#connectAttempt;
    this.#connectAttempt = null;
    reject(new ConnectionStateError(message, code));
  }

  #fail(code, message) {
    const socket = this.#socket;
    this.#rejectAllPending(message, code);
    this.#rejectConnect(message, code);
    this.#socket = null;
    this.#authKey = null;
    this.#sessionRequestId = null;
    this.#transition(ConnectionStatus.FAILED, { sessionId: null, sessionPending: false, error: { code, message }, capability: null });
    if (socket) socket.close();
  }

  #clearConnection(message) {
    this.#rejectAllPending(message);
    this.#rejectConnect(message, ConnectionErrorCode.CONNECTION_FAILED);
    this.#socket = null;
    this.#authKey = null;
    this.#sessionRequestId = null;
    this.#transition(ConnectionStatus.DISCONNECTED, { sessionId: null, sessionPending: false, error: null, capability: null });
  }

  #transition(status, patch = {}) {
    const value = (key, fallback) => Object.hasOwn(patch, key) ? patch[key] : fallback;
    this.#state = Object.freeze({
      status,
      sessionId: value("sessionId", status === ConnectionStatus.READY ? this.#state.sessionId : null),
      sessionPending: value("sessionPending", status === ConnectionStatus.READY ? this.#state.sessionPending : false),
      error: value("error", null),
      capability: value("capability", status === ConnectionStatus.READY ? this.#state.capability : null),
    });
    for (const listener of this.#listeners) listener(this.#state);
  }
}
