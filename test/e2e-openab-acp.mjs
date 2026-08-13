#!/usr/bin/env node
/**
 * Local-only, model-free E2E for the real OpenAB ACP server. The client and
 * server run in the same network-none container namespace; no port is exposed.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strategyRoot = path.resolve(repoRoot, "../openab-product-strategy");
const fixtureDir = path.join(strategyRoot, "t0b-fixture");
const image = "ghcr.io/openabdev/openab@sha256:849f0f0a9031d1f7fd73af4a0a9e0c44ac3884cb2dacec43bf8d8428bbc8ff81";
const authKey = `e2e.${randomBytes(24).toString("hex")}`;
const container = `openab-client-e2e-${process.pid}-${Date.now()}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeout ?? 20_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${(result.stderr || result.stdout).replaceAll(authKey, "[REDACTED]").trim()}`);
  return result.stdout.trim();
}

function cleanup() {
  spawnSync("docker", ["rm", "--force", container], { stdio: "ignore", timeout: 10_000 });
}

try {
  run("docker", [
    "run", "--detach", "--name", container,
    "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "128", "--memory", "768m", "--cpus", "1.0",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m", "--tmpfs", "/home/node:rw,noexec,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${fixtureDir},dst=/workspace,readonly`,
    "--mount", `type=bind,src=${path.join(repoRoot, "src")},dst=/client-src,readonly`,
    "--mount", `type=bind,src=${path.join(repoRoot, "test", "fixtures")},dst=/client-test-fixtures,readonly`,
    "--env", "OPENAB_ACP_ENABLED=true", "--env", `OPENAB_ACP_AUTH_KEY=${authKey}`, "--env", "GATEWAY_LISTEN=0.0.0.0:8080",
    image, "openab", "run", "-c", "/workspace/config.toml",
  ]);
  const client = `
    import { AcpConnection } from '/client-src/acp-connection/connection.mjs';
    const key = process.env.OPENAB_E2E_AUTH_KEY;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try { const r = await fetch('http://127.0.0.1:8080/health'); if (r.ok) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const connection = new AcpConnection({ timeoutMs: 10000 });
    const capability = await connection.connect({ endpoint: 'ws://127.0.0.1:8080/acp', authKey: key, allowInsecureLocalhost: true });
    const sessionId = await connection.createSession();
    connection.disconnect();
    console.log(JSON.stringify({ agent: capability.agentName, sessionCreated: sessionId.startsWith('sess_'), promptSent: false }));
  `;
  const result = JSON.parse(run("docker", ["exec", "--env", `OPENAB_E2E_AUTH_KEY=${authKey}`, container, "node", "--input-type=module", "--eval", client], { timeout: 30_000 }));
  if (result.agent !== "openab" || result.sessionCreated !== true || result.promptSent !== false) throw new Error("unexpected E2E result");
  console.log(JSON.stringify({ case: "real-openab-acp", ...result, imagePinned: true }));
} finally {
  cleanup();
}
