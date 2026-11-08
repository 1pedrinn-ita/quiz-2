import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { handler as createPix } from "../netlify/functions/create-pix.mjs";
import { handler as simulateApproval } from "../netlify/functions/staging-simulate-approval.mjs";
import { handler as issueAccess } from "../netlify/functions/issue-order-access-code.mjs";
import { handler as lookupAccess } from "../netlify/functions/lookup-order-by-access-code.mjs";
import { normalizeOrder } from "../netlify/lib/orders.mjs";

const orderId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const checkoutToken = "f".repeat(64);
const reference = `order-${orderId}`;
const amountCents = 12500;
const ip = { "x-nf-client-connection-ip": "203.0.113.18" };
const envNames = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RATE_LIMIT_SECRET", "ORDER_ACCESS_CODE_SECRET", "STAGING_SIMULATOR_ENABLED", "STAGING_SIMULATOR_SECRET"];
function saveEnv() { return Object.fromEntries(envNames.map((key) => [key, process.env[key]])); }
function restoreEnv(saved) { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; }
function setupEnv() {
  process.env.SUPABASE_URL = "https://supabase.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.RATE_LIMIT_SECRET = "test-rate-limit-secret-at-least-32-bytes-long";
  process.env.ORDER_ACCESS_CODE_SECRET = "test-order-access-secret-at-least-32-bytes-long";
  process.env.STAGING_SIMULATOR_ENABLED = "true";
  process.env.STAGING_SIMULATOR_SECRET = "test-simulator-secret-at-least-32-bytes-long";
}
function response(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function orderRow(overrides = {}) {
  return {
    id: orderId,
    reference,
    amount_cents: amountCents,
    status: "pending",
    checkout_token_hash: hash(checkoutToken),
    legacy_access_code_hash: null,
    ...overrides,
  };
}

test("staging create-pix creates one non-payable simulated record and reuses it", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => { restoreEnv(saved); globalThis.fetch = originalFetch; });
  setupEnv();
  let inserts = 0;
  let payment = null;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes("rpc/consume_api_rate_limit")) return response(true);
    if (u.includes("/rest/v1/pix_orders?")) return response([orderRow()]);
    if (u.includes("/rest/v1/pix_payments?") && options.method === "POST") {
      inserts += 1;
      payment = { id: "payment-fixture", order_id: orderId, reference, amount_cents: amountCents, status: "pending", gateway_transaction_id: "sim-fixture", qr_code: JSON.parse(options.body).qr_code };
      assert.match(payment.qr_code, /^SIMULATION-ONLY-NOT-A-PIX-/);
      assert.equal(options.headers.prefer.includes("resolution=ignore-duplicates"), true);
      return response([payment]);
    }
    if (u.includes("/rest/v1/pix_payments?")) return response(payment ? [payment] : []);
    assert.fail(`Unexpected Supabase request ${u}`);
  };
  const event = {
    httpMethod: "POST", headers: { ...ip, authorization: `Bearer ${checkoutToken}` },
    body: JSON.stringify({ orderId }),
  };
  const first = await createPix(event, {});
  const second = await createPix(event, {});
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(JSON.parse(first.body).simulated, true);
  assert.equal(JSON.parse(first.body).status, "pending");
  assert.equal(inserts, 1);
});

test("simulated approval is operator-secret protected and applies server-stored amount/reference", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => { restoreEnv(saved); globalThis.fetch = originalFetch; });
  setupEnv();
  let applied;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes("/rest/v1/pix_payments?")) return response([{ reference, amount_cents: amountCents, status: "pending" }]);
    if (u.includes("/rest/v1/rpc/apply_pix_gateway_status")) { applied = JSON.parse(options.body); return response(true); }
    assert.fail(`Unexpected request ${u}`);
  };
  const event = { httpMethod: "POST", headers: { ...ip }, body: JSON.stringify({ orderId }) };
  const denied = await simulateApproval(event);
  assert.equal(denied.statusCode, 404);
  const accepted = await simulateApproval({ ...event, headers: { ...ip, authorization: `Bearer ${process.env.STAGING_SIMULATOR_SECRET}` } });
  assert.equal(accepted.statusCode, 200);
  assert.equal(JSON.parse(accepted.body).simulated, true);
  assert.deepEqual(applied, {
    p_reference: reference,
    p_amount_cents: amountCents,
    p_gateway_transaction_id: `sim_${orderId}`,
    p_status: "approved",
  });
});

