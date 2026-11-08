import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { handler as createOrder } from "../netlify/functions/create-order.mjs";
import { handler as getOrder } from "../netlify/functions/get-order.mjs";
import { handler as updateTracking } from "../netlify/functions/update-order-tracking.mjs";
import { handler as trackOrder } from "../netlify/functions/track-order.mjs";
import { handler as paymentWebhook } from "../netlify/functions/pingupag-webhook.mjs";
import { handler as createPix } from "../netlify/functions/create-pix.mjs";
import { checkoutTokenForOrder, maxOrderAmountCents, normalizeOrder, parseCatalog, validCpf } from "../netlify/lib/orders.mjs";

const envKeys = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CHECKOUT_TOKEN_SECRET",
  "PIX_ORDER_CATALOG_JSON",
  "ORDER_OPERATIONS_TOKEN",
  "PINGUPAG_API_KEY",
  "URL",
  "RATE_LIMIT_SECRET",
  "PIX_MAX_AMOUNT_CENTS",
  "CHECKOUT_TOKEN_SECRETS_JSON",
  "CHECKOUT_TOKEN_ACTIVE_VERSION",
];

const TEST_IP_HEADERS = { "x-nf-client-connection-ip": "203.0.113.20" };

function saveEnv() {
  return Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
}

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setOrderEnv() {
  process.env.SUPABASE_URL = "https://supabase.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.CHECKOUT_TOKEN_SECRET = "test-checkout-token-secret-with-32-bytes-minimum";
  process.env.RATE_LIMIT_SECRET = "test-rate-limit-secret-with-at-least-32-bytes";
  process.env.PIX_MAX_AMOUNT_CENTS = "2147483647";
  process.env.PIX_ORDER_CATALOG_JSON = JSON.stringify({
    TEST_ITEM: { name: "Test item", unitAmountCents: 1250, requiresShipping: false },
  });
}

const validBody = {
  items: [{ sku: "TEST_ITEM", quantity: 2 }],
  customer: {
    name: "Test Customer",
    email: "test@example.invalid",
    document: "52998224725",
    phone: "11999999999",
  },
};

test("create-order validates input and derives amount from the server catalog", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();

  let rpcBody;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    assert.match(String(url), /\/rest\/v1\/rpc\/create_pix_order$/);
    rpcBody = JSON.parse(options.body);
    return jsonResponse({
      created: true,
      order: {
        id: rpcBody.p_id,
        reference: rpcBody.p_reference,
        amount_cents: rpcBody.p_amount_cents,
        status: "pending",
        request_fingerprint: rpcBody.p_request_fingerprint,
      },
    });
  };

  const result = await createOrder({
    httpMethod: "POST",
    headers: { ...TEST_IP_HEADERS, "Idempotency-Key": "test-idempotency-key-001" },
    body: JSON.stringify({ ...validBody, amountCents: 1, description: "tampered" }),
  });
  assert.equal(result.statusCode, 201);
  assert.equal(rpcBody.p_amount_cents, 2500);
  assert.equal(rpcBody.p_description, "Test item");
  assert.equal(JSON.parse(result.body).amountCents, 2500);
  assert.equal(JSON.parse(result.body).checkoutToken.length, 64);
});

test("create-order supports versioned token secrets without a legacy secret", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();
  delete process.env.CHECKOUT_TOKEN_SECRET;
  process.env.CHECKOUT_TOKEN_SECRETS_JSON = JSON.stringify({ "2": "version-two-checkout-secret-with-at-least-32-bytes" });
  process.env.CHECKOUT_TOKEN_ACTIVE_VERSION = "2";
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    assert.match(String(url), /\/rpc\/create_pix_order$/);
    const input = JSON.parse(options.body);
    assert.equal(input.p_checkout_token_key_version, 2);
    return jsonResponse({
      created: true,
      order: {
        id: input.p_id,
        reference: input.p_reference,
        amount_cents: input.p_amount_cents,
        status: "pending",
        checkout_token_key_version: 2,
        request_fingerprint: input.p_request_fingerprint,
      },
    });
  };
  const result = await createOrder({
    httpMethod: "POST",
    headers: { ...TEST_IP_HEADERS, "idempotency-key": "versioned-token-order-001" },
    body: JSON.stringify(validBody),
  });
  assert.equal(result.statusCode, 201);
  assert.equal(JSON.parse(result.body).checkoutToken.length, 64);
});

