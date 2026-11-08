import crypto from "node:crypto";
import { supabaseRequest } from "./supabase.mjs";

export function validUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function bearerToken(event) {
  const headers = event.headers || {};
  const authorization = headers.authorization || headers.Authorization;
  const match = typeof authorization === "string"
    ? authorization.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)
    : null;
  return match?.[1];
}

export function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function validCpf(value) {
  if (typeof value !== "string" || !/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) {
    return false;
  }
  const digits = [...value].map(Number);
  for (const length of [9, 10]) {
    const sum = digits.slice(0, length).reduce((total, digit, index) => {
      return total + digit * (length + 1 - index);
    }, 0);
    const remainder = (sum * 10) % 11;
    const checkDigit = remainder === 10 ? 0 : remainder;
    if (checkDigit !== digits[length]) return false;
  }
  return true;
}

export function validTrackingCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{3,119}$/.test(value);
}

export function checkoutTokenSecrets(env = process.env) {
  let secrets;
  if (typeof env.CHECKOUT_TOKEN_SECRETS_JSON === "string") {
    try {
      secrets = JSON.parse(env.CHECKOUT_TOKEN_SECRETS_JSON);
    } catch {
      throw new Error("CHECKOUT_TOKEN_SECRETS_JSON is invalid");
    }
  } else if (typeof env.CHECKOUT_TOKEN_SECRET === "string") {
    // Version 1 preserves tokens already issued by the original implementation.
    secrets = { "1": env.CHECKOUT_TOKEN_SECRET };
  } else {
    throw new Error("Missing checkout token secrets");
  }
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
    throw new Error("CHECKOUT_TOKEN_SECRETS_JSON must be an object");
  }
  for (const [version, secret] of Object.entries(secrets)) {
    if (!/^[1-9]\d{0,3}$/.test(version) || typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error("Checkout token secret configuration is invalid");
    }
  }
  return secrets;
}

export function activeCheckoutTokenVersion(env = process.env) {
  const raw = env.CHECKOUT_TOKEN_ACTIVE_VERSION ?? "1";
  if (!/^[1-9]\d{0,3}$/.test(String(raw))) throw new Error("Invalid active checkout token version");
  const version = Number(raw);
  if (!checkoutTokenSecrets(env)[String(version)]) throw new Error("Active checkout token secret is unavailable");
  return version;
}

export function checkoutTokenForOrder(orderId, version = 1, env = process.env) {
  const secret = checkoutTokenSecrets(env)[String(version)];
  if (!secret) throw new Error("Checkout token version is unavailable");
  const message = version === 1 ? orderId : `checkout-token:v${version}:${orderId}`;
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

export function maxOrderAmountCents(env = process.env) {
  const value = env.PIX_MAX_AMOUNT_CENTS;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("PIX_MAX_AMOUNT_CENTS is required");
  }
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 2_147_483_647) {
    throw new Error("PIX_MAX_AMOUNT_CENTS must be between 1 and 2147483647");
  }
  return amount;
}

export function bodyWithinLimit(event, maxBytes) {
  const body = typeof event.body === "string" ? event.body : "";
  if (event.isBase64Encoded) {
    if (body.length > Math.ceil(maxBytes * 4 / 3) + 8) return false;
    return Buffer.byteLength(Buffer.from(body, "base64")) <= maxBytes;
  }
  return Buffer.byteLength(body, "utf8") <= maxBytes;
}

function clientIp(event, context) {
  const headers = event.headers || {};
  const candidate = context?.ip ||
    headers["x-nf-client-connection-ip"] ||
    headers["X-Nf-Client-Connection-Ip"] ||
    event.requestContext?.identity?.sourceIp;
  if (typeof candidate !== "string" || candidate.length > 64 || !/^[0-9a-fA-F:.]+$/.test(candidate)) {
    return null;
  }
  return candidate;
}

export async function enforceRateLimits(event, scope, limits, context) {
  const env = process.env;
  const ip = clientIp(event, context);
  const secret = env.RATE_LIMIT_SECRET;
  if (!ip || typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    const error = new Error("Rate limiting is not configured");
    error.status = 503;
    throw error;
  }
  for (const limit of limits) {
    const bucketHash = crypto.createHmac("sha256", secret)
      .update(`${scope}:${ip}:${limit.windowSeconds}`)
      .digest("hex");
    const allowed = await supabaseRequest(
      "rpc/consume_api_rate_limit",
      {
        method: "POST",
        body: JSON.stringify({
          p_bucket_hash: bucketHash,
          p_limit: limit.maxRequests,
          p_window_seconds: limit.windowSeconds,
        }),
      },
      env,
    );
    if (allowed !== true) return false;
  }
  return true;
}

