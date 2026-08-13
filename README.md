# OpenAB Client

Community-led reference client for [OpenAB](https://github.com/openabdev/openab).

> This is not an official `openabdev` project or roadmap.

OpenAB Client is a Web-first interface for deploying, using, and observing OpenAB agents without making a third-party chat platform the primary experience. The long-term product can be packaged for desktop and mobile; this repository starts with the shared client contract and a minimal Web reference implementation.

## Current scope

- OpenAB ACP-over-WebSocket connection/authentication core, contract, and integration harness.
- A dependency-free Web connection UI for a single Personal Agent, driven only
  by the shared ACP state machine.
- Safe boundaries for connection, authentication, session creation, and redaction.

## Not in this repository yet

- AWS bootstrap, BYOC provisioning, managed hosting, billing, or provider credentials.
- Model prompts, tool execution, multi-agent orchestration, or production deployment.
- History replay, structured tool activity, device pairing, or a complete observability product.

Those are deliberately separate gates. A working `/acp` transport is not a claim that the full product UX already exists.

## Quick start

The Web UI has no build step. Serve the repository root so the browser can load
both `web/` and the shared `src/` modules:

```bash
python3 -m http.server 8081
# open http://127.0.0.1:8081/web/
```

The UI accepts only `wss://` endpoints, except when the user explicitly enables
the local-development `ws://localhost` allowance. It does not persist the
pairing key and clears the credential field as soon as a connection attempt
starts. The ACP harness is run only against an OpenAB endpoint that an operator
has already started:

```bash
OPENAB_ACP_URL=wss://example.invalid/acp \
OPENAB_ACP_AUTH_KEY=your-short-lived-key \
node scripts/acp-smoke.mjs
```

The harness performs `initialize → session/new → close`. It never sends a prompt or prints the authentication key.

## Architecture boundary

```text
OpenAB Client (Web / Desktop / Mobile)
        │ ACP JSON-RPC over WebSocket
        ▼
OpenAB runtime GET /acp
        │
        ▼
LLM CLI / agent runtime
```

The supported wire baseline is documented in [docs/acp-contract.md](docs/acp-contract.md).

## Local verification

Node.js 22 or later is required (the smoke harness uses Node's global
`WebSocket`). No package installation is required. The deterministic connection contract suite
uses a local fake ACP server; the E2E uses the fixed OpenAB image already proven
by T0b, with network disabled and no model prompt:

```bash
npm test
npm run test:e2e
```

`npm run test:e2e` is an opt-in local integration check, not a CI requirement:
it requires Docker plus the T0b fixture checkout. By default it looks for the
sibling `../openab-product-strategy/t0b-fixture`; another checkout can be named
explicitly without embedding a local path in code:

```bash
OPENAB_STRATEGY_ROOT=/path/to/openab-product-strategy npm run test:e2e
```

The Web UI deliberately stops at `session/new`. It consumes the accepted shared
connection core rather than duplicating auth, request, or reconnect logic; it
does not send prompts or expose deployment controls.

## Development status

The accepted ACP core and thin Web UI now complete authenticated
`connect → initialize → session/new → disconnect` in both the deterministic
fixture and a real browser. The fixed OpenAB image E2E also passes without a
model prompt. This repository still contains no provider credential, AWS
bootstrap, deployment infrastructure, or chat/prompt implementation.

## License

[MIT](LICENSE)