test("created order reference and trusted amount flow into the existing PIX function", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();
  process.env.PINGUPAG_API_KEY = "test-pingupag-api-key";
  process.env.URL = "https://checkout.example.invalid";
  let order;
  let paymentRequest;
  let gatewayRequest;
  let paymentRow;
  const requestedUrls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    requestedUrls.push(`${options.method || "GET"} ${target.href}`);
    if (target.pathname.endsWith("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    if (target.pathname.endsWith("/rpc/create_pix_order")) {
      const input = JSON.parse(options.body);
      order = {
        id: input.p_id,
        reference: input.p_reference,
        amount_cents: input.p_amount_cents,
        description: input.p_description,
        customer: validBody.customer,
        checkout_token_hash: input.p_checkout_token_hash,
        status: "pending",
        request_fingerprint: input.p_request_fingerprint,
      };
      return jsonResponse({ created: true, order });
    }
    if (target.hostname === "supabase.invalid" && target.pathname.endsWith("/pix_orders")) {
      return jsonResponse([order]);
    }
    if (target.hostname === "supabase.invalid" && target.pathname.endsWith("/pix_payments") && options.method !== "POST" && options.method !== "PATCH") {
      return jsonResponse(paymentRow ? [paymentRow] : []);
    }
    if (target.hostname === "supabase.invalid" && target.pathname.endsWith("/pix_payments") && options.method === "POST") {
      paymentRequest = JSON.parse(options.body);
      paymentRow = { id: "payment-row-1", ...paymentRequest, qr_code: null, qr_code_base64: null, expires_at: null };
      return jsonResponse([{ id: paymentRow.id }]);
    }
    if (target.hostname === "supabase.invalid" && target.pathname.endsWith("/pix_payments") && options.method === "PATCH") {
      Object.assign(paymentRow, JSON.parse(options.body));
      return jsonResponse(null);
    }
    if (target.hostname === "supabase.invalid" && target.pathname.endsWith("/rpc/apply_pix_gateway_status")) {
      paymentRow.status = JSON.parse(options.body).p_status;
      paymentRow.gateway_transaction_id = JSON.parse(options.body).p_gateway_transaction_id;
      return jsonResponse(true);
    }
    if (target.hostname === "pagamento-processador.org.ua" && target.pathname.endsWith("/gateway/v1/query")) {
      return jsonResponse([]);
    }
    if (target.hostname === "pagamento-processador.org.ua" && target.pathname.endsWith("/gateway/v1/transaction")) {
      gatewayRequest = JSON.parse(options.body);
      return jsonResponse({ status: "success", id: order.reference, amount: 2500, transaction_id: 123, qr_code: "000201test" });
    }
    throw new Error(`Unexpected mocked request: ${target.href}`);
  };

  const orderResponse = await createOrder({
    httpMethod: "POST",
    headers: { ...TEST_IP_HEADERS, "idempotency-key": "test-pix-flow-key-001" },
    body: JSON.stringify(validBody),
  });
  const created = JSON.parse(orderResponse.body);
  const paymentResponse = await createPix({
    httpMethod: "POST",
    headers: TEST_IP_HEADERS,
    body: JSON.stringify({ orderId: created.orderId, checkoutToken: created.checkoutToken }),
  });
  assert.equal(paymentResponse.statusCode, 200, requestedUrls.join("\n"));
  assert.equal(paymentRequest.order_id, created.orderId);
  assert.equal(paymentRequest.reference, created.reference);
  assert.equal(paymentRequest.amount_cents, 2500);
  assert.equal(gatewayRequest.reference, created.reference);
  assert.equal(gatewayRequest.amount, 2500);
  assert.match(gatewayRequest.postback_url, /\/api\/pingupag-webhook$/);
  assert.equal(JSON.parse(paymentResponse.body).qr_code, "000201test");
});

