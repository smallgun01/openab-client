# ACP connection contract — initial baseline

This document records the smallest verified wire contract between OpenAB Client and the OpenAB ACP server. It is not a claim that every product capability exists upstream.

## Connection

- Transport: JSON-RPC 2.0 over WebSocket at `GET /acp`.
- Client offers the `acp.v1` WebSocket subprotocol.
- A non-loopback endpoint requires an ACP authentication key. Browser clients send it as the `openab.bearer.<token>` WebSocket subprotocol, rather than in a URL.
- The key is supplied by an operator-owned secret boundary. It must never be persisted in browser storage, emitted in logs, or rendered in the UI.

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

`scripts/acp-smoke.mjs` passes only when the endpoint returns ACP v1 and a server-minted `sess_` identifier. It does not send a user prompt or print the supplied authentication key.
