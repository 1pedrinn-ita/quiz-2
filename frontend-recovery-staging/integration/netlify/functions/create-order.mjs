import crypto from "node:crypto";
import { jsonResponse, methodNotAllowed, supabaseRequest } from "../lib/supabase.mjs";
import {
  checkoutTokenForOrder,
  activeCheckoutTokenVersion,
  bodyWithinLimit,
  enforceRateLimits,
  maxOrderAmountCents,
  normalizeOrder,
  parseCatalog,
} from "../lib/orders.mjs";

function idempotencyKey(event) {
  const headers = event.headers || {};
  const key = headers["idempotency-key"] || headers["Idempotency-Key"];
  return typeof key === "string" && key.length >= 16 && key.length <= 200
    ? key
    : null;
}

function response(statusCode, body) {
  const result = jsonResponse(statusCode, body);
  result.headers["cache-control"] = "no-store";
  return result;
}

export async function handler(event, context) {
  if (event.httpMethod !== "POST") return methodNotAllowed("POST");
  if (!bodyWithinLimit(event, 16 * 1024)) return response(413, { error: "Request body too large" });

  try {
    if (!await enforceRateLimits(event, "create-order", [
      { maxRequests: 10, windowSeconds: 60 },
      { maxRequests: 80, windowSeconds: 3600 },
    ], context)) {
      return response(429, { error: "Too many order requests" });
    }
  } catch (error) {
    console.error("Order rate limit unavailable", { status: error.status || "internal_error" });
    return response(503, { error: "Order service is temporarily unavailable" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "");
  } catch {
    return response(400, { error: "Invalid JSON body" });
  }

  const key = idempotencyKey(event);
  if (!key) return response(400, { error: "A valid Idempotency-Key header is required" });

  try {
    if (
      !process.env.PIX_ORDER_CATALOG_JSON ||
      !process.env.PIX_MAX_AMOUNT_CENTS ||
      (typeof process.env.CHECKOUT_TOKEN_SECRETS_JSON !== "string" &&
        (typeof process.env.CHECKOUT_TOKEN_SECRET !== "string" ||
          Buffer.byteLength(process.env.CHECKOUT_TOKEN_SECRET, "utf8") < 32))
    ) {
      return response(503, { error: "Order service is not configured" });
    }
    const catalog = parseCatalog(process.env);
    let maxAmountCents;
    try {
      maxAmountCents = maxOrderAmountCents(process.env);
    } catch {
      return response(503, { error: "Order amount limit is not configured" });
    }
    const tokenVersion = activeCheckoutTokenVersion(process.env);
    const orderInput = normalizeOrder(body, catalog, maxAmountCents);
    if (!orderInput) return response(400, { error: "Invalid order data" });

    const idempotencyHash = crypto.createHash("sha256").update(key).digest("hex");
    const candidateId = crypto.randomUUID();
    const candidateReference = `order-${candidateId}`;
    const checkoutToken = checkoutTokenForOrder(candidateId, tokenVersion, process.env);
    const result = await supabaseRequest(
      "rpc/create_pix_order",
      {
        method: "POST",
        body: JSON.stringify({
          p_id: candidateId,
          p_reference: candidateReference,
          p_amount_cents: orderInput.amountCents,
          p_description: orderInput.description,
          p_customer: orderInput.customer,
          p_order_items: orderInput.items,
          p_shipping_address: orderInput.shippingAddress,
          p_checkout_token_hash: crypto.createHash("sha256").update(checkoutToken).digest("hex"),
          p_checkout_token_key_version: tokenVersion,
          p_idempotency_key_hash: idempotencyHash,
          p_request_fingerprint: orderInput.fingerprint,
        }),
      },
      process.env,
    );

    if (!result || typeof result !== "object" || !result.order) {
      throw new Error("Supabase returned an invalid order result");
    }
    if (result.created !== true && result.order.request_fingerprint !== orderInput.fingerprint) {
      return response(409, { error: "Idempotency key was already used for a different order" });
    }

    const order = result.order;
    return response(result.created === true ? 201 : 200, {
      orderId: order.id,
      reference: order.reference,
      amountCents: order.amount_cents,
      status: order.status,
      checkoutToken: checkoutTokenForOrder(
        order.id,
        order.checkout_token_key_version || 1,
        process.env,
      ),
    });
  } catch (error) {
    console.error("Order creation failed", { status: error.status || "internal_error" });
    return response(error.status === 503 ? 503 : 500, { error: "Unable to create order" });
  }
}
