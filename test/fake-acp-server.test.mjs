import assert from "node:assert/strict";
import test from "node:test";
import { parseFrames } from "./fixtures/fake-acp-server.mjs";

function maskedTextFrame(payload) {
  const body = Buffer.from(payload);
  assert.equal(body.length, 127);

  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 0x80 | 126;
  header.writeUInt16BE(body.length, 2);

  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const maskedBody = Buffer.from(body);
  for (let index = 0; index < maskedBody.length; index += 1) {
    maskedBody[index] ^= mask[index % 4];
  }
  return Buffer.concat([header, mask, maskedBody]);
}

test("FIXTURE-01: a 16-bit frame with a decoded 127-byte payload is not parsed as 64-bit", () => {
  const payload = "x".repeat(127);
  const parsed = [];
  const remaining = parseFrames(maskedTextFrame(payload), (frame) => parsed.push(frame));

  assert.equal(remaining.length, 0);
  assert.deepEqual(parsed, [{ opcode: 1, payload }]);
});
