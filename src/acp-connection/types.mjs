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

export const TurnStatus = Object.freeze({
  IDLE: "IDLE",
  WAITING: "WAITING",
  STREAMING: "STREAMING",
  CANCELLING: "CANCELLING",
  SETTLED: "SETTLED",
  INTERRUPTED: "INTERRUPTED",
});

export const TurnOutcome = Object.freeze({
  COMPLETED: "COMPLETED",
  COMPLETED_LIMIT: "COMPLETED_LIMIT",
  REFUSED: "REFUSED",
  CANCELLED: "CANCELLED",
  CANCELLED_LOCAL: "CANCELLED_LOCAL",
});

export const TurnErrorCode = Object.freeze({
  NOT_READY: "NOT_READY",
  INVALID_PROMPT: "INVALID_PROMPT",
  PROMPT_IN_PROGRESS: "PROMPT_IN_PROGRESS",
  FRAME_TOO_LARGE: "FRAME_TOO_LARGE",
  PROMPT_REJECTED: "PROMPT_REJECTED",
  PROTOCOL_ERROR: "PROTOCOL_ERROR",
  TIMEOUT: "TIMEOUT",
  CONNECTION_FAILED: "CONNECTION_FAILED",
  CANCELLED_LOCAL: "CANCELLED_LOCAL",
});

export class ConnectionStateError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = "ConnectionStateError";
    this.code = code;
  }
}

export class TurnStateError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = "TurnStateError";
    this.code = code;
  }
}
