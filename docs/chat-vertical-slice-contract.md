# Chat vertical slice contract — v0

**Status:** Accepted contract. CHAT-01..14 core behavior is implemented locally; CHAT-15 browser rendering and provider-backed runtime smoke are not included yet.

This contract defines the smallest useful chat turn on top of the accepted ACP connection core. It is deliberately narrower than the full ACP schema: one connected session, one text prompt in flight, streamed text output, bounded cancellation, and deterministic settlement.

## Verified upstream baseline

The wire claims below are pinned to `openabdev/openab` commit [`448b05f`](https://github.com/openabdev/openab/tree/448b05fbcc17d1ebe52fdc8f78344018bd50b080). The source of truth is its generated ACP v1 schema, ACP method matrix, WebSocket ADR, server adapter, and smoke driver:

- [`acp-v1.schema.json`](https://github.com/openabdev/openab/blob/448b05fbcc17d1ebe52fdc8f78344018bd50b080/crates/openab-gateway/schemas/acp-v1.schema.json)
- [`acp-official-methods.md`](https://github.com/openabdev/openab/blob/448b05fbcc17d1ebe52fdc8f78344018bd50b080/docs/acp-official-methods.md)
- [`acp-server-websocket-base.md`](https://github.com/openabdev/openab/blob/448b05fbcc17d1ebe52fdc8f78344018bd50b080/docs/adr/acp-server-websocket-base.md)
- [`acp_server.rs`](https://github.com/openabdev/openab/blob/448b05fbcc17d1ebe52fdc8f78344018bd50b080/crates/openab-gateway/src/adapters/acp_server.rs)
- [`acp-ws-smoke.py`](https://github.com/openabdev/openab/blob/448b05fbcc17d1ebe52fdc8f78344018bd50b080/scripts/acp-ws-smoke.py)

Confirmed behavior at that revision:

- ACP wire version is `protocolVersion: 1`; upstream schema is v1.19.0.
- `session/prompt` is a JSON-RPC request and returns `{ stopReason }` on the original request ID.
- Text arrives through `session/update` notifications using `agent_message_chunk`.
- `session/cancel` is a one-way notification with no `id`.
- The current OpenAB base normally hands over a complete backend reply as one terminal text chunk, but the Client must accept multiple ordered chunks because that is the ACP streaming shape and the adapter already supports deltas.
- OpenAB enforces one in-flight prompt per session (`-32001` when busy), up to 32 prompts per connection, a 1 MiB ceiling for method-bearing frames, and a 180-second per-chunk backend idle timeout.

## Scope

v0 supports only:

- one existing `sessionId` created by the accepted connection core;
- one active prompt per session;
- one non-empty text content block per user turn;
- zero or more ordered agent text chunks;
- terminal success, refusal, limit, cancellation, JSON-RPC error, deadline, or disconnect;
- a local Stop action that sends `session/cancel` exactly once.

It does not support images, audio, embedded resources, resource links, tool activity, thoughts, plans, usage display, Markdown/HTML rendering, history replay, persistence, automatic retry, simultaneous turns, or deployment controls.

## Wire contract

### Prompt request

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_<server-generated-id>",
    "prompt": [
      { "type": "text", "text": "Hello" }
    ]
  }
}
```

The request ID must come from the existing dynamic request registry. The serialized UTF-8 JSON-RPC frame must not exceed 1,048,576 bytes, matching the pinned OpenAB method-frame ceiling. Empty or whitespace-only input is rejected locally without sending a frame.

### Text update

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_<server-generated-id>",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "Hello back" }
    }
  }
}
```

The Client appends only text chunks whose `params.sessionId` matches the active session. `messageId` is optional in ACP and is not required by v0. Updates for another session, unsupported `sessionUpdate` variants, non-text content, and updates received after a turn settles are ignored without changing connection state.

### Terminal response

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": { "stopReason": "end_turn" }
}
```

The response settles only the matching request ID. v0 handles every stop reason in the pinned schema:

| `stopReason` | Client outcome |
| --- | --- |
| `end_turn` | `COMPLETED` |
| `max_tokens` | `COMPLETED_LIMIT` |
| `max_turn_requests` | `COMPLETED_LIMIT` |
| `refusal` | `REFUSED` |
| `cancelled` | `CANCELLED` |

An unknown non-empty string stop reason settles as `UNKNOWN` while preserving the raw reason for diagnostics and forward compatibility. A missing or non-string stop reason remains a turn-level `PROTOCOL_ERROR`, not a connection failure.

### Cancellation

```json
{
  "jsonrpc": "2.0",
  "method": "session/cancel",
  "params": { "sessionId": "sess_<server-generated-id>" }
}
```

This frame has no `id`, receives no direct response, and is emitted at most once for the active turn. The Client enters `CANCELLING` and waits for the original `session/prompt` response with `stopReason:"cancelled"`. A separate bounded cancellation grace timer prevents the UI from waiting forever; expiry settles the local turn as `CANCELLED_LOCAL` and fences all late frames. If the cancel notification cannot be sent, only that turn is interrupted with `CANCEL_FAILED`; the Client fences its late frames but does not classify or close an otherwise `READY` connection.

**Critical limitation:** at the pinned OpenAB revision, cancellation releases the gateway waiter but does not propagate to the downstream agent/model. The backend may continue computing and consuming provider quota. Therefore the UI label may say “Stop displaying” or “Stop waiting”; it must not promise that remote computation or billing stopped.

## Turn state machine

Connection state and turn state remain separate axes.

```text
IDLE
  └─ sendPrompt(text) → WAITING
WAITING
  ├─ first valid text chunk → STREAMING
  ├─ terminal response → SETTLED → IDLE
  ├─ Stop → CANCELLING
  └─ error / deadline / disconnect → INTERRUPTED → IDLE
STREAMING
  ├─ more valid text chunks → STREAMING
  ├─ terminal response → SETTLED → IDLE
  ├─ Stop → CANCELLING
  └─ error / deadline / disconnect → INTERRUPTED → IDLE
CANCELLING
  ├─ prompt response(cancelled) → SETTLED → IDLE
  ├─ disconnect → INTERRUPTED → IDLE
  └─ cancel grace expires → CANCELLED_LOCAL → IDLE
```

Rules:

- Only one turn may be active. A second `sendPrompt` is rejected locally and sends nothing.
- Input and Send are disabled while a turn is active; Stop is enabled only in `WAITING` or `STREAMING`.
- Each active turn owns its request ID, session ID, bounded accumulated text, idle timer, and optional cancel timer. v0 caps accumulated UTF-8 agent text at 1 MiB; overflow preserves only the valid prefix within the cap, interrupts the turn with `OUTPUT_TOO_LARGE`, and fences late frames.
- Every settlement path clears both timers and removes the pending request exactly once.
- A prompt idle deadline is mandatory and injectable for deterministic tests. `promptTimeoutMs` is a **per-chunk idle deadline** that refreshes after each accepted text chunk; it is not an absolute wall-clock bound, so a continuously streaming turn can exceed that duration. v0 has no separate absolute turn deadline. The production default must be chosen with knowledge of OpenAB's current 180-second backend idle timeout; this contract does not silently hard-code a shorter product deadline.
- JSON-RPC busy code `-32001` maps to safe turn error `PROMPT_BUSY`; other server error messages remain redacted behind `PROMPT_REJECTED`.
- JSON-RPC errors, deadline, and disconnect are turn failures. They do not overwrite the connection state machine's own classification.
- Partial output survives interruption and receives a fixed safe status such as “Response interrupted.” Raw server or exception text is never rendered.

## Rendering and secret boundary

- User and agent content is rendered as text (`textContent` or equivalent), never `innerHTML`.
- v0 does not interpret Markdown, links, tool blocks, or HTML.
- Prompt and response text are kept only in page memory; no `localStorage`, IndexedDB, URL, analytics event, or console output.
- Pairing-key handling remains governed by the connection contract and is not copied into chat state.

## Deterministic acceptance suite

The fake ACP server must prove these cases before any provider-backed smoke:

| Case | Required outcome |
| --- | --- |
| CHAT-01 | One prompt, one text chunk, and `end_turn` produce one completed agent message. |
| CHAT-02 | Multiple text chunks append once, in arrival order, without duplication. |
| CHAT-03 | CJK and emoji chunks remain intact. |
| CHAT-04 | `end_turn` with no text settles cleanly as an empty completed reply. |
| CHAT-05 | Every pinned `stopReason` maps to the declared outcome. |
| CHAT-06 | A JSON-RPC error rejects the turn, clears pending state, and exposes only safe UI copy. |
| CHAT-07 | An idle peer reaches the injected prompt deadline and leaves no pending request or timer. |
| CHAT-08 | Disconnect while waiting or streaming settles once and preserves partial text as interrupted. |
| CHAT-09 | Stop sends exactly one no-ID `session/cancel`, enters `CANCELLING`, then settles on the original prompt response. |
| CHAT-10 | Missing cancellation confirmation reaches the local grace deadline and fences late frames. |
| CHAT-11 | Chunks or terminal responses arriving after settlement cannot mutate the completed/interrupted turn. |
| CHAT-12 | A concurrent prompt is rejected locally without a second wire request. |
| CHAT-13 | Updates for another session and unsupported update variants are ignored. |
| CHAT-14 | Empty input and a serialized prompt frame over 1 MiB are rejected locally. |
| CHAT-15 | HTML/script-shaped content is displayed literally and never executed. |

Hardening regressions additionally cover safe `-32001` mapping, future stop-reason fallback, cancel-send isolation, repeated Stop semantics, disconnect while `CANCELLING`, and the 1 MiB cumulative UTF-8 output cap. These refine CHAT-05/06/08/09/14 without expanding the v0 product surface.

## Delivery gates

1. **Contract gate — accepted:** this document was reviewed against the pinned upstream schema and implementation.
2. **Core gate — implemented locally:** fake-server tests implement CHAT-01..14 without DOM or provider credentials.
3. **UI gate:** the thin chat surface implements CHAT-15 plus Send/Stop/state behavior in a real browser.
4. **Runtime gate:** a real OpenAB prompt smoke is allowed only with an isolated provider key, bounded budget, verified redaction, and a tested revoke path. It must explicitly record that Stop does not yet cancel backend work.

Passing this contract does not authorize AWS deployment, Studio integration, provider-key creation, or production release.
