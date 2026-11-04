import crypto from "node:crypto";
import {
  jsonResponse,
  methodNotAllowed,
  supabaseRequest,
from "../lib/supabase.mjs"
import {
  createTransaction,
  hasApiKey,
  listTransactionsByReference,
from "../lib/supabase.mjs"

const ORDER_FIELDS =
  "id,reference,amount_cents,description,customer,checkout_token_hash,status";

function validUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function validCustomer(customer) {
  return (
    customer &&
    typeof customer.name === "string" &&
    typeof customer.email === "string" &&
    typeof customer.document === "string" &&
    typeof customer.phone === "string" &&
    customer.name.length <= 200 &&
    customer.email.length <= 254 &&
    /^\d{11,14}$/.test(customer.document) &&
    /^\d{10,13}$/.test(customer.phone)
  );
}

function safeEqualHex(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    !/^[a-f0-9]{64}$/i.test(left) ||
    !/^[a-f0-9]{64}$/i.test(right)
  ) {
    return false;
  }
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function getOrder(orderId, env) {
  const query = new URLSearchParams({
    select: ORDER_FIELDS,
    id: `eq.${orderId}`,
    limit: "1",
  });
  const rows = await supabaseRequest(`pix_orders?${query}`, {}, env);
  return Array.isArray(rows) ? rows[0] : undefined;
}

async function getPayment(orderId, env) {
  const query = new URLSearchParams({
    select: "id,status,qr_code,qr_code_base64,expires_at,reference",
    order_id: `eq.${orderId}`,
    limit: "1",
  });
  const rows = await supabaseRequest(`pix_payments?${query}`, {}, env);
  return Array.isArray(rows) ? rows[0] : undefined;
}

function pixResult(payment) {
  return {
    status: payment.status,
    qr_code: payment.qr_code,
    qr_code_base64: payment.qr_code_base64,
    expires_at: payment.expires_at,
    reference: payment.reference,
  };
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

  const { orderId, checkoutToken } = body || {};
  if (
    !validUuid(orderId) ||
    typeof checkoutToken !== "string" ||
    checkoutToken.length < 32 ||
    checkoutToken.length > 256
  ) {
    return jsonResponse(400, { error: "Invalid order credentials" });
  }

  try {
    const env = process.env;
    if (!hasApiKey(env)) {
      return jsonResponse(503, { error: "Payment service is not configured" });
    }

    const order = await getOrder(orderId, env);
    if (
      !order ||
      order.status !== "pending" ||
      !Number.isSafeInteger(order.amount_cents) ||
      order.amount_cents < 1 ||
      typeof order.reference !== "string" ||
      !order.reference ||
      typeof order.description !== "string" ||
      !order.description ||
      !validCustomer(order.customer)
    ) {
      return jsonResponse(404, { error: "Order not found or unavailable" });
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(checkoutToken, "utf8")
      .digest("hex");
    if (!safeEqualHex(tokenHash, order.checkout_token_hash)) {
      return jsonResponse(404, { error: "Order not found or unavailable" });
    }

    const existing = await getPayment(order.id, env);
    if (existing) {
      if (existing.status === "pending" && existing.qr_code) {
        return jsonResponse(200, pixResult(existing));
      }
      return jsonResponse(409, { error: "Payment requires reconciliation" });
    }

    const priorTransactions = await listTransactionsByReference(order.reference, env);
    if (priorTransactions.length) {
      return jsonResponse(409, { error: "Payment requires reconciliation" });
    }

    const claimResponse = await supabaseRequest(
      "pix_payments",
      {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify({
          order_id: order.id,
          reference: order.reference,
          amount_cents: order.amount_cents,
          status: "creating",
        }),
      },
      env,
    );
    const claim = Array.isArray(claimResponse) ? claimResponse[0] : undefined;
    if (!claim) {
      throw new Error("Unable to claim payment");
    }

    const siteUrl = env.URL;
    if (!siteUrl) {
      throw new Error("Missing Netlify URL");
    }

    let gatewayResponse;
    try {
      gatewayResponse = await createTransaction(
        {
          amount: order.amount_cents,
          description: order.description,
          reference: order.reference,
          source: "api_externa",
          customer: order.customer,
          postback_url: `${siteUrl.replace(/\/$/, "")}/api/pingupag-webhook`,
        },
        env,
      );
    } catch (error) {
      console.error("PinguPag transaction creation failed", {
        status: error.status || "network_error",
      });
      return jsonResponse(502, {
        error: "Payment creation outcome is uncertain; reconciliation required",
      });
    }

    if (
      gatewayResponse?.status !== "success" ||
      !gatewayResponse.qr_code ||
      !gatewayResponse.transaction_id
    ) {
      console.error("PinguPag returned an incomplete transaction response");
      return jsonResponse(502, {
        error: "Payment creation outcome requires reconciliation",
      });
    }

    const updateQuery = new URLSearchParams({
      id: `eq.${claim.id}`,
      status: "eq.creating",
    });
    await supabaseRequest(
      `pix_payments?${updateQuery}`,
      {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({
          gateway_transaction_id: String(gatewayResponse.transaction_id),
          qr_code: gatewayResponse.qr_code,
          qr_code_base64: gatewayResponse.qr_code_base64 || null,
          expires_at: gatewayResponse.expires_at || null,
          status: "pending",
        }),
      },
      env,
    );

    return jsonResponse(200, {
      status: "pending",
      qr_code: gatewayResponse.qr_code,
      qr_code_base64: gatewayResponse.qr_code_base64 || null,
      expires_at: gatewayResponse.expires_at || null,
      reference: order.reference,
    });
  } catch (error) {
    console.error("Pix creation handler failed", {
      status: error.status || "internal_error",
    });
    return jsonResponse(500, { error: "Unable to create Pix payment" });
  }
}
