import { startFakeAcpServer } from "./fixtures/fake-acp-server.mjs";

const literalPayload = `<img src=x onerror="document.body.dataset.chat15Executed='yes'">`
  + `<script>document.body.dataset.chat15Executed='yes'</script>& hello`;

const server = await startFakeAcpServer({
  promptHandler({ request, update, finish }) {
    const prompt = request.params?.prompt?.[0]?.text;
    if (prompt === "stop-fixture") {
      update("partial response");
      return;
    }
    update(literalPayload);
    finish();
  },
});

process.stdout.write(`${JSON.stringify({ endpoint: server.endpoint, authKey: "valid-test-key", literalPayload })}\n`);

async function shutdown() {
  await server.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
await new Promise(() => {});
