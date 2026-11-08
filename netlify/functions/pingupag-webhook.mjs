import {
  jsonResponse,
  methodNotAllowed,
  supabaseRequest,
} from "../lib/supabase.mjs";
import {
  listTransactionsByReference,
  mapGatewayStatus,
} from "../lib/pingupag.mjs";
import { bodyWithinLimit, enforceRateLimits } from "../lib/orders.mjs";

async function getPayment(reference, env) {
  const query = new URLSearchParams({
    select: "id,order_id,reference,amount_cents,status,gateway_transaction_id",
    reference: `eq.${reference}`,
    limit: "1",
  });
  const rows = await supabaseRequest(`pix_payments?${query}`, {}, env);
  return Array.isArray(rows) ? rows[0] : undefined;
}

async function updatePayment(payment, status, transactionId, env) {
  const result = await supabaseRequest(
    "rpc/apply_pix_gateway_status",
    {
      method: "POST",
      body: JSON.stringify({
        p_reference: payment.reference,
        p_amount_cents: payment.amount_cents,
        p_gateway_transaction_id: transactionId,
        p_status: status,
      }),
    },
    env,
  );
  if (result !== true) {
    throw new Error("Verified gateway status did not match the stored payment");
  }
}

export async function handler(event, context) {
  if (event.httpMethod !== "POST") {
    return methodNotAllowed("POST");
  }
  if (!bodyWithinLimit(event, 16 * 1024)) return jsonResponse(413, { error: "Request body too large" });
  try {
    if (!await enforceRateLimits(event, "pingupag-webhook", [
      { maxRequests: 120, windowSeconds: 60 },
      { maxRequests: 600, windowSeconds: 3600 },
    ], context)) return jsonResponse(429, { error: "Webhook rate limit exceeded" });
  } catch (error) {
    console.error("Webhook rate limit unavailable", { status: error.status || "internal_error" });
    return jsonResponse(503, { error: "Webhook temporarily unavailable" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "");
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const reference = body?.external_id || body?.store_reference;
  if (typeof reference !== "string" || !reference || reference.length > 200) {
    return jsonResponse(400, { error: "Missing transaction reference" });
  }

  try {
    const env = process.env;
    const payment = await getPayment(reference, env);
    if (!payment) {
      return jsonResponse(404, { error: "Payment not found" });
    }

    const transactions = await listTransactionsByReference(reference, env);
    const referenceMatches = transactions.filter((item) => String(item.external_id) === reference);
    const matches = referenceMatches.filter(
      (item) =>
        Number.isSafeInteger(item.amount) &&
        item.amount === payment.amount_cents &&
        item.id !== undefined && item.id !== null && String(item.id).length > 0 &&
        (!payment.gateway_transaction_id || String(item.id) === payment.gateway_transaction_id),
    );
    if (referenceMatches.length !== 1 || matches.length !== 1) {
      return jsonResponse(409, { error: "Gateway transaction not verified" });
    }
    const transaction = matches[0];

    const status = mapGatewayStatus(transaction.status);
    await updatePayment(
      payment,
      status,
      String(transaction.id),
      env,
    );
    return jsonResponse(200, { received: true });
  } catch (error) {
    console.error("PinguPag webhook processing failed", {
      status: error.status || "internal_error",
    });
    return jsonResponse(500, { error: "Unable to process payment notification" });
  }
}
