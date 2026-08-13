export const ConnectionStatus = Object.freeze({
  DISCONNECTED: "DISCONNECTED",
  CONNECTING: "CONNECTING",
  INITIALIZING: "INITIALIZING",
  READY: "READY",
  FAILED: "FAILED",
});

export const ConnectionErrorCode = Object.freeze({
  INVALID_ENDPOINT: "INVALID_ENDPOINT",
  CONNECTION_FAILED: "CONNECTION_FAILED",
  INITIALIZE_REJECTED: "INITIALIZE_REJECTED",
  PROTOCOL_ERROR: "PROTOCOL_ERROR",
  TIMEOUT: "TIMEOUT",
  SESSION_REJECTED: "SESSION_REJECTED",
});

export class ConnectionStateError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = "ConnectionStateError";
    this.code = code;
  }
}
