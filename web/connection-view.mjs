import { ConnectionErrorCode, ConnectionStatus } from "../src/acp-connection/types.mjs";

const SAFE_ERRORS = Object.freeze({
  [ConnectionErrorCode.INVALID_ENDPOINT]: "Enter a valid secure ACP endpoint and pairing key.",
  [ConnectionErrorCode.CONNECTION_FAILED]: "Unable to connect. Check the endpoint and pairing key, then retry.",
  [ConnectionErrorCode.INITIALIZE_REJECTED]: "The runtime rejected ACP initialization.",
  [ConnectionErrorCode.PROTOCOL_ERROR]: "The runtime is not compatible with this ACP client.",
  [ConnectionErrorCode.TIMEOUT]: "The runtime did not respond before the request deadline.",
  [ConnectionErrorCode.SESSION_REJECTED]: "The runtime did not create a session.",
});

/** Pure state-to-screen mapping. It never accepts or returns pairing material. */
export function connectionView(state) {
  const base = {
    statusText: "Not connected",
    detailText: "Enter an ACP endpoint and a short-lived pairing key.",
    sessionText: "No session.",
    errorText: state.error ? (SAFE_ERRORS[state.error.code] ?? "The ACP request failed safely.") : "",
    tone: "neutral",
    formLocked: false,
    canDisconnect: false,
    canCreateSession: false,
  };

  switch (state.status) {
    case ConnectionStatus.CONNECTING:
      return {
        ...base,
        statusText: "Connecting…",
        detailText: "Opening a secure WebSocket to the runtime.",
        tone: "working",
        formLocked: true,
        canDisconnect: true,
      };
    case ConnectionStatus.INITIALIZING:
      return {
        ...base,
        statusText: "Initializing ACP…",
        detailText: "The runtime is connected; protocol compatibility is being verified.",
        tone: "working",
        formLocked: true,
        canDisconnect: true,
      };
    case ConnectionStatus.READY: {
      const agentName = state.capability?.agentName ?? "OpenAB runtime";
      const sessionText = state.sessionPending
        ? "Creating session…"
        : state.sessionId
          ? `Session ready: ${state.sessionId}`
          : "Connected. Create a session when ready.";
      return {
        ...base,
        statusText: "Ready",
        detailText: `${agentName} negotiated ACP v${state.capability?.protocolVersion ?? 1}.`,
        sessionText,
        tone: "ready",
        formLocked: true,
        canDisconnect: true,
        canCreateSession: !state.sessionPending && !state.sessionId,
      };
    }
    case ConnectionStatus.FAILED:
      return {
        ...base,
        statusText: "Connection failed",
        detailText: "Review the safe error below. Pairing material was not retained in the form.",
        tone: "failed",
      };
    default:
      return base;
  }
}
