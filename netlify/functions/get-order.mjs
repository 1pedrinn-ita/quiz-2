import crypto from "node:crypto";
import { jsonResponse, methodNotAllowed, supabaseRequest } from "../lib/supabase.mjs";
import { bearerToken, enforceRateLimits, safeEqual, validUuid } from "../lib/orders.mjs";

function response(statusCode, body) {
  const result = jsonResponse(statusCode, body);
  result.headers["cache-control"] = "no-store";
  result.headers["vary"] = "authorization";
  return result;
}

export async function handler(event, context) {
  if (event.httpMethod !== "GET") return methodNotAllowed("GET");
  const params = new URLSearchParams(event.rawQuery || event.queryStringParameters
    ? (typeof event.rawQuery === "string" ? event.rawQuery : new URLSearchParams(event.queryStringParameters || {}).toString())
    : "");
  const orderId = params.get("orderId");
  const token = bearerToken(event);
  if (!validUuid(orderId) || !token) return response(404, { error: "Order not found" });

  try {
    if (!await enforceRateLimits(event, "get-order-ip", [
      { maxRequests: 60, windowSeconds: 60 },
      { maxRequests: 600, windowSeconds: 3600 },
    ], context)) return response(429, { error: "Too many order lookups" });
    if (!await enforceRateLimits(event, `get-order:${orderId}`, [
      { maxRequests: 30, windowSeconds: 60 },
    ], context)) return response(429, { error: "Too many order lookups" });
    const query = new URLSearchParams({
      select: "id,reference,amount_cents,description,customer,order_items,shipping_address,status,created_at,delivery_status,carrier,tracking_code,tracking_url,shipped_at,delivered_at,tracking_updated_at,checkout_token_hash",
      id: `eq.${orderId}`,
      limit: "1",
    });
    const rows = await supabaseRequest(`pix_orders?${query}`, {}, process.env);
    const order = Array.isArray(rows) ? rows[0] : undefined;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    if (!order || !safeEqual(tokenHash, order.checkout_token_hash)) {
      return response(404, { error: "Order not found" });
    }

    const paymentQuery = new URLSearchParams({
      select: "status,qr_code,qr_code_base64,expires_at",
      order_id: `eq.${order.id}`,
      limit: "1",
    });
    const payments = await supabaseRequest(`pix_payments?${paymentQuery}`, {}, process.env);
    const payment = Array.isArray(payments) ? payments[0] : undefined;
    const trackingQuery = new URLSearchParams({
      select: "previous_status,new_status,carrier,tracking_code,tracking_url,created_at",
      order_id: `eq.${order.id}`,
      order: "created_at.desc,id.desc",
      limit: "100",
    });
    const trackingEvents = await supabaseRequest(
      `pix_order_tracking_events?${trackingQuery}`,
      {},
      process.env,
    );
    const trackingReleased = order.status === "paid" && payment?.status === "approved";
    const actualTrackingCode = typeof order.tracking_code === "string" ? order.tracking_code : null;
    const trackingCodePreview = !trackingReleased && actualTrackingCode
      ? `${actualTrackingCode.slice(0, 2)}${"•".repeat(8)}`
      : null;
    return response(200, {
      order: {
        id: order.id,
        reference: order.reference,
        status: order.status,
        amountCents: order.amount_cents,
        description: order.description,
        items: order.order_items,
        customer: {
          name: order.customer.name,
          email: order.customer.email,
          phone: order.customer.phone,
        },
        shippingAddress: order.shipping_address,
        createdAt: order.created_at,
      },
      payment: payment ? {
        status: payment.status,
        qrCode: payment.qr_code,
        qrCodeBase64: payment.qr_code_base64,
        expiresAt: payment.expires_at,
      } : null,
      delivery: {
        status: trackingReleased ? order.delivery_status : "not_shipped",
        carrier: trackingReleased ? order.carrier : null,
        trackingCode: trackingReleased ? actualTrackingCode : null,
        trackingCodePreview,
        trackingLocked: !trackingReleased,
        trackingUrl: trackingReleased ? order.tracking_url : null,
        shippedAt: trackingReleased ? order.shipped_at : null,
        deliveredAt: trackingReleased ? order.delivered_at : null,
        updatedAt: trackingReleased ? order.tracking_updated_at : null,
        history: trackingReleased && Array.isArray(trackingEvents) ? trackingEvents.reverse() : [],
      },
    });
  } catch (error) {
    console.error("Order lookup failed", { status: error.status || "internal_error" });
    return response(500, { error: "Unable to retrieve order" });
  }
}
