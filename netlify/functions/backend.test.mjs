import test from "node:test";
import assert from "node:assert/strict";

import { handler as createPix } from "./create-pix.mjs";
import { handler as webhook } from "./pingupag-webhook.mjs";
import {
  createTransaction,
  mapGatewayStatus,
} from "./lib/pingupag.mjs";

test("payment creation rejects unsupported methods without contacting services", async () => {
  const response = await createPix({ httpMethod: "GET" });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, "POST");
});

test("payment creation rejects malformed JSON", async () => {
  const response = await createPix({ httpMethod: "POST", body: "{" });
  assert.equal(response.statusCode, 400);
});

test("payment creation refuses to proceed when gateway credentials are missing", async () => {
  const previousKey = process.env.PINGUPAG_API_KEY;
  delete process.env.PINGUPAG_API_KEY;

  try {
    const response = await createPix({
      httpMethod: "POST",
      body: JSON.stringify({
        orderId: "123e4567-e89b-42d3-a456-426614174000",
        checkoutToken: "a".repeat(32),
      }),
    });
    assert.equal(response.statusCode, 503);
  } finally {
    if (previousKey === undefined) {
      delete process.env.PINGUPAG_API_KEY;
    } else {
      process.env.PINGUPAG_API_KEY = previousKey;
    }
  }
});

test("gateway client requires its API key before making a request", async () => {
  await assert.rejects(
    createTransaction({ amount: 100 }, {}),
    /Missing PINGUPAG_API_KEY/,
  );
});

test("webhook rejects unsupported methods without contacting services", async () => {
  const response = await webhook({ httpMethod: "GET" });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, "POST");
});

test("webhook requires a transaction reference", async () => {
  const response = await webhook({
    httpMethod: "POST",
    body: JSON.stringify({ status: "approved" }),
  });
  assert.equal(response.statusCode, 400);
});

test("gateway status mapping accepts only documented statuses", () => {
  for (const status of [
    "approved",
    "pending",
    "processing",
    "under_review",
    "failed",
    "refunded",
    "chargeback",
  ]) {
    assert.equal(mapGatewayStatus(status), status);
  }
  assert.throws(() => mapGatewayStatus("success"));
});