test("create-order rejects invalid catalog SKUs and missing idempotency keys", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();
  globalThis.fetch = async (url) => {
    if (String(url).includes("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    throw new Error("Unexpected network request");
  };

  const noKey = await createOrder({ httpMethod: "POST", headers: TEST_IP_HEADERS, body: JSON.stringify(validBody) });
  assert.equal(noKey.statusCode, 400);
  const unknownSku = await createOrder({
    httpMethod: "POST",
    headers: { ...TEST_IP_HEADERS, "idempotency-key": "test-idempotency-key-002" },
    body: JSON.stringify({ ...validBody, items: [{ sku: "UNKNOWN", quantity: 1 }] }),
  });
  assert.equal(unknownSku.statusCode, 400);
});

test("create-order idempotency returns the same order and rejects key reuse with different data", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();
  const existingId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const expectedFingerprint = crypto.createHash("sha256").update(JSON.stringify({
    customer: validBody.customer,
    items: [{ sku: "TEST_ITEM", name: "Test item", quantity: 2, unit_amount_cents: 1250, line_total_cents: 2500 }],
    shippingAddress: null,
    amountCents: 2500,
  })).digest("hex");
  globalThis.fetch = async (_url, options) => {
    if (String(_url).includes("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    const input = JSON.parse(options.body);
    return jsonResponse({
      created: false,
      order: {
        id: existingId,
        reference: `order-${existingId}`,
        amount_cents: 2500,
        status: "pending",
        request_fingerprint: expectedFingerprint,
      },
    });
  };
  const event = {
    httpMethod: "POST",
    headers: { ...TEST_IP_HEADERS, "Idempotency-Key": "test-idempotency-key-003" },
    body: JSON.stringify(validBody),
  };
  const first = await createOrder(event);
  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body).orderId, existingId);
  const changed = await createOrder({ ...event, body: JSON.stringify({ ...validBody, items: [{ sku: "TEST_ITEM", quantity: 1 }] }) });
  assert.equal(changed.statusCode, 409);
});

test("get-order requires the order-specific token and returns only matching order data", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();
  const orderId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const token = crypto.createHmac("sha256", process.env.CHECKOUT_TOKEN_SECRET).update(orderId).digest("hex");
  globalThis.fetch = async (url) => {
    if (String(url).includes("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    if (String(url).includes("pix_orders?")) {
      return jsonResponse([{
        id: orderId,
        reference: `order-${orderId}`,
        amount_cents: 2500,
        description: "Test item",
        customer: validBody.customer,
        order_items: [{ sku: "TEST_ITEM", quantity: 2 }],
        shipping_address: null,
        status: "paid",
        created_at: "2026-11-07T00:00:00Z",
        delivery_status: "not_shipped",
        checkout_token_hash: crypto.createHash("sha256").update(token).digest("hex"),
      }]);
    }
    if (String(url).includes("pix_order_tracking_events?")) return jsonResponse([]);
    return jsonResponse([{ status: "approved", qr_code: null, qr_code_base64: null, expires_at: null }]);
  };

  const denied = await getOrder({ httpMethod: "GET", rawQuery: `orderId=${orderId}`, headers: { ...TEST_IP_HEADERS, authorization: `Bearer ${"f".repeat(64)}` } });
  assert.equal(denied.statusCode, 404);
  const changedId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const originalFetchForLookup = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    if (String(url).includes("pix_orders?")) return jsonResponse([]);
    return jsonResponse([]);
  };
  const alteredId = await getOrder({ httpMethod: "GET", rawQuery: `orderId=${changedId}`, headers: { ...TEST_IP_HEADERS, authorization: `Bearer ${token}` } });
  assert.equal(alteredId.statusCode, 404);
  globalThis.fetch = originalFetchForLookup;
  const allowed = await getOrder({ httpMethod: "GET", rawQuery: `orderId=${orderId}`, headers: { ...TEST_IP_HEADERS, authorization: `Bearer ${token}` } });
  assert.equal(allowed.statusCode, 200);
  assert.equal(JSON.parse(allowed.body).order.status, "paid");
  assert.equal(JSON.parse(allowed.body).payment.status, "approved");
});

