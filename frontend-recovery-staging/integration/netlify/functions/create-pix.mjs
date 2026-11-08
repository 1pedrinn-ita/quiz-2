// Staging-only simulated PIX endpoint. This intentionally never imports or
// calls the PinguPag client. Keep the production function in the project root.
import crypto from "node:crypto";
import { jsonResponse, methodNotAllowed, supabaseRequest } from "../lib/supabase.mjs";
import { bodyWithinLimit, enforceRateLimits, safeEqual, validUuid } from "../lib/orders.mjs";

function response(statusCode, body) {
  const result = jsonResponse(statusCode, body);
  result.headers["cache-control"] = "no-store";
  return result;
}

function bearerToken(event) {
  const headers = event.headers || {};
  const value = headers.authorization || headers.Authorization || "";
  const match = /^Bearer ([A-Za-z0-9._-]{32,256})$/.exec(value);
  return match?.[1] || null;
}

async function readPayment(orderId, env) {
  const query = new URLSearchParams({
    select: "id,status,qr_code,qr_code_base64,expires_at,reference,amount_cents",
    order_id: `eq.${orderId}`,
    limit: "1",
  });
  const rows = await supabaseRequest(`pix_payments?${query}`, {}, env);
  return Array.isArray(rows) ? rows[0] : undefined;
}

export async function handler(event, context) {
  if (event.httpMethod !== "POST") return methodNotAllowed("POST");
  if (!bodyWithinLimit(event, 8 * 1024)) return response(413, { error: "Request body too large" });
  if (process.env.STAGING_SIMULATOR_ENABLED !== "true") {
    return response(503, { error: "Staging payment simulator is disabled" });
  }
  try {
    if (!await enforceRateLimits(event, "staging-create-pix", [
      { maxRequests: 10, windowSeconds: 60 },
      { maxRequests: 60, windowSeconds: 3600 },
    ], context)) return response(429, { error: "Too many simulated payment requests" });
  } catch {
    return response(503, { error: "Staging payment service is unavailable" });
  }
  let body;
  try { body = JSON.parse(event.body || ""); } catch { return response(400, { error: "Invalid JSON body" }); }
  const orderId = body?.orderId;
  const token = bearerToken(event) || body?.checkoutToken;
  if (!validUuid(orderId) || typeof token !== "string" || token.length < 32 || token.length > 256) {
    return response(400, { error: "Invalid order credentials" });
  }
  const env = process.env;
  try {
    if (!await enforceRateLimits(event, `staging-create-pix-order:${orderId}`, [
      { maxRequests: 4, windowSeconds: 600 },
    ], context)) return response(429, { error: "Too many simulated payment attempts" });
    const query = new URLSearchParams({
      select: "id,reference,amount_cents,status,checkout_token_hash",
      id: `eq.${orderId}`,
      limit: "1",
    });
    const orders = await supabaseRequest(`pix_orders?${query}`, {}, env);
    const order = Array.isArray(orders) ? orders[0] : undefined;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    if (!order || order.status !== "pending" || !safeEqual(tokenHash, order.checkout_token_hash)) {
      return response(404, { error: "Order not found or unavailable" });
    }

    let payment = await readPayment(order.id, env);
    if (!payment) {
      const simulatedTransactionId = `sim_${crypto.randomUUID()}`;
      const insert = await supabaseRequest("pix_payments?on_conflict=order_id", {
        method: "POST",
        headers: { prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify({
          order_id: order.id,
          reference: order.reference,
          amount_cents: order.amount_cents,
          gateway_transaction_id: simulatedTransactionId,
          status: "pending",
          qr_code: `SIMULATION-ONLY-NOT-A-PIX-${crypto.randomUUID()}`,
        }),
      }, env);
      payment = Array.isArray(insert) ? insert[0] : undefined;
      payment ||= await readPayment(order.id, env);
    }
    if (!payment || payment.reference !== order.reference || payment.amount_cents !== order.amount_cents) {
      return response(409, { error: "Simulated payment requires reconciliation" });
    }
    if (!["pending", "approved"].includes(payment.status)) {
      return response(409, { error: "Order is not payable" });
    }
    return response(200, {
      id: order.id,
      status: payment.status,
      qr_code: payment.qr_code || `SIMULATION-ONLY-NOT-A-PIX-${order.id}`,
      qr_code_base64: null,
      expires_at: null,
      reference: order.reference,
      amount_cents: order.amount_cents,
      simulated: true,
    });
  } catch (error) {
    console.error("Staging simulated payment failed", { status: error.status || "internal_error" });
    return response(500, { error: "Unable to create simulated payment" });
  }
}