test("legacy access codes are unique, stored only as digests, and lookup releases no PII or invented history", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => { restoreEnv(saved); globalThis.fetch = originalFetch; });
  setupEnv();
  let persistedHash;
  const secondOrderId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes("rpc/consume_api_rate_limit")) return response(true);
    if (u.includes("/rest/v1/pix_orders?") && options.method === "PATCH") {
      const body = JSON.parse(options.body);
      persistedHash = body.legacy_access_code_hash;
      assert.match(persistedHash, /^[a-f0-9]{64}$/);
      assert.equal(options.body.includes("CR-"), false);
      return response(null);
    }
    if (u.includes("legacy_access_code_hash=eq.")) return response([orderRow({
      status: "paid", order_items: [{ sku: "fixture" }],
      shipping_address: { street: "Rua Teste", number: "4", district: "Centro", city: "São Paulo", state: "SP", cep: "01001000" },
      delivery_status: "shipped", carrier: "Correios", tracking_code: "BR123456789XX",
      tracking_url: "https://tracking.example.invalid/BR123456789XX",
    })]);
    if (u.includes("/rest/v1/pix_orders?")) return response([u.includes(secondOrderId)
      ? orderRow({ id: secondOrderId, reference: `order-${secondOrderId}` })
      : orderRow()]);
    if (u.includes("/rest/v1/pix_payments?")) return response([{ status: "approved", amount_cents: amountCents, reference }]);
    if (u.includes("/rest/v1/pix_order_tracking_events?")) return response([{
      previous_status: "not_shipped", new_status: "shipped", carrier: "Correios",
      tracking_code: "BR123456789XX", tracking_url: "https://tracking.example.invalid/BR123456789XX",
      created_at: "2026-11-07T12:00:00Z",
    }]);
    assert.fail(`Unexpected request ${u}`);
  };

  const issued = await issueAccess({ httpMethod: "POST", headers: { ...ip, authorization: `Bearer ${checkoutToken}` }, body: JSON.stringify({ orderId }) }, {});
  const code = JSON.parse(issued.body).trackingAccess;
  assert.equal(issued.statusCode, 200);
  assert.match(code, /^CR-[A-F0-9]{32}$/);
  assert.equal(persistedHash, hash(code));
  const firstCodeHash = persistedHash;
  const retried = await issueAccess({ httpMethod: "POST", headers: { ...ip, authorization: `Bearer ${checkoutToken}` }, body: JSON.stringify({ orderId }) }, {});
  assert.equal(JSON.parse(retried.body).trackingAccess, code);
  const secondIssued = await issueAccess({ httpMethod: "POST", headers: { ...ip, authorization: `Bearer ${checkoutToken}` }, body: JSON.stringify({ orderId: secondOrderId }) }, {});
  assert.notEqual(JSON.parse(secondIssued.body).trackingAccess, code);
  assert.match(JSON.parse(secondIssued.body).trackingAccess, /^CR-[A-F0-9]{32}$/);
  assert.notEqual(persistedHash, firstCodeHash);
  assert.equal(persistedHash, hash(JSON.parse(secondIssued.body).trackingAccess));

  const found = await lookupAccess({ httpMethod: "POST", headers: ip, body: JSON.stringify({ code }) }, {});
  const result = JSON.parse(found.body);
  assert.equal(found.statusCode, 200);
  assert.equal(JSON.stringify(result).includes("customer"), false);
  assert.equal(JSON.stringify(result).includes("email"), false);
  assert.equal(JSON.stringify(result).includes("phone"), false);
  assert.equal(result.delivery.history.length, 1);
  assert.equal(result.delivery.history[0].new_status, "shipped");
  assert.equal(result.delivery.history.some((event) => event.new_status === "in_transit"), false);
});

test("access code lookup hides unpaid and malformed requests", async (t) => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  t.after(() => { restoreEnv(saved); globalThis.fetch = originalFetch; });
  setupEnv();
  let requestCount = 0;
  globalThis.fetch = async (url) => {
    requestCount += 1;
    const u = String(url);
    if (u.includes("rpc/consume_api_rate_limit")) return response(true);
    if (u.includes("legacy_access_code_hash=eq.")) return response([orderRow({ status: "pending" })]);
    assert.fail(`Unexpected request ${u}`);
  };
  const invalid = await lookupAccess({ httpMethod: "POST", headers: ip, body: JSON.stringify({ code: "CR-short" }) }, {});
  assert.equal(invalid.statusCode, 404);
  assert.equal(requestCount, 0);
  const unpaid = await lookupAccess({ httpMethod: "POST", headers: ip, body: JSON.stringify({ code: "CR-0123456789ABCDEF0123456789ABCDEF" }) }, {});
  assert.equal(unpaid.statusCode, 404);
});