test("get-order never sends an unapproved tracking code or event data to the browser", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();
  const orderId = "abababab-abab-4bab-8bab-abababababab";
  const token = crypto.createHmac("sha256", process.env.CHECKOUT_TOKEN_SECRET).update(orderId).digest("hex");
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    if (target.pathname.endsWith("/pix_orders")) return jsonResponse([{
      id: orderId,
      reference: `order-${orderId}`,
      amount_cents: 1000,
      description: "Test item",
      customer: validBody.customer,
      order_items: [],
      shipping_address: { cep: "01001000" },
      status: "pending",
      delivery_status: "shipped",
      carrier: "Carrier",
      tracking_code: "AB123456789",
      tracking_url: "https://carrier.invalid/AB123456789",
      checkout_token_hash: crypto.createHash("sha256").update(token).digest("hex"),
    }]);
    if (target.pathname.endsWith("/pix_payments")) return jsonResponse([{ status: "pending", qr_code: null }]);
    if (target.pathname.endsWith("/pix_order_tracking_events")) {
      return jsonResponse([{ new_status: "shipped", tracking_code: "AB123456789", tracking_url: "https://carrier.invalid/AB123456789" }]);
    }
    throw new Error(`Unexpected mocked request: ${target.href}`);
  };
  const result = await getOrder({
    httpMethod: "GET",
    rawQuery: `orderId=${orderId}`,
    headers: { ...TEST_IP_HEADERS, authorization: `Bearer ${token}` },
  });
  const output = JSON.parse(result.body);
  assert.equal(result.statusCode, 200);
  assert.equal(output.delivery.trackingCode, null);
  assert.equal(output.delivery.trackingCodePreview, "AB••••••••");
  assert.equal(output.delivery.trackingLocked, true);
  assert.equal(output.delivery.trackingUrl, null);
  assert.deepEqual(output.delivery.history, []);
  assert.equal(result.body.includes("AB123456789"), false);
});

test("tracking updates require the operations token and only PATCH paid orders", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();
  process.env.ORDER_OPERATIONS_TOKEN = "test-order-operations-token-which-is-long-enough";
  const orderId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let requestUrl;
  let requestBody;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    requestUrl = String(url);
    requestBody = JSON.parse(options.body);
    return jsonResponse({
      ok: true,
      delivery: {
        status: "shipped",
        carrier: "Carrier",
        tracking_code: "TRACK123",
        tracking_url: "https://tracking.example.invalid/1",
        shipped_at: "2026-11-07T00:00:00.000Z",
        delivered_at: null,
        tracking_updated_at: "2026-11-07T00:00:00.000Z",
      },
    });
  };
  const event = {
    httpMethod: "POST",
    headers: { ...TEST_IP_HEADERS, authorization: `Bearer ${process.env.ORDER_OPERATIONS_TOKEN}` },
    body: JSON.stringify({
      orderId,
      deliveryStatus: "shipped",
      carrier: "Carrier",
      trackingCode: "TRACK123",
      trackingUrl: "https://tracking.example.invalid/1",
    }),
  };
  const result = await updateTracking(event);
  assert.equal(result.statusCode, 200);
  assert.match(requestUrl, /rpc\/update_pix_order_tracking$/);
  assert.equal(requestBody.p_delivery_status, "shipped");
  assert.equal(requestBody.p_tracking_code, "TRACK123");
});

