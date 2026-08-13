# OpenAB Client

Community-led reference client for [OpenAB](https://github.com/openabdev/openab).

> This is not an official `openabdev` project or roadmap.

OpenAB Client is a Web-first interface for deploying, using, and observing OpenAB agents without making a third-party chat platform the primary experience. The long-term product can be packaged for desktop and mobile; this repository starts with the shared client contract and a minimal Web reference implementation.

## Current scope

- OpenAB ACP-over-WebSocket connection/authentication core, contract, and integration harness.
- A dependency-free Web skeleton for a single Personal Agent.
- Safe boundaries for connection, authentication, session creation, and redaction.

## Not in this repository yet

- AWS bootstrap, BYOC provisioning, managed hosting, billing, or provider credentials.
- Model prompts, tool execution, multi-agent orchestration, or production deployment.
- History replay, structured tool activity, device pairing, or a complete observability product.

Those are deliberately separate gates. A working `/acp` transport is not a claim that the full product UX already exists.

## Quick start

The static skeleton has no build step:

```bash
python3 -m http.server --directory web 8081
```

It is intentionally disconnected by default. The ACP harness is run only against an OpenAB endpoint that an operator has already started:

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

No package installation is required. The deterministic connection contract suite
uses a local fake ACP server; the E2E uses the fixed OpenAB image already proven
by T0b, with network disabled and no model prompt:

```bash
npm test
npm run test:e2e
```

The Web skeleton remains deliberately thin until this shared connection core is
accepted. It will consume this core rather than duplicate its auth or reconnect logic.

## Development status

The fixed OpenAB image used for the initial local preflight proved `/health` and authenticated `/acp` `initialize → session/new` twice without a model prompt. The next runtime gate is a separately authorized valid-key smoke test; this repository does not contain credentials or deployment infrastructure.

## License

[MIT](LICENSE)