test("order normalization preserves kit sizes, known sock variants, and associates CEP with address", () => {
  const catalog = {
    "corre-rosa-kit": { name: "Kit Corre Rosa", unitAmountCents: 9790, requiresShipping: true },
    socks: { name: "Kit com 6 Meias Unissex", unitAmountCents: 1990, requiresShipping: true },
  };
  const normalized = normalizeOrder({
    items: [
      { sku: "corre-rosa-kit", quantity: 1, kitSizes: { shoe: "40", shirt: "M", shorts: "P" } },
      { sku: "socks", quantity: 1, variant: "39 a 44" },
    ],
    customer: { name: "Cliente Fictício", email: "cliente@example.invalid", document: "52998224725", phone: "11999999999" },
    shippingAddress: { street: "Rua de Teste", number: "10", district: "Centro", city: "São Paulo", state: "sp", cep: "01001-000" },
  }, catalog, 100000);
  assert.equal(normalized.amountCents, 11780);
  assert.equal(normalized.items[1].variant, "39 a 44");
  assert.deepEqual(normalized.items[0].kit_sizes, { shoe: "40", shirt: "M", shorts: "P" });
  assert.equal(normalized.shippingAddress.cep, "01001000");
  assert.equal(normalized.shippingAddress.city, "São Paulo");
  assert.equal(normalizeOrder({
    items: [{ sku: "corre-rosa-kit", quantity: 1 }],
    customer: { name: "Cliente Fictício", email: "cliente@example.invalid", document: "52998224725", phone: "11999999999" },
    shippingAddress: { street: "Rua Teste", number: "1", district: "Centro", city: "São Paulo", state: "SP", cep: "01001000" },
  }, catalog, 100000), null);
  assert.equal(normalizeOrder({
    items: [
      { sku: "corre-rosa-kit", quantity: 1, kitSizes: { shoe: "46", shirt: "M", shorts: "P" } },
      { sku: "socks", quantity: 1, variant: "XL" },
    ],
    customer: { name: "Cliente Fictício", email: "cliente@example.invalid", document: "52998224725", phone: "11999999999" },
    shippingAddress: { street: "Rua de Teste", number: "10", district: "Centro", city: "São Paulo", state: "SP", cep: "01001000" },
  }, catalog, 100000), null);
});

test("staging migration is additive, idempotent, indexed, and keeps public roles revoked", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20261107200000_staging_order_access_codes.sql", import.meta.url), "utf8");
  assert.match(migration, /add column if not exists legacy_access_code_hash text/i);
  assert.match(migration, /check \(legacy_access_code_hash is null or legacy_access_code_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/i);
  assert.match(migration, /create unique index if not exists pix_orders_legacy_access_code_hash_unique/i);
  assert.match(migration, /where legacy_access_code_hash is not null/i);
  assert.match(migration, /revoke all on public\.pix_orders from anon, authenticated/i);
  assert.match(migration, /grant select, insert, update on public\.pix_orders to service_role/i);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);
  assert.equal((migration.match(/\$\$/g) || []).length, 2);
});

test("staging environment template includes all backend variables and points only to local Supabase", async () => {
  const template = await readFile(new URL("../.env.staging.example", import.meta.url), "utf8");
  const configured = new Set(template.split(/\r?\n/).filter((line) => /^[A-Z0-9_]+=/.test(line)).map((line) => line.slice(0, line.indexOf("="))));
  for (const key of [
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CHECKOUT_TOKEN_SECRET",
    "RATE_LIMIT_SECRET", "ORDER_ACCESS_CODE_SECRET", "ORDER_OPERATIONS_TOKEN",
    "PIX_MAX_AMOUNT_CENTS", "PIX_ORDER_CATALOG_JSON", "STAGING_SIMULATOR_ENABLED",
    "STAGING_SIMULATOR_SECRET",
  ]) assert.equal(configured.has(key), true, `${key} missing from staging template`);
  assert.match(template, /^SUPABASE_URL=http:\/\/127\.0\.0\.1:54321$/m);
  assert.match(template, /^STAGING_SIMULATOR_ENABLED=false$/m);
  assert.equal(/SUPABASE_URL=.*(?:supabase\.co|netlify\.app)/i.test(template), false);
});