test("amount limits match the PostgreSQL integer ceiling and checkout keys rotate by version", () => {
  const secretV1 = "legacy-checkout-token-secret-with-32-bytes";
  const secretV2 = "rotated-checkout-token-secret-with-32-bytes";
  const env = {
    CHECKOUT_TOKEN_SECRETS_JSON: JSON.stringify({ "1": secretV1, "2": secretV2 }),
    CHECKOUT_TOKEN_ACTIVE_VERSION: "2",
    PIX_MAX_AMOUNT_CENTS: "2147483647",
  };
  const orderId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  assert.equal(maxOrderAmountCents(env), 2_147_483_647);
  assert.equal(validCpf("52998224725"), true);
  assert.equal(validCpf("12345678901"), false);
  assert.equal(validCpf("11111111111"), false);
  assert.equal(checkoutTokenForOrder(orderId, 1, env), crypto.createHmac("sha256", secretV1).update(orderId).digest("hex"));
  assert.notEqual(checkoutTokenForOrder(orderId, 1, env), checkoutTokenForOrder(orderId, 2, env));
  assert.equal(checkoutTokenForOrder(orderId, 2, env), checkoutTokenForOrder(orderId, 2, env));
  const catalog = parseCatalog({ PIX_ORDER_CATALOG_JSON: JSON.stringify({ BIG: { name: "Large", unitAmountCents: 2_147_483_648 } }) });
  assert.equal(normalizeOrder({ ...validBody, items: [{ sku: "BIG", quantity: 1 }] }, catalog, 2_147_483_647), null);
  assert.throws(() => maxOrderAmountCents({ PIX_MAX_AMOUNT_CENTS: "2147483648" }));
});

test("oversized order payload and exhausted rate limit fail before any order write", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();
  let orderWrites = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/rpc/consume_api_rate_limit")) return jsonResponse(false);
    orderWrites++;
    return jsonResponse({});
  };
  const tooLarge = await createOrder({
    httpMethod: "POST",
    headers: { ...TEST_IP_HEADERS, "idempotency-key": "oversized-request-001" },
    body: "x".repeat(16 * 1024 + 1),
  });
  assert.equal(tooLarge.statusCode, 413);
  const limited = await createOrder({
    httpMethod: "POST",
    headers: { ...TEST_IP_HEADERS, "idempotency-key": "rate-limited-request-01" },
    body: JSON.stringify(validBody),
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(orderWrites, 0);
});

