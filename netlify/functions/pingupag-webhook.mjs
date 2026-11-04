import {
  jsonResponse,
  methodNotAllowed,
  supabaseRequest,
} from "./lib/supabase.mjs";
import {
  listTransactionsByReference,
  mapGatewayStatus,
} from "./lib/pingupag.mjs";

async function getPayment(reference, env) {
  const query = new URLSearchParams({
    select: "id,order_id,reference,amount_cents,status",
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

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return methodNotAllowed("POST");
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
    const matches = transactions.filter(
      (item) =>
        String(item.external_id) === reference &&
        Number(item.amount) === payment.amount_cents,
    );
    if (matches.length !== 1) {
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
