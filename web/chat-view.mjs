import {
  ConnectionStatus,
  TurnErrorCode,
  TurnOutcome,
  TurnStatus,
} from "../src/acp-connection/types.mjs";

const SAFE_TURN_ERRORS = Object.freeze({
  [TurnErrorCode.NOT_READY]: "Create a ready session before sending a message.",
  [TurnErrorCode.INVALID_PROMPT]: "Enter a non-empty message.",
  [TurnErrorCode.PROMPT_IN_PROGRESS]: "Wait for the current response before sending again.",
  [TurnErrorCode.FRAME_TOO_LARGE]: "This message is too large for the current runtime.",
  [TurnErrorCode.OUTPUT_TOO_LARGE]: "The response exceeded the local text limit and was interrupted.",
  [TurnErrorCode.PROMPT_REJECTED]: "The runtime rejected this message.",
  [TurnErrorCode.PROMPT_BUSY]: "The runtime is already processing another message.",
  [TurnErrorCode.PROTOCOL_ERROR]: "The runtime returned an incompatible response.",
  [TurnErrorCode.TIMEOUT]: "The response timed out while waiting for more text.",
  [TurnErrorCode.CONNECTION_FAILED]: "The response was interrupted by a connection change.",
  [TurnErrorCode.CANCEL_FAILED]: "The stop request could not be sent; this response was interrupted.",
});

const OUTCOME_STATUS = Object.freeze({
  [TurnOutcome.COMPLETED]: "Response complete.",
  [TurnOutcome.COMPLETED_LIMIT]: "Response stopped at the runtime limit.",
  [TurnOutcome.REFUSED]: "The runtime refused this request.",
  [TurnOutcome.CANCELLED]: "Stopped waiting. Remote work may continue.",
  [TurnOutcome.CANCELLED_LOCAL]: "Stopped waiting locally. Remote work may continue.",
  [TurnOutcome.UNKNOWN]: "The response ended with an unrecognized outcome.",
});

/** Pure connection/turn-to-chat mapping. Raw exception text is never returned. */
export function chatView(connectionState, turnState) {
  const sessionReady = connectionState.status === ConnectionStatus.READY
    && typeof connectionState.sessionId === "string"
    && connectionState.sessionId.length > 0;
  const active = [TurnStatus.WAITING, TurnStatus.STREAMING, TurnStatus.CANCELLING].includes(turnState.status);
  const base = {
    statusText: sessionReady ? "Ready to chat" : "Create a session to begin",
    errorText: "",
    tone: sessionReady ? "ready" : "neutral",
    canSend: sessionReady && turnState.status === TurnStatus.IDLE,
    canStop: false,
    inputLocked: !sessionReady || active,
  };

  switch (turnState.status) {
    case TurnStatus.WAITING:
      return { ...base, statusText: "Waiting for response…", tone: "working", canSend: false, canStop: true, inputLocked: true };
    case TurnStatus.STREAMING:
      return { ...base, statusText: "Receiving response…", tone: "working", canSend: false, canStop: true, inputLocked: true };
    case TurnStatus.CANCELLING:
      return { ...base, statusText: "Stop requested; waiting locally…", tone: "working", canSend: false, canStop: false, inputLocked: true };
    case TurnStatus.SETTLED:
      return {
        ...base,
        statusText: OUTCOME_STATUS[turnState.outcome] ?? "Response ended.",
        tone: turnState.outcome === TurnOutcome.REFUSED ? "failed" : "ready",
        canSend: false,
      };
    case TurnStatus.INTERRUPTED:
      return {
        ...base,
        statusText: "Response interrupted.",
        errorText: SAFE_TURN_ERRORS[turnState.error?.code] ?? "The response was interrupted safely.",
        tone: "failed",
        canSend: false,
      };
    default:
      return base;
  }
}