test("webhook ignores browser supplied status and applies only the verified gateway state; repeats are safe", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();
  process.env.PINGUPAG_API_KEY = "test-pingupag-api-key";
  const reference = "order-ffffffff-ffff-4fff-8fff-ffffffffffff";
  let appliedStatuses = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    if (target.hostname === "supabase.invalid" && target.pathname.endsWith("/pix_payments")) {
      return jsonResponse([{ id: "payment-1", order_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", reference, amount_cents: 2500, status: "pending", gateway_transaction_id: "123" }]);
    }
    if (target.hostname === "pagamento-processador.org.ua" && target.pathname.endsWith("/gateway/v1/query")) {
      assert.equal(target.searchParams.get("external_id"), reference);
      return jsonResponse([{ id: 123, external_id: reference, amount: 2500, status: "approved" }]);
    }
    if (target.pathname.endsWith("/rpc/apply_pix_gateway_status")) {
      appliedStatuses.push(JSON.parse(options.body).p_status);
      return jsonResponse(true);
    }
    throw new Error(`Unexpected mocked request: ${target.href}`);
  };
  const event = {
    httpMethod: "POST",
    headers: TEST_IP_HEADERS,
    body: JSON.stringify({ external_id: reference, status: "failed" }),
  };
  assert.equal((await paymentWebhook(event)).statusCode, 200);
  assert.equal((await paymentWebhook(event)).statusCode, 200);
  assert.deepEqual(appliedStatuses, ["approved", "approved"]);
});

test("a duplicate gateway transaction or amount mismatch is not applied by the webhook", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();
  process.env.PINGUPAG_API_KEY = "test-pingupag-api-key";
  const reference = "order-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  let applied = false;
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    if (target.hostname === "supabase.invalid" && target.pathname.endsWith("/pix_payments")) {
      return jsonResponse([{ id: "payment-2", order_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", reference, amount_cents: 2500, status: "pending", gateway_transaction_id: null }]);
    }
    if (target.hostname === "pagamento-processador.org.ua") {
      return jsonResponse([
        { id: 1, external_id: reference, amount: 2500, status: "approved" },
        { id: 2, external_id: reference, amount: 2500, status: "approved" },
      ]);
    }
    if (target.pathname.endsWith("/rpc/apply_pix_gateway_status")) {
      applied = true;
      return jsonResponse(true);
    }
    throw new Error(`Unexpected mocked request: ${target.href}`);
  };
  const result = await paymentWebhook({
    httpMethod: "POST",
    headers: TEST_IP_HEADERS,
    body: JSON.stringify({ external_id: reference, status: "approved" }),
  });
  assert.equal(result.statusCode, 409);
  assert.equal(applied, false);
});

test("uncertain PIX creation is reconciled from PinguPag and never creates a duplicate charge", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();
  process.env.PINGUPAG_API_KEY = "test-pingupag-api-key";
  process.env.URL = "https://checkout.example.invalid";
  const orderId = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
  const reference = `order-${orderId}`;
  const checkoutToken = crypto.createHmac("sha256", process.env.CHECKOUT_TOKEN_SECRET).update(orderId).digest("hex");
  const order = {
    id: orderId,
    reference,
    amount_cents: 2500,
    description: "Test item",
    customer: validBody.customer,
    checkout_token_hash: crypto.createHash("sha256").update(checkoutToken).digest("hex"),
    status: "pending",
  };
  let payment = null;
  let createAttempts = 0;
  let reconciledStatus = null;
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    if (target.hostname === "supabase.invalid" && target.pathname.endsWith("/pix_orders")) return jsonResponse([order]);
    if (target.hostname === "supabase.invalid" && target.pathname.endsWith("/pix_payments") && !options.method) return jsonResponse(payment ? [payment] : []);
    if (target.hostname === "supabase.invalid" && target.pathname.endsWith("/pix_payments") && options.method === "POST") {
      payment = { id: "payment-3", ...JSON.parse(options.body), qr_code: null, qr_code_base64: null, expires_at: null };
      return jsonResponse([{ id: payment.id }]);
    }
    if (target.hostname === "supabase.invalid" && target.pathname.endsWith("/rpc/apply_pix_gateway_status")) {
      const input = JSON.parse(options.body);
      reconciledStatus = input.p_status;
      payment.status = input.p_status;
      payment.gateway_transaction_id = input.p_gateway_transaction_id;
      return jsonResponse(true);
    }
    if (target.hostname === "pagamento-processador.org.ua" && target.pathname.endsWith("/gateway/v1/query")) {
      return jsonResponse(createAttempts === 0 ? [] : [{ id: 789, external_id: reference, amount: 2500, status: "pending" }]);
    }
    if (target.hostname === "pagamento-processador.org.ua" && target.pathname.endsWith("/gateway/v1/transaction")) {
      createAttempts++;
      throw new Error("Simulated network timeout after provider accepted request");
    }
    throw new Error(`Unexpected mocked request: ${target.href}`);
  };
  const event = {
    httpMethod: "POST",
    headers: TEST_IP_HEADERS,
    body: JSON.stringify({ orderId, checkoutToken }),
  };
  const uncertain = await createPix(event);
  assert.equal(uncertain.statusCode, 502);
  assert.equal(payment.status, "creating");
  const recovered = await createPix(event);
  assert.equal(recovered.statusCode, 409);
  assert.equal(payment.status, "pending");
  assert.equal(reconciledStatus, "pending");
  assert.equal(createAttempts, 1);
});

