import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeAcpServer } from "../fixtures/fake-acp-server.mjs";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const AUTH_KEY = "valid-test-key";
const LITERAL_PAYLOAD = `<img src=x onerror="document.body.dataset.chat15Executed='yes'">`
  + `<script>document.body.dataset.chat15Executed='yes'</script>& hello`;

const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
});

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const relativePath = pathname === "/" || pathname === "/web/"
        ? "web/index.html"
        : pathname.startsWith("/web/") || pathname.startsWith("/src/")
          ? pathname.slice(1)
          : null;
      if (!relativePath) {
        response.writeHead(404).end();
        return;
      }

      const assetPath = resolve(REPOSITORY_ROOT, relativePath);
      if (!assetPath.startsWith(`${REPOSITORY_ROOT}${sep}`)) {
        response.writeHead(404).end();
        return;
      }

      const body = await readFile(assetPath);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": CONTENT_TYPES[extname(assetPath)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/web/`,
    async close() {
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}

let acpServer;
let staticServer;

test.beforeAll(async () => {
  acpServer = await startFakeAcpServer({
    promptHandler({ request, update, finish }) {
      if (request.params?.prompt?.[0]?.text === "stop-fixture") {
        update("partial response");
        return;
      }
      update(LITERAL_PAYLOAD);
      finish();
    },
  });
  staticServer = await startStaticServer();
});

test.afterAll(async () => {
  await Promise.allSettled([acpServer?.close(), staticServer?.close()]);
});

async function connectReadySession(page) {
  await page.goto(staticServer.url);
  await page.locator("#endpoint").fill(acpServer.endpoint);
  await page.locator("#auth-key").fill(AUTH_KEY);
  await page.locator("#allow-insecure-localhost").check();
  await expect(page.locator("#connect")).toBeEnabled();
  await page.locator("#connect").click();
  await expect(page.locator("#connection-state")).toHaveText("Ready");
  await page.locator("#create-session").click();
  await expect(page.locator("#session-state")).toContainText("Session ready:");
  await expect(page.locator("#prompt")).toBeEnabled();
}

test("CHAT-15: user and agent HTML-shaped content remains literal text", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await connectReadySession(page);
  await page.locator("#prompt").fill(LITERAL_PAYLOAD);
  await page.locator("#send").click();

  const contents = page.locator(".message-content");
  await expect(contents).toHaveCount(2);
  await expect(contents.nth(0)).toHaveText(LITERAL_PAYLOAD);
  await expect(contents.nth(1)).toHaveText(LITERAL_PAYLOAD);
  await expect(page.locator(".message-content img, .message-content script")).toHaveCount(0);
  await expect(page.locator(".message[data-role='agent'] .message-status")).toHaveText("Response complete.");

  const sideEffects = await page.evaluate(() => ({
    marker: document.body.dataset.chat15Executed ?? null,
    localStorageItems: localStorage.length,
    sessionStorageItems: sessionStorage.length,
  }));
  expect(sideEffects).toEqual({ marker: null, localStorageItems: 0, sessionStorageItems: 0 });
  expect(browserErrors).toEqual([]);
});

test("CHAT-15: Stop preserves partial text and restores the next-turn controls", async ({ page }) => {
  await connectReadySession(page);
  await page.locator("#prompt").fill("stop-fixture");
  await page.locator("#send").click();

  const agentMessage = page.locator(".message[data-role='agent']");
  await expect(agentMessage.locator(".message-content")).toHaveText("partial response");
  await expect(page.locator("#stop")).toBeEnabled();
  await page.locator("#stop").click();

  await expect(agentMessage.locator(".message-content")).toHaveText("partial response");
  await expect(agentMessage.locator(".message-status")).toContainText("Remote work may continue");
  await expect(page.locator("#prompt")).toBeEnabled();
  await expect(page.locator("#send")).toBeDisabled();
  await expect(page.locator("#stop")).toBeDisabled();
});
