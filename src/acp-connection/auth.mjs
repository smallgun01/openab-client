/**
 * Builds the only permitted browser-side ACP credential transport.
 * The caller owns the key lifetime; this module never writes browser storage.
 */
export function buildAcpSubprotocols(authKey) {
  if (typeof authKey !== "string" || authKey.length === 0) {
    throw new TypeError("ACP authentication key is required");
  }
  return ["acp.v1", `openab.bearer.${authKey}`];
}

export function validateAcpEndpoint(rawEndpoint, { allowInsecureLocalhost = false } = {}) {
  let endpoint;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new TypeError("ACP endpoint must be a valid URL");
  }

  const isLocalhost = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  if (endpoint.protocol === "wss:") return endpoint;
  if (allowInsecureLocalhost && isLocalhost && endpoint.protocol === "ws:") return endpoint;
  throw new TypeError("ACP endpoint must use wss:// (ws:// is only permitted for an explicit localhost fixture)");
}