test("a previously recorded pending PIX is returned without a second gateway request", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();
  process.env.PINGUPAG_API_KEY = "test-pingupag-api-key";
  const orderId = "dddddddd-1111-4111-8111-dddddddddddd";
  const token = crypto.createHmac("sha256", process.env.CHECKOUT_TOKEN_SECRET).update(orderId).digest("hex");
  let gatewayCalls = 0;
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    if (target.pathname.endsWith("/pix_orders")) return jsonResponse([{
      id: orderId,
      reference: `order-${orderId}`,
      amount_cents: 1000,
      description: "Test item",
      customer: validBody.customer,
      checkout_token_hash: crypto.createHash("sha256").update(token).digest("hex"),
      status: "pending",
    }]);
    if (target.pathname.endsWith("/pix_payments")) return jsonResponse([{
      id: "pay-existing",
      order_id: orderId,
      reference: `order-${orderId}`,
      amount_cents: 1000,
      gateway_transaction_id: "1234",
      status: "pending",
      qr_code: "000201existing",
      qr_code_base64: null,
      expires_at: null,
    }]);
    if (target.hostname === "pagamento-processador.org.ua") gatewayCalls++;
    throw new Error(`Unexpected mocked request: ${target.href}`);
  };
  const result = await createPix({
    httpMethod: "POST",
    headers: TEST_IP_HEADERS,
    body: JSON.stringify({ orderId, checkoutToken: token }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).qr_code, "000201existing");
  assert.equal(gatewayCalls, 0);
});

test("declined payment status comes from the gateway query, not the webhook body", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();
  process.env.PINGUPAG_API_KEY = "test-pingupag-api-key";
  const reference = "order-eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
  let appliedStatus;
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    if (target.hostname === "supabase.invalid" && target.pathname.endsWith("/pix_payments")) {
      return jsonResponse([{ id: "payment-failed", order_id: "eeeeeeee-1111-4111-8111-eeeeeeeeeeee", reference, amount_cents: 900, status: "pending", gateway_transaction_id: null }]);
    }
    if (target.hostname === "pagamento-processador.org.ua") {
      return jsonResponse([{ id: 456, external_id: reference, amount: 900, status: "failed" }]);
    }
    if (target.pathname.endsWith("/rpc/apply_pix_gateway_status")) {
      appliedStatus = JSON.parse(options.body).p_status;
      return jsonResponse(true);
    }
    throw new Error(`Unexpected mocked request: ${target.href}`);
  };
  const result = await paymentWebhook({
    httpMethod: "POST",
    headers: TEST_IP_HEADERS,
    body: JSON.stringify({ external_id: reference, status: "approved" }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(appliedStatus, "failed");
});

test("tracking history is committed through the service-side transition RPC", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();
  process.env.ORDER_OPERATIONS_TOKEN = "test-order-operations-token-which-is-long-enough";
  let rpcBody;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    rpcBody = JSON.parse(options.body);
    return jsonResponse({
      ok: true,
      delivery: {
        status: "shipped",
        carrier: "Carrier",
        tracking_code: "TRACK456",
        tracking_url: "https://tracking.example.invalid/2",
        shipped_at: "2026-11-07T00:00:00.000Z",
        delivered_at: null,
        tracking_updated_at: "2026-11-07T00:00:00.000Z",
      },
    });
  };
  const result = await updateTracking({
    httpMethod: "POST",
    headers: { ...TEST_IP_HEADERS, authorization: `Bearer ${process.env.ORDER_OPERATIONS_TOKEN}` },
    body: JSON.stringify({ orderId: "cccccccc-1111-4111-8111-cccccccccccc", deliveryStatus: "shipped", carrier: "Carrier", trackingCode: "TRACK456", trackingUrl: "https://tracking.example.invalid/2" }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(rpcBody.p_actor, "operations-token");
  assert.equal(rpcBody.p_delivery_status, "shipped");
  assert.equal(JSON.parse(result.body).delivery.trackingCode, "TRACK456");
});

test("public tracking lookup returns only logistics for a paid order", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();
  let lookupQuery;
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    if (target.pathname.endsWith("/pix_orders")) {
      lookupQuery = target.searchParams;
      return jsonResponse([{
        id: "11111111-2222-4222-8222-111111111111",
        status: "paid",
        delivery_status: "in_transit",
        carrier: "Carrier",
        tracking_code: "AB123456789",
        tracking_url: "https://carrier.invalid/AB123456789",
        shipped_at: "2026-11-07T12:00:00Z",
        delivered_at: null,
        tracking_updated_at: "2026-11-07T13:00:00Z",
      }]);
    }
    if (target.pathname.endsWith("/pix_order_tracking_events")) {
      return jsonResponse([{ previous_status: "shipped", new_status: "in_transit", carrier: "Carrier", tracking_code: "AB123456789", tracking_url: null, created_at: "2026-11-07T13:00:00Z" }]);
    }
    throw new Error(`Unexpected mocked request: ${target.href}`);
  };
  const result = await trackOrder({
    httpMethod: "POST",
    headers: TEST_IP_HEADERS,
    body: JSON.stringify({ code: "AB123456789" }),
  });
  const output = JSON.parse(result.body);
  assert.equal(result.statusCode, 200);
  assert.equal(lookupQuery.get("status"), "eq.paid");
  assert.equal(output.tracking.code, "AB123456789");
  assert.equal("shippingAddress" in output, false);
  assert.equal("customer" in output, false);
  assert.equal("cep" in output, false);
});

