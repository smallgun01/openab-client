# ACP connection and authentication contract — v0

This is the acceptance contract for the shared Web/Desktop/Mobile connection core. It records the smallest verified wire contract between OpenAB Client and the OpenAB ACP server; it is not a claim that every product capability exists upstream.

## Connection

- Transport: JSON-RPC 2.0 over WebSocket at `GET /acp`.
- Client offers the `acp.v1` WebSocket subprotocol.
- A non-loopback endpoint requires an ACP authentication key. Browser clients send it as the `openab.bearer.<token>` WebSocket subprotocol, rather than in a URL.
- The key is supplied by an operator-owned secret boundary. It must never be persisted in browser storage, emitted in logs, or rendered in the UI.
- Production endpoints must use `wss://`. `ws://` is accepted only when an explicit local test fixture opts in.

## State machine

```text
DISCONNECTED
  └─ connect(endpoint, short-lived key) → CONNECTING
CONNECTING
  ├─ socket open → INITIALIZING
  └─ network / handshake rejection / timeout → FAILED
INITIALIZING
  ├─ ACP initialize v1 succeeds → READY
  └─ ACP error / incompatible response → FAILED
READY
  ├─ session/new succeeds → READY + server-minted sessionId
  ├─ socket close → DISCONNECTED (clear key + session)
  └─ explicit disconnect → DISCONNECTED (clear key + session)
FAILED
  └─ retry requires a new explicit connect call and new key → CONNECTING
```

The browser WebSocket API intentionally does **not** expose an HTTP status from a failed upgrade. Therefore a handshake `401`, DNS failure, TLS failure, and other connection refusals must all land in safe `FAILED/CONNECTION_FAILED`; v0 must not pretend it can reliably label a failure `AUTH_FAILED`. A future pairing API or an ACP-level authenticated error frame can add that distinction.

## Minimal lifecycle

```text
WebSocket connect
  → initialize(protocolVersion: 1)
  ← protocolVersion: 1, agentInfo: openab
  → session/new(cwd, mcpServers: [])
  ← sessionId: sess_<server-generated-id>
WebSocket close
```

The local preflight verified this lifecycle against a fixed OpenAB image twice without sending a prompt or model request.

## Explicit non-guarantees

- `session/prompt` is not exercised by this harness; it reaches the downstream LLM CLI and belongs to the valid-key runtime smoke gate.
- ACP base advertises `loadSession: false`; Client history replay needs a separate event/history design.
- Structured tool activity, pairing, multi-device identity, tenant isolation, retention, export, and deletion are product work, not inferred from ACP transport availability.

## Harness acceptance

The v0 implementation is accepted only when all six automated cases pass:

| Case | Required outcome |
| --- | --- |
| AC-01 | A valid local fixture completes `initialize → session/new` and retains a server-minted `sess_` ID only while connected. |
| AC-02 | A handshake rejection reaches `FAILED/CONNECTION_FAILED`; the key appears in neither state nor URL. |
| AC-03 | `session/new` before `READY` is rejected locally, without sending a wire request. |
| AC-04 | The key is offered only as the bearer subprotocol, never in the request URL. |
| AC-05 | A silent server reaches the configured deadline; a fresh explicit connection with a new key can succeed. |
| AC-06 | A remote close clears the in-memory session and returns to `DISCONNECTED`. |

Run the deterministic fixture suite with `npm test` (no dependencies are installed). Run `npm run test:e2e` for the local-only real OpenAB runtime E2E. Both send no prompt and print no authentication key.

## Explicit v0 non-goals

- No browser storage, device pairing persistence, token refresh, history replay, multi-device identity, or automatic reconnect.
- No provider credential, model prompt, tool call, AWS resource, or public endpoint.
- The static Web skeleton is not yet wired to this core. Its next slice may display connection state, but it may not introduce a second connection implementation.
