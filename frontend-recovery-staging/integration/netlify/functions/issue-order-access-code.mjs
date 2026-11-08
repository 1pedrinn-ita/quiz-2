import crypto from "node:crypto";
import { jsonResponse, methodNotAllowed, supabaseRequest } from "../lib/supabase.mjs";
import { bearerToken, bodyWithinLimit, enforceRateLimits, safeEqual, validUuid } from "../lib/orders.mjs";

function response(statusCode, body) {
  const result = jsonResponse(statusCode, body);
  result.headers["cache-control"] = "no-store";
  return result;
}

export async function handler(event, context) {
  if (event.httpMethod !== "POST") return methodNotAllowed("POST");
  if (!bodyWithinLimit(event, 2 * 1024)) return response(413, { error: "Request body too large" });
  let body;
  try { body = JSON.parse(event.body || ""); } catch { return response(400, { error: "Invalid JSON body" }); }
  const orderId = body?.orderId;
  const token = bearerToken(event);
  if (!validUuid(orderId) || !token) return response(404, { error: "Order not found" });
  const accessSecret = process.env.ORDER_ACCESS_CODE_SECRET;
  if (typeof accessSecret !== "string" || Buffer.byteLength(accessSecret, "utf8") < 32) {
    return response(503, { error: "Order access service is not configured" });
  }
  try {
    if (!await enforceRateLimits(event, "issue-order-access-code", [
      { maxRequests: 20, windowSeconds: 60 },
    ], context)) return response(429, { error: "Too many access-code requests" });
    const query = new URLSearchParams({
      select: "id,checkout_token_hash,legacy_access_code_hash",
      id: `eq.${orderId}`,
      limit: "1",
    });
    const rows = await supabaseRequest(`pix_orders?${query}`, {}, process.env);
    const order = Array.isArray(rows) ? rows[0] : undefined;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    if (!order || !safeEqual(tokenHash, order.checkout_token_hash)) return response(404, { error: "Order not found" });

    // Deterministic HMAC-derived 128-bit code makes retries idempotent while
    // storing only the digest. The code itself never enters the database.
    const raw = `CR-${crypto.createHmac("sha256", accessSecret)
      .update(`order-access:v1:${order.id}:${token}`)
      .digest("hex").slice(0, 32).toUpperCase()}`;
    const codeHash = crypto.createHash("sha256").update(raw).digest("hex");
    const update = new URLSearchParams({ id: `eq.${order.id}` });
    await supabaseRequest(`pix_orders?${update}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ legacy_access_code_hash: codeHash }),
    }, process.env);
    return response(200, { trackingAccess: raw });
  } catch (error) {
    console.error("Order access-code issue failed", { status: error.status || "internal_error" });
    return response(500, { error: "Unable to issue order access code" });
  }
}