test("tracking status regressions are rejected", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  });
  setOrderEnv();
  process.env.ORDER_OPERATIONS_TOKEN = "test-order-operations-token-which-is-long-enough";
  globalThis.fetch = async (url) => {
    if (String(url).includes("/rpc/consume_api_rate_limit")) return jsonResponse(true);
    return jsonResponse({ ok: false, error: "invalid_delivery_transition" });
  };
  const result = await updateTracking({
    httpMethod: "POST",
    headers: { ...TEST_IP_HEADERS, authorization: `Bearer ${process.env.ORDER_OPERATIONS_TOKEN}` },
    body: JSON.stringify({ orderId: "cccccccc-1111-4111-8111-cccccccccccc", deliveryStatus: "not_shipped" }),
  });
  assert.equal(result.statusCode, 409);
});

test("hardening migration declares private rate limits, payment association, and tracking history", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20261107192000_backend_hardening.sql", import.meta.url), "utf8");
  const trackingIndexMigration = await readFile(new URL("../supabase/migrations/20261107193000_tracking_code_unique.sql", import.meta.url), "utf8");
  assert.match(migration, /pix_payments_order_reference_fkey/);
  assert.match(migration, /pix_payments_gateway_transaction_id_unique/);
  assert.match(migration, /check_pix_payment_order_amount/);
  assert.match(migration, /checkout_token_key_version/);
  assert.match(migration, /pix_orders_id_reference_unique/);
  assert.match(migration, /create table if not exists public\.api_rate_limits/);
  assert.match(migration, /alter table public\.api_rate_limits enable row level security/);
  assert.match(migration, /create table if not exists public\.pix_order_tracking_events/);
  assert.match(migration, /update_pix_order_tracking/);
  assert.match(migration, /grant execute on function public\.consume_api_rate_limit/);
  assert.match(migration, /p_status not in \('pending', 'processing', 'under_review', 'failed', 'approved'\)/);
  assert.match(trackingIndexMigration, /pix_orders_tracking_code_unique/);
});
