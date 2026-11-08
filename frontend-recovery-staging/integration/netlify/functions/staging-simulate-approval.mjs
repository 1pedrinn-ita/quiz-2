// Test/operator-only payment confirmation for staging. Never wire this route
// to a browser control or production deployment.
import { jsonResponse, methodNotAllowed, supabaseRequest } from "../lib/supabase.mjs";
import { bodyWithinLimit, validUuid } from "../lib/orders.mjs";

function response(statusCode, body) {
  const result = jsonResponse(statusCode, body);
  result.headers["cache-control"] = "no-store";
  return result;
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return methodNotAllowed("POST");
  if (process.env.STAGING_SIMULATOR_ENABLED !== "true" ||
      typeof process.env.STAGING_SIMULATOR_SECRET !== "string" ||
      process.env.STAGING_SIMULATOR_SECRET.length < 32) {
    return response(404, { error: "Not found" });
  }
  if (!bodyWithinLimit(event, 2 * 1024)) return response(413, { error: "Request body too large" });
  const auth = event.headers?.authorization || event.headers?.Authorization || "";
  if (auth !== `Bearer ${process.env.STAGING_SIMULATOR_SECRET}`) return response(404, { error: "Not found" });
  let body;
  try { body = JSON.parse(event.body || ""); } catch { return response(400, { error: "Invalid JSON body" }); }
  if (!validUuid(body?.orderId)) return response(400, { error: "Invalid order identifier" });
  try {
    const query = new URLSearchParams({
      select: "reference,amount_cents,status",
      order_id: `eq.${body.orderId}`,
      limit: "1",
    });
    const rows = await supabaseRequest(`pix_payments?${query}`, {}, process.env);
    const payment = Array.isArray(rows) ? rows[0] : undefined;
    if (!payment || !["pending", "approved"].includes(payment.status)) {
      return response(409, { error: "No pending simulated payment" });
    }
    const transactionId = `sim_${body.orderId}`;
    const result = await supabaseRequest("rpc/apply_pix_gateway_status", {
      method: "POST",
      body: JSON.stringify({
        p_reference: payment.reference,
        p_amount_cents: payment.amount_cents,
        p_gateway_transaction_id: transactionId,
        p_status: "approved",
      }),
    }, process.env);
    if (result !== true) return response(409, { error: "Simulated payment did not match order" });
    return response(200, { orderId: body.orderId, status: "approved", simulated: true });
  } catch (error) {
    console.error("Staging simulated approval failed", { status: error.status || "internal_error" });
    return response(500, { error: "Unable to confirm simulated payment" });
  }
}
