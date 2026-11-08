import { jsonResponse, methodNotAllowed, supabaseRequest } from "../lib/supabase.mjs";
import { bodyWithinLimit, enforceRateLimits, validTrackingCode } from "../lib/orders.mjs";

function response(statusCode, body) {
  const result = jsonResponse(statusCode, body);
  result.headers["cache-control"] = "no-store";
  return result;
}

export async function handler(event, context) {
  if (event.httpMethod !== "POST") return methodNotAllowed("POST");
  if (!bodyWithinLimit(event, 4 * 1024)) return response(413, { error: "Request body too large" });

  try {
    if (!await enforceRateLimits(event, "track-order", [
      { maxRequests: 30, windowSeconds: 60 },
      { maxRequests: 120, windowSeconds: 3600 },
    ], context)) return response(429, { error: "Too many tracking lookups" });
  } catch (error) {
    console.error("Tracking rate limit unavailable", { status: error.status || "internal_error" });
    return response(503, { error: "Tracking service is temporarily unavailable" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "");
  } catch {
    return response(400, { error: "Invalid JSON body" });
  }
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!validTrackingCode(code)) return response(400, { error: "Invalid tracking code" });

  try {
    const orderQuery = new URLSearchParams({
      select: "id,delivery_status,carrier,tracking_code,tracking_url,shipped_at,delivered_at,tracking_updated_at",
      status: "eq.paid",
      tracking_code: `eq.${code}`,
      limit: "2",
    });
    const orders = await supabaseRequest(`pix_orders?${orderQuery}`, {}, process.env);
    if (!Array.isArray(orders) || orders.length !== 1) {
      return response(404, { error: "Tracking code not found" });
    }
    const order = orders[0];
    const historyQuery = new URLSearchParams({
      select: "previous_status,new_status,carrier,tracking_code,tracking_url,created_at",
      order_id: `eq.${order.id}`,
      order: "created_at.desc,id.desc",
      limit: "100",
    });
    const rows = await supabaseRequest(`pix_order_tracking_events?${historyQuery}`, {}, process.env);
    return response(200, {
      tracking: {
        status: order.delivery_status,
        carrier: order.carrier,
        code: order.tracking_code,
        trackingUrl: order.tracking_url,
        shippedAt: order.shipped_at,
        deliveredAt: order.delivered_at,
        updatedAt: order.tracking_updated_at,
        history: Array.isArray(rows) ? rows.reverse() : [],
      },
    });
  } catch (error) {
    console.error("Tracking lookup failed", { status: error.status || "internal_error" });
    return response(500, { error: "Unable to retrieve tracking information" });
  }
}
