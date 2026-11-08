import crypto from "node:crypto";
import { jsonResponse, methodNotAllowed, supabaseRequest } from "../lib/supabase.mjs";
import { bodyWithinLimit, enforceRateLimits } from "../lib/orders.mjs";

function response(statusCode, body) {
  const result = jsonResponse(statusCode, body);
  result.headers["cache-control"] = "no-store";
  return result;
}

export async function handler(event, context) {
  if (event.httpMethod !== "POST") return methodNotAllowed("POST");
  if (!bodyWithinLimit(event, 1024)) return response(413, { error: "Request body too large" });
  let body;
  try { body = JSON.parse(event.body || ""); } catch { return response(400, { error: "Invalid JSON body" }); }
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!/^CR-[A-F0-9]{32}$/.test(code)) return response(404, { error: "Order not found" });
  try {
    if (!await enforceRateLimits(event, "lookup-order-access-code", [
      { maxRequests: 30, windowSeconds: 60 },
      { maxRequests: 120, windowSeconds: 3600 },
    ], context)) return response(429, { error: "Too many order lookups" });
    const hash = crypto.createHash("sha256").update(code).digest("hex");
    if (!await enforceRateLimits(event, `lookup-order-access-code:${hash}`, [
      { maxRequests: 10, windowSeconds: 60 },
    ], context)) return response(429, { error: "Too many order lookups" });
    const query = new URLSearchParams({
      select: "id,reference,amount_cents,description,order_items,shipping_address,status,created_at,delivery_status,carrier,tracking_code,tracking_url,shipped_at,delivered_at,tracking_updated_at",
      legacy_access_code_hash: `eq.${hash}`,
      limit: "2",
    });
    const orders = await supabaseRequest(`pix_orders?${query}`, {}, process.env);
    if (!Array.isArray(orders) || orders.length !== 1) return response(404, { error: "Order not found" });
    const order = orders[0];
    if (order.status !== "paid") return response(404, { error: "Order not found" });
    const paymentsQuery = new URLSearchParams({
      select: "status,amount_cents,reference",
      order_id: `eq.${order.id}`,
      limit: "1",
    });
    const payments = await supabaseRequest(`pix_payments?${paymentsQuery}`, {}, process.env);
    const payment = Array.isArray(payments) ? payments[0] : undefined;
    if (!payment || payment.status !== "approved" || payment.amount_cents !== order.amount_cents || payment.reference !== order.reference) {
      return response(404, { error: "Order not found" });
    }
    const historyQuery = new URLSearchParams({
      select: "previous_status,new_status,carrier,tracking_code,tracking_url,created_at",
      order_id: `eq.${order.id}`,
      order: "created_at.asc,id.asc",
      limit: "100",
    });
    const history = await supabaseRequest(`pix_order_tracking_events?${historyQuery}`, {}, process.env);
    return response(200, {
      order: {
        id: order.id,
        reference: order.reference,
        amountCents: order.amount_cents,
        description: order.description,
        items: order.order_items,
        shippingAddress: order.shipping_address,
        status: order.status,
        createdAt: order.created_at,
      },
      payment: { status: payment.status, amountCents: payment.amount_cents },
      delivery: {
        status: order.delivery_status,
        carrier: order.carrier,
        trackingCode: order.tracking_code,
        trackingUrl: order.tracking_url,
        shippedAt: order.shipped_at,
        deliveredAt: order.delivered_at,
        updatedAt: order.tracking_updated_at,
        history: Array.isArray(history) ? history : [],
      },
    });
  } catch (error) {
    console.error("Order access-code lookup failed", { status: error.status || "internal_error" });
    return response(500, { error: "Unable to retrieve order" });
  }
}
