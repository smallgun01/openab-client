import { buildAcpSubprotocols, validateAcpEndpoint } from "./auth.mjs";
import {
  ConnectionErrorCode,
  ConnectionStateError,
  ConnectionStatus,
  TurnErrorCode,
  TurnOutcome,
  TurnStateError,
  TurnStatus,
} from "./types.mjs";

const MAX_METHOD_FRAME_BYTES = 1 << 20;
const DEFAULT_MAX_TURN_TEXT_BYTES = 1 << 20;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const STOP_REASON_OUTCOMES = Object.freeze({
  end_turn: TurnOutcome.COMPLETED,
  max_tokens: TurnOutcome.COMPLETED_LIMIT,
  max_turn_requests: TurnOutcome.COMPLETED_LIMIT,
  refusal: TurnOutcome.REFUSED,
  cancelled: TurnOutcome.CANCELLED,
});

/**
 * Browser-compatible ACP connection state machine.
 * Secrets deliberately remain private and only for the active socket lifetime.
 */
export class AcpConnection {
  #webSocketFactory;
  #setTimer;
  #clearTimer;
  #timeoutMs;
  #promptTimeoutMs;
  #cancelGraceMs;
  #maxTurnTextBytes;
  #socket;
  #authKey;
  #nextRequestId = 1;
  #pendingRequests = new Map();
  #sessionRequestId = null;
  #connectAttempt = null;
  #listeners = new Set();
  #turnListeners = new Set();
  #activeTurn = null;
  #state = Object.freeze({
    status: ConnectionStatus.DISCONNECTED,
    sessionId: null,
    sessionPending: false,
    error: null,
    capability: null,
  });
  #turnState = Object.freeze({
    status: TurnStatus.IDLE,
    text: "",
    outcome: null,
    stopReason: null,
    error: null,
  });

  constructor({
    webSocketFactory = (url, protocols) => new WebSocket(url, protocols),
    timeoutMs = 10_000,
    promptTimeoutMs = 180_000,
    cancelGraceMs = 5_000,
    maxTurnTextBytes = DEFAULT_MAX_TURN_TEXT_BYTES,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be a positive number");
    if (!Number.isFinite(promptTimeoutMs) || promptTimeoutMs < 1) throw new TypeError("promptTimeoutMs must be a positive number");
    if (!Number.isFinite(cancelGraceMs) || cancelGraceMs < 1) throw new TypeError("cancelGraceMs must be a positive number");
    if (!Number.isSafeInteger(maxTurnTextBytes) || maxTurnTextBytes < 1) throw new TypeError("maxTurnTextBytes must be a positive safe integer");
    this.#webSocketFactory = webSocketFactory;
    this.#timeoutMs = timeoutMs;
    this.#promptTimeoutMs = promptTimeoutMs;
    this.#cancelGraceMs = cancelGraceMs;
    this.#maxTurnTextBytes = maxTurnTextBytes;
    // Browser host functions may reject a class instance as their receiver
    // (`Illegal invocation`). Call injected/default timers as plain functions.
    this.#setTimer = (...args) => setTimer(...args);
    this.#clearTimer = (...args) => clearTimer(...args);
  }

  get state() {
    return this.#state;
  }

  get turnState() {
    return this.#turnState;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  subscribeTurn(listener) {
    this.#turnListeners.add(listener);
    listener(this.#turnState);
    return () => this.#turnListeners.delete(listener);
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
        if (frame?.method === "session/update") {
          this.#handleSessionUpdate(frame);
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

  async sendPrompt(text) {
    if (this.#state.status !== ConnectionStatus.READY || !this.#socket || !this.#state.sessionId) {
      throw new TurnStateError("ACP prompt requires a ready session", TurnErrorCode.NOT_READY);
    }
    if (this.#activeTurn) {
      throw new TurnStateError("An ACP prompt is already in progress", TurnErrorCode.PROMPT_IN_PROGRESS);
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new TurnStateError("Prompt must contain text", TurnErrorCode.INVALID_PROMPT);
    }

    const sessionId = this.#state.sessionId;
    const request = this.#startRequest({
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text }] },
      timeoutMessage: "ACP prompt timed out",
      timeoutMs: this.#promptTimeoutMs,
      maxFrameBytes: MAX_METHOD_FRAME_BYTES,
    });
    const turn = {
      requestId: request.id,
      sessionId,
      text: "",
      textBytes: 0,
      cancelTimer: null,
    };
    this.#activeTurn = turn;
    this.#transitionTurn(TurnStatus.WAITING);

    try {
      const frame = await request.promise;
      if (frame.error) {
        if (frame.error.code === -32001) {
          throw new TurnStateError("ACP is already processing a prompt", TurnErrorCode.PROMPT_BUSY);
        }
        throw new TurnStateError("ACP rejected the prompt", TurnErrorCode.PROMPT_REJECTED);
      }
      const stopReason = frame.result?.stopReason;
      if (typeof stopReason !== "string" || stopReason.length === 0) {
        throw new TurnStateError("ACP returned an invalid prompt result", TurnErrorCode.PROTOCOL_ERROR);
      }
      const outcome = STOP_REASON_OUTCOMES[stopReason] ?? TurnOutcome.UNKNOWN;
      const result = Object.freeze({ outcome, stopReason, text: turn.text });
      this.#transitionTurn(TurnStatus.SETTLED, result);
      return result;
    } catch (error) {
      if (error?.code === TurnErrorCode.CANCELLED_LOCAL) {
        const result = Object.freeze({
          outcome: TurnOutcome.CANCELLED_LOCAL,
          stopReason: null,
          text: turn.text,
        });
        this.#transitionTurn(TurnStatus.SETTLED, result);
        return result;
      }

      const turnError = this.#asTurnError(error);
      this.#transitionTurn(TurnStatus.INTERRUPTED, {
        text: turn.text,
        error: { code: turnError.code, message: turnError.message },
      });
      throw turnError;
    } finally {
      if (this.#activeTurn?.requestId === request.id) {
        if (turn.cancelTimer !== null) this.#clearTimer(turn.cancelTimer);
        this.#activeTurn = null;
        this.#transitionTurn(TurnStatus.IDLE);
      }
    }
  }

  cancelPrompt() {
    const turn = this.#activeTurn;
    if (this.#state.status !== ConnectionStatus.READY || !this.#socket
      || !turn || ![TurnStatus.WAITING, TurnStatus.STREAMING].includes(this.#turnState.status)) {
      throw new TurnStateError("There is no cancellable ACP prompt", TurnErrorCode.NOT_READY);
    }

    try {
      this.#socket.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: turn.sessionId },
      }));
    } catch {
      const error = new TurnStateError("ACP cancellation could not be sent", TurnErrorCode.CANCEL_FAILED);
      this.#rejectPendingRequest(turn.requestId, error);
      throw error;
    }

    this.#suspendRequestDeadline(turn.requestId);
    this.#transitionTurn(TurnStatus.CANCELLING, { text: turn.text });
    turn.cancelTimer = this.#setTimer(() => {
      this.#rejectPendingRequest(
        turn.requestId,
        new TurnStateError("ACP cancellation confirmation timed out", TurnErrorCode.CANCELLED_LOCAL),
      );
    }, this.#cancelGraceMs);
    return true;
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

  #startRequest({ method, params, timeoutMessage, timeoutMs = this.#timeoutMs, maxFrameBytes = null }) {
    if (!this.#socket) throw new ConnectionStateError("ACP connection is not active", ConnectionErrorCode.CONNECTION_FAILED);
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const wire = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (maxFrameBytes !== null && new TextEncoder().encode(wire).byteLength > maxFrameBytes) {
      throw new TurnStateError("ACP prompt exceeds the supported frame size", TurnErrorCode.FRAME_TOO_LARGE);
    }

    let rejectRequest;
    const promise = new Promise((resolve, reject) => {
      rejectRequest = reject;
      const pending = { resolve, reject, timer: null, timeoutMs, timeoutMessage };
      this.#pendingRequests.set(id, pending);
      this.#armRequestDeadline(id, pending);
    });

    try {
      this.#socket.send(wire);
    } catch {
      const pending = this.#pendingRequests.get(id);
      this.#pendingRequests.delete(id);
      if (pending?.timer !== null && pending?.timer !== undefined) this.#clearTimer(pending.timer);
      rejectRequest(new ConnectionStateError("ACP connection could not send a request", ConnectionErrorCode.CONNECTION_FAILED));
    }

    return { id, promise };
  }

  #settleRequest(frame) {
    if (!frame || typeof frame !== "object") return;
    const pending = this.#pendingRequests.get(frame.id);
    if (!pending) return;
    this.#pendingRequests.delete(frame.id);
    if (pending.timer !== null) this.#clearTimer(pending.timer);
    pending.resolve(frame);
  }

  #handleSessionUpdate(frame) {
    const turn = this.#activeTurn;
    if (!turn || ![TurnStatus.WAITING, TurnStatus.STREAMING].includes(this.#turnState.status)) return;
    const params = frame.params;
    const update = params?.update;
    if (params?.sessionId !== turn.sessionId) return;
    if (update?.sessionUpdate !== "agent_message_chunk") return;
    if (update.content?.type !== "text" || typeof update.content.text !== "string" || update.content.text.length === 0) return;

    const chunk = update.content.text;
    const encodedChunk = TEXT_ENCODER.encode(chunk);
    const chunkBytes = encodedChunk.byteLength;
    const remainingBytes = this.#maxTurnTextBytes - turn.textBytes;
    if (chunkBytes > remainingBytes) {
      if (remainingBytes > 0) {
        const { prefix, usedBytes } = takeUtf8Prefix(encodedChunk, remainingBytes);
        turn.text += prefix;
        turn.textBytes += usedBytes;
        this.#transitionTurn(TurnStatus.STREAMING, { text: turn.text });
      }
      this.#rejectPendingRequest(
        turn.requestId,
        new TurnStateError("ACP response exceeded the supported text size", TurnErrorCode.OUTPUT_TOO_LARGE),
      );
      return;
    }

    turn.text += chunk;
    turn.textBytes += chunkBytes;
    this.#refreshRequestDeadline(turn.requestId);
    this.#transitionTurn(TurnStatus.STREAMING, { text: turn.text });
  }

  #armRequestDeadline(id, pending) {
    pending.timer = this.#setTimer(() => {
      const current = this.#pendingRequests.get(id);
      if (current !== pending) return;
      this.#pendingRequests.delete(id);
      pending.timer = null;
      pending.reject(new ConnectionStateError(pending.timeoutMessage, ConnectionErrorCode.TIMEOUT));
    }, pending.timeoutMs);
  }

  #refreshRequestDeadline(id) {
    const pending = this.#pendingRequests.get(id);
    if (!pending) return;
    if (pending.timer !== null) this.#clearTimer(pending.timer);
    this.#armRequestDeadline(id, pending);
  }

  #suspendRequestDeadline(id) {
    const pending = this.#pendingRequests.get(id);
    if (!pending || pending.timer === null) return;
    this.#clearTimer(pending.timer);
    pending.timer = null;
  }

  #rejectPendingRequest(id, error) {
    const pending = this.#pendingRequests.get(id);
    if (!pending) return;
    this.#pendingRequests.delete(id);
    if (pending.timer !== null) this.#clearTimer(pending.timer);
    pending.reject(error);
  }

  #rejectAllPending(message, code = ConnectionErrorCode.CONNECTION_FAILED) {
    for (const [id, pending] of this.#pendingRequests) {
      this.#pendingRequests.delete(id);
      if (pending.timer !== null) this.#clearTimer(pending.timer);
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
    this.#clearCancelTimer();
    this.#rejectAllPending(message, code);
    this.#rejectConnect(message, code);
    this.#socket = null;
    this.#authKey = null;
    this.#sessionRequestId = null;
    this.#transition(ConnectionStatus.FAILED, { sessionId: null, sessionPending: false, error: { code, message }, capability: null });
    if (socket) socket.close();
  }

  #clearConnection(message) {
    this.#clearCancelTimer();
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

  #transitionTurn(status, patch = {}) {
    const value = (key, fallback) => Object.hasOwn(patch, key) ? patch[key] : fallback;
    this.#turnState = Object.freeze({
      status,
      text: value("text", status === TurnStatus.IDLE ? "" : this.#turnState.text),
      outcome: value("outcome", null),
      stopReason: value("stopReason", null),
      error: value("error", null),
    });
    for (const listener of this.#turnListeners) listener(this.#turnState);
  }

  #clearCancelTimer() {
    if (this.#activeTurn?.cancelTimer !== null && this.#activeTurn?.cancelTimer !== undefined) {
      this.#clearTimer(this.#activeTurn.cancelTimer);
      this.#activeTurn.cancelTimer = null;
    }
  }

  #asTurnError(error) {
    if (error instanceof TurnStateError) return error;
    if (error?.code === ConnectionErrorCode.TIMEOUT) {
      return new TurnStateError("ACP prompt timed out", TurnErrorCode.TIMEOUT);
    }
    return new TurnStateError("ACP prompt was interrupted", TurnErrorCode.CONNECTION_FAILED);
  }
}

function takeUtf8Prefix(encodedText, maxBytes) {
  let usedBytes = Math.min(encodedText.byteLength, maxBytes);
  while (usedBytes > 0 && (encodedText[usedBytes] & 0xc0) === 0x80) usedBytes -= 1;
  return {
    prefix: TEXT_DECODER.decode(encodedText.subarray(0, usedBytes)),
    usedBytes,
  };
}
