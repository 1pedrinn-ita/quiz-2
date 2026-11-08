import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import crypto from "node:crypto";

const bridgeSource = await readFile(new URL("../public/assets/legacy-serverfn-bridge.js", import.meta.url), "utf8");
const selectionPage = await readFile(new URL("../public/selecionar/index.html", import.meta.url), "utf8");
const selectionScript = await readFile(new URL("../public/assets/unified-checkout.js", import.meta.url), "utf8");
const checkoutBundle = await readFile(new URL("../public/assets/checkout-BzjqSENo.js", import.meta.url), "utf8");
const ids = {
  checkout: "85a7da13ce7fdaba6b1e1edac497a7cc5455cf15bdf57dbd1be6c4e29433c09d",
  status: "6d27cbe0ea4d709aed7e944b11729a81069ef97d0cf496742f3d13cab275a658",
  lookup: "66943a4c13c970856d03ac8d649dcd873da796b5354a96cfa0fe11d5f8d4ee70",
  tracking: "0ecc198371f69ceb2760a2d869ec7911878c744ac3ba2408e7405cf50131d28a",
  trackingOrder: "e4509916e36b444c8db20f8d4ccc349c4e15ae1894a659614855e80cc58f7361",
  disabledServices: [
    "7554a5172ecf697a7ed1af0dac4020ee4176ff4191c09c425e2fca4100c7a1bb",
    "a260c68d52d944daec4017688a6d43886280184d1bc2fead388cdaa7d5c02834a",
  ],
};
const orderId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const checkoutToken = "f".repeat(64);
const accessCode = "CR-0123456789ABCDEF0123456789ABCDEF";
const expectedCheckoutAmount = 9790 + 1990 + 845;

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function setup(fetchImpl) {
  const context = {
    crypto: crypto.webcrypto,
    fetch: fetchImpl,
    sessionStorage: storage(),
    localStorage: storage(),
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    URLSearchParams,
    Date,
    Promise,
    encodeURIComponent,
    console,
  };
  vm.createContext(context);
  vm.runInContext(bridgeSource, context);
  return context;
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const checkoutData = {
  kitSizes: { shoe: "40", shirt: "M", shorts: "P" },
  offers: { socks: "39 a 44" },
  shipping: "express",
  customer: { name: "Cliente Fictício", email: "cliente@example.invalid", document: "529.982.247-25", phone: "(11) 99999-9999" },
  address: { street: "Rua de Teste", number: "10", complement: "Apto 2", neighborhood: "Centro", city: "São Paulo", state: "SP", zipcode: "01001-000" },
  tracking: { utm_source: "fixture" },
};

test("staging checkout adapts legacy payload to server catalog and simulated PIX", async () => {
  const calls = [];
  const context = setup(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === "/api/create-order") {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.items, [
        { sku: "corre-rosa-kit", quantity: 1, kitSizes: checkoutData.kitSizes },
        { sku: "socks", quantity: 1, variant: "39 a 44" },
        { sku: "express-shipping", quantity: 1 },
      ]);
      assert.equal(body.shippingAddress.cep, "01001000");
      assert.equal(body.shippingAddress.district, "Centro");
      assert.equal(body.shippingAddress.complement, "Apto 2");
      assert.equal(body.customer.document, "52998224725");
      assert.equal(body.customer.phone, "11999999999");
      assert.equal(options.headers["Idempotency-Key"].length > 20, true);
      return response({ orderId, checkoutToken, reference: `order-${orderId}`, amountCents: expectedCheckoutAmount });
    }
    if (String(url) === "/api/create-pix") {
      assert.match(options.headers.authorization, /^Bearer f{64}$/);
      return response({ simulated: true, status: "pending", qr_code: "SIMULATION-ONLY-NOT-A-PIX-test", amount_cents: expectedCheckoutAmount });
    }
    if (String(url) === "/api/issue-order-access-code") return response({ trackingAccess: accessCode });
    assert.fail(`Unexpected API route ${url}`);
  });

  const result = await context.__LEGACY_SERVERFN_ADAPTER__(ids.checkout, { data: checkoutData });
  assert.equal(result.id, orderId);
  assert.equal(result.amount, expectedCheckoutAmount);
  assert.equal(result.qrCode, "SIMULATION-ONLY-NOT-A-PIX-test");
  assert.equal(result.trackingAccess, accessCode);
  assert.equal(calls.length, 3);
  assert.equal(calls.some((call) => call.url.includes("pingupag")), false);
});