export function parseCatalog(env = process.env) {
  if (typeof env.PIX_ORDER_CATALOG_JSON !== "string") {
    throw new Error("Missing PIX_ORDER_CATALOG_JSON");
  }
  let catalog;
  try {
    catalog = JSON.parse(env.PIX_ORDER_CATALOG_JSON);
  } catch {
    throw new Error("PIX_ORDER_CATALOG_JSON is invalid");
  }
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("PIX_ORDER_CATALOG_JSON must be an object");
  }
  for (const [sku, product] of Object.entries(catalog)) {
    if (
      !/^[A-Za-z0-9_-]{1,80}$/.test(sku) ||
      !product ||
      typeof product.name !== "string" ||
      product.name.trim().length < 1 ||
      product.name.trim().length > 200 ||
      !Number.isSafeInteger(product.unitAmountCents) ||
      product.unitAmountCents < 1 ||
      (product.requiresShipping !== undefined &&
        typeof product.requiresShipping !== "boolean")
    ) {
      throw new Error("PIX_ORDER_CATALOG_JSON contains an invalid product");
    }
  }
  return catalog;
}

export function validateCustomer(customer) {
  if (!customer || typeof customer !== "object" || Array.isArray(customer)) {
    return null;
  }
  const name = typeof customer.name === "string" ? customer.name.trim() : "";
  const email = typeof customer.email === "string" ? customer.email.trim().toLowerCase() : "";
  const document = typeof customer.document === "string"
    ? customer.document.replace(/\D/g, "")
    : "";
  const phone = typeof customer.phone === "string"
    ? customer.phone.replace(/\D/g, "")
    : "";
  if (
    name.length < 2 || name.length > 200 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
    !validCpf(document) || !/^\d{10,13}$/.test(phone)
  ) {
    return null;
  }
  return { name, email, document, phone };
}

export function validateShippingAddress(address) {
  if (!address || typeof address !== "object" || Array.isArray(address)) {
    return null;
  }
  const fields = ["street", "number", "district", "city", "state", "cep"];
  const normalized = {};
  for (const field of fields) {
    if (typeof address[field] !== "string") return null;
    normalized[field] = address[field].trim();
    if (!normalized[field] || normalized[field].length > 160) return null;
  }
  normalized.state = normalized.state.toUpperCase();
  normalized.cep = normalized.cep.replace(/\D/g, "");
  if (!/^[A-Z]{2}$/.test(normalized.state) || !/^\d{8}$/.test(normalized.cep)) {
    return null;
  }
  if (address.complement !== undefined) {
    if (typeof address.complement !== "string" || address.complement.length > 160) {
      return null;
    }
    normalized.complement = address.complement.trim();
  }
  return normalized;
}

export function normalizeOrder(body, catalog, maxAmountCents = 2_147_483_647) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const customer = validateCustomer(body.customer);
  if (!customer || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) {
    return null;
  }

  const items = [];
  let amountCents = 0;
  let requiresShipping = false;
  for (const input of body.items) {
    if (
      !input || typeof input !== "object" || Array.isArray(input) ||
      typeof input.sku !== "string" || !Number.isSafeInteger(input.quantity) ||
      input.quantity < 1 || input.quantity > 20
    ) {
      return null;
    }
    const product = catalog[input.sku];
    if (!product) return null;
    const lineTotalCents = product.unitAmountCents * input.quantity;
    if (
      !Number.isSafeInteger(lineTotalCents) ||
      !Number.isSafeInteger(amountCents + lineTotalCents) ||
      amountCents + lineTotalCents > maxAmountCents
    ) {
      return null;
    }
    amountCents += lineTotalCents;
    requiresShipping ||= product.requiresShipping === true;
    items.push({
      sku: input.sku,
      name: product.name.trim(),
      quantity: input.quantity,
      unit_amount_cents: product.unitAmountCents,
      line_total_cents: lineTotalCents,
    });
  }

  const shippingAddress = body.shippingAddress === undefined
    ? null
    : validateShippingAddress(body.shippingAddress);
  if ((body.shippingAddress !== undefined && !shippingAddress) || (requiresShipping && !shippingAddress)) {
    return null;
  }

  const description = [...new Set(items.map((item) => item.name))].join(", ").slice(0, 255);
  return {
    customer,
    items,
    shippingAddress,
    amountCents,
    description,
    fingerprint: crypto.createHash("sha256").update(JSON.stringify({
      customer,
      items,
      shippingAddress,
      amountCents,
    })).digest("hex"),
  };
}
