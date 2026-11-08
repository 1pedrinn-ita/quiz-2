import { jsonResponse, methodNotAllowed, supabaseRequest } from "../lib/supabase.mjs";
import { bearerToken, bodyWithinLimit, enforceRateLimits, safeEqual, validTrackingCode, validUuid } from "../lib/orders.mjs";

const DELIVERY_STATUSES = new Set([
  "not_shipped",
  "shipped",
  "in_transit",
  "delivered",
  "exception",
  "returned",
]);

function response(statusCode, body) {
  const result = jsonResponse(statusCode, body);
  result.headers["cache-control"] = "no-store";
  return result;
}

export async function handler(event, context) {
  if (event.httpMethod !== "POST") return methodNotAllowed("POST");
  if (!bodyWithinLimit(event, 8 * 1024)) return response(413, { error: "Request body too large" });
  const configuredToken = process.env.ORDER_OPERATIONS_TOKEN;
  const suppliedToken = bearerToken(event);
  if (!configuredToken || !suppliedToken || !safeEqual(configuredToken, suppliedToken)) {
    return response(401, { error: "Unauthorized" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "");
  } catch {
    return response(400, { error: "Invalid JSON body" });
  }
  if (
    !validUuid(body?.orderId) ||
    !DELIVERY_STATUSES.has(body?.deliveryStatus) ||
    (body.carrier !== undefined && (typeof body.carrier !== "string" || body.carrier.length > 120)) ||
    (body.trackingCode !== undefined && body.trackingCode !== null &&
      (typeof body.trackingCode !== "string" ||
        (body.trackingCode.trim() !== "" && !validTrackingCode(body.trackingCode.trim())))) ||
    (body.trackingUrl !== undefined && body.trackingUrl !== null && typeof body.trackingUrl !== "string") ||
    ![undefined, null].includes(body.trackingUrl) && typeof body.trackingUrl === "string" && body.trackingUrl.length > 2048
  ) {
    return response(400, { error: "Invalid tracking data" });
  }

  let trackingUrl = body.trackingUrl;
  if (typeof trackingUrl === "string") {
    try {
      const parsed = new URL(trackingUrl);
      if (
        parsed.protocol !== "https:" ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password ||
        trackingUrl.length > 2048
      ) throw new Error();
      trackingUrl = parsed.toString();
    } catch {
      return response(400, { error: "Tracking URL must use HTTPS" });
    }
  }

  try {
    if (!await enforceRateLimits(event, "update-order-tracking", [
      { maxRequests: 30, windowSeconds: 60 },
    ], context)) return response(429, { error: "Too many tracking updates" });
    const result = await supabaseRequest(
      "rpc/update_pix_order_tracking",
      {
        method: "POST",
        body: JSON.stringify({
          p_order_id: body.orderId,
          p_delivery_status: body.deliveryStatus,
          p_carrier: body.carrier?.trim() || null,
          p_tracking_code: body.trackingCode?.trim() || null,
          p_tracking_url: trackingUrl || null,
          p_set_carrier: Object.hasOwn(body, "carrier"),
          p_set_tracking_code: Object.hasOwn(body, "trackingCode"),
          p_set_tracking_url: Object.hasOwn(body, "trackingUrl"),
          p_actor: "operations-token",
        }),
      },
      process.env,
    );
    if (!result || result.ok !== true) {
      if (result?.error === "order_not_found_or_unpaid") return response(404, { error: "Order not found" });
      if (result?.error === "invalid_delivery_transition") return response(409, { error: "Invalid delivery status transition" });
      throw new Error("Tracking update failed");
    }
    const order = result.delivery;
    return response(200, { delivery: {
      status: order.status,
      carrier: order.carrier,
      trackingCode: order.tracking_code,
      trackingUrl: order.tracking_url,
      shippedAt: order.shipped_at,
      deliveredAt: order.delivered_at,
      updatedAt: order.tracking_updated_at,
    } });
  } catch (error) {
    console.error("Order tracking update failed", { status: error.status || "internal_error" });
    return response(500, { error: "Unable to update tracking information" });
  }
}