test("legacy checkout payload does not supply or control the amount", async () => {
  let calls = 0;
  const context = setup(async (url) => {
    calls += 1;
    if (String(url) === "/api/create-order") return response({ orderId, checkoutToken, reference: `order-${orderId}`, amountCents: 9790 + 1990 + 845 });
    if (String(url) === "/api/create-pix") return response({ simulated: true, status: "pending", qr_code: "SIMULATION-ONLY-NOT-A-PIX-test" });
    if (String(url) === "/api/issue-order-access-code") return response({ trackingAccess: accessCode });
    assert.fail(`Unexpected API route ${url}`);
  });
  const result = await context.__LEGACY_SERVERFN_ADAPTER__(ids.checkout, { data: { ...checkoutData, amount: 1 } });
  assert.equal(result.amount, 9790 + 1990 + 845);
  assert.equal(calls, 3);
});

test("unified selection route contains the three original kit pieces in order and uses original catalog assets", async () => {
  const positions = ["data-product=\"shoe\"", "data-product=\"shirt\"", "data-product=\"shorts\""]
    .map((needle) => selectionPage.indexOf(needle));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  for (const asset of ["tenis-galeria-v2.webp", "regata-frente.webp", "shorts-frente.webp"]) {
    assert.ok(existsSync(new URL(`../public/campaign/${asset}`, import.meta.url)));
    assert.ok(selectionPage.includes(asset));
  }
  assert.match(selectionScript, /Array\.from\(\{ length: 12 \}.*34/);
  assert.match(selectionScript, /const apparelSizes = \["P", "M", "G"\]/);
  assert.match(selectionScript, /window\.location\.assign\("\/checkout" \+ window\.location\.search\)/);
  assert.match(selectionPage, /id="continue-button"[^>]*disabled/);
  assert.equal((selectionPage.match(/class="unified-gallery"/g) || []).length, 0);
  assert.equal((selectionPage.match(/class="unified-product-checkout"/g) || []).length, 0);
  assert.doesNotMatch(selectionPage, /id="calculate-cep"/);
});

test("all store purchase CTAs and the review link open the unified selection page", async () => {
  const store = await readFile(new URL("../public/assets/loja-DMRDGVg2.js", import.meta.url), "utf8");
  assert.match(store, /L=\(\)=>\{window\.location\.assign\("\/selecionar\/"\+window\.location\.search\)\}/);
  assert.equal((store.match(/onClick:L,children:`(?:RESGATAR AGORA|COMPRAR AGORA)`/g) || []).length, 3);
  assert.match(store, /href:`\/selecionar\/`\+window\.location\.search,children:`Revisar meu kit e entrega`/);
});

test("checkout consumes the unified handoff and sends kit sizes through the existing order API", () => {
  assert.match(checkoutBundle, /corre-rosa-unified-selection-v1/);
  assert.match(checkoutBundle, /kitSizes:C/);
  assert.match(bridgeSource, /kitSizes: data\.kitSizes/);
  assert.match(bridgeSource, /express-shipping/);
});

test("unified checkout layout declares narrow mobile breakpoints and single-column shipping cards", async () => {
  const css = await readFile(new URL("../public/assets/unified-checkout.css", import.meta.url), "utf8");
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /@media\(max-width:340px\)/);
  assert.match(css, /\.unified-shipping\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(css, /width:calc\(100% - 20px\)/);
  assert.match(css, /\.unified-continue:disabled\{background:#94a3b8/);
});

test("checkout refuses to create an order if kit size choices are missing", async () => {
  let calls = 0;
  const context = setup(async () => { calls += 1; return response({}); });
  await assert.rejects(
    context.__LEGACY_SERVERFN_ADAPTER__(ids.checkout, { data: { ...checkoutData, kitSizes: undefined } }),
    /Selecione o tamanho de cada peça do kit/,
  );
  assert.equal(calls, 0);
});

test("payment status is read only from the authenticated backend response", async () => {
  const local = storage();
  const encode = (s) => Buffer.from(s).toString("base64url");
  local.setItem("corre-rosa:pending-order-tracking-access:v1", JSON.stringify({
    orderId,
    token: `v1.${encode(orderId)}.${encode(checkoutToken)}`,
    expiresAt: Date.now() + 60_000,
  }));
  const context = {
    crypto: crypto.webcrypto,
    fetch: async (url, options) => {
      assert.match(String(url), /^\/api\/orders\?orderId=/);
      assert.equal(options.headers.authorization, `Bearer ${checkoutToken}`);
      return response({ order: { id: orderId, status: "pending" }, payment: { status: "pending" }, delivery: { history: [] } });
    },
    localStorage: local,
    sessionStorage: storage(),
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    URLSearchParams,
    Date,
    Promise,
    encodeURIComponent,
    console,
  };
  vm.createContext(context);
  vm.runInContext(bridgeSource, context);
  const result = await context.__LEGACY_SERVERFN_ADAPTER__(ids.status, { data: { id: orderId } });
  assert.equal(result.status, "pending");
});

test("legacy order pages use private-token or one-time access-code APIs and expose no customer PII", async () => {
  const context = setup(async (url) => {
    assert.equal(String(url), "/api/lookup-order-by-access-code");
    return response({
      order: {
        id: orderId,
        reference: `order-${orderId}`,
        amountCents: 9790,
        description: "Produto fictício",
        shippingAddress: { street: "Rua Teste", number: "1", district: "Centro", city: "São Paulo", state: "SP", cep: "01001000" },
      },
      payment: { status: "approved", amountCents: 9790 },
      delivery: { status: "not_shipped", history: [] },
    });
  });
  const result = await context.__LEGACY_SERVERFN_ADAPTER__(ids.lookup, { data: { token: accessCode } });
  assert.equal(result.code, accessCode);
  assert.equal(result.status, "approved");
  assert.equal(result.address.zipcode, "01001000");
  assert.equal(JSON.stringify(result).includes("email"), false);
  assert.equal(JSON.stringify(result).includes("phone"), false);
  const tracking = await context.__LEGACY_SERVERFN_ADAPTER__(ids.tracking, { data: { code: accessCode } });
  assert.equal(tracking.code, accessCode);
});

test("legacy service-charge server functions fail closed in staging", async () => {
  const context = setup(async () => assert.fail("No gateway/API request expected"));
  for (const id of ids.disabledServices) {
    await assert.rejects(context.__LEGACY_SERVERFN_ADAPTER__(id, { data: { confirmRealCharge: true } }), /não está habilitada/i);
  }
});

test("tracking route can read an authenticated order but its charge functions remain disabled", async () => {
  const context = setup(async (url, options) => {
    assert.match(String(url), /^\/api\/orders\?orderId=/);
    assert.equal(options.headers.authorization, `Bearer ${checkoutToken}`);
    return response({ order: { id: orderId, customer: { name: "Cliente Fictício", email: "cliente@example.invalid", phone: "11999999999" }, status: "paid", amountCents: 9790, description: "Produto fictício" }, payment: { status: "approved" }, delivery: { history: [] } });
  });
  const encode = (value) => Buffer.from(value).toString("base64url");
  const token = `v1.${encode(orderId)}.${encode(checkoutToken)}`;
  const result = await context.__LEGACY_SERVERFN_ADAPTER__(ids.trackingOrder, { data: { token } });
  assert.equal(result.ok, true);
  assert.equal(result.customer.name, "Cliente Fictício");
});

test("recovered local JavaScript import graph resolves and original recovered transport stays untouched", async () => {
  const assetsDir = new URL("../public/assets/", import.meta.url);
  const files = await readdir(assetsDir);
  const jsFiles = files.filter((name) => name.endsWith(".js"));
  const missing = [];
  for (const name of jsFiles) {
    const source = await readFile(new URL(name, assetsDir), "utf8");
    const imports = /(?:\bfrom\s*|\bimport\s*\()(["'])(\.[^"']+)\1/g;
    for (const match of source.matchAll(imports)) {
      const target = path.resolve(path.dirname(fileURLToPath(new URL(name, assetsDir))), match[2]);
      if (!existsSync(target)) missing.push(`${name} -> ${match[2]}`);
    }
  }
  assert.deepEqual(missing, []);
  const originalTransport = await readFile(new URL("../../ocorrecorrendotudo/assets/createServerFn-BvYVUQWk.js", import.meta.url), "utf8");
  const stagingTransport = await readFile(new URL("../public/assets/createServerFn-BvYVUQWk.js", import.meta.url), "utf8");
  assert.equal(originalTransport.includes("__LEGACY_SERVERFN_ADAPTER__"), false);
  assert.equal(stagingTransport.includes("__LEGACY_SERVERFN_ADAPTER__"), true);
});
