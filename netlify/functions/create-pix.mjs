import crypto from "node:crypto";
import {
  jsonResponse,
  methodNotAllowed,
  supabaseRequest,
} from "../lib/supabase.mjs";
import {
  createTransaction,
  hasApiKey,
  listTransactionsByReference,
  mapGatewayStatus,
} from "../lib/pingupag.mjs";
import { bodyWithinLimit, enforceRateLimits, maxOrderAmountCents } from "../lib/orders.mjs";

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
    select: "id,status,qr_code,qr_code_base64,expires_at,reference,amount_cents,gateway_transaction_id",
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

function response(statusCode, body) {
  const result = jsonResponse(statusCode, body);
  result.headers["cache-control"] = "no-store";
  return result;
}

async function applyGatewayStatus(payment, status, transactionId, env) {
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
  if (result !== true) throw new Error("Verified gateway status did not match stored payment");
}

async function recoverExistingPayment(order, payment, env) {
  const transactions = await listTransactionsByReference(order.reference, env);
  const referenceMatches = transactions.filter((item) => String(item.external_id) === order.reference);
  const matches = referenceMatches.filter((item) =>
    Number.isSafeInteger(item.amount) &&
    item.amount === order.amount_cents &&
    item.id !== undefined && item.id !== null && String(item.id).length > 0,
  );
  if (referenceMatches.length !== 1 || matches.length !== 1) {
    return response(409, { error: "Payment outcome requires reconciliation; no new charge was created" });
  }
  const transaction = matches[0];
  const transactionId = String(transaction.id);
  if (payment.gateway_transaction_id && payment.gateway_transaction_id !== transactionId) {
    return response(409, { error: "Gateway transaction does not match stored payment" });
  }
  await applyGatewayStatus(payment, mapGatewayStatus(transaction.status), transactionId, env);
  const refreshed = await getPayment(order.id, env);
  if (refreshed?.status === "pending" && refreshed.qr_code) {
    return response(200, pixResult(refreshed));
  }
  if (refreshed?.status === "approved") {
    return response(200, { status: "approved", reference: order.reference });
  }
  if (refreshed?.status === "pending") {
    return response(409, { error: "Payment was recovered without a Pix code; no duplicate charge was created" });
  }
  return response(409, { error: "Payment is not payable; query the order status" });
}

export async function handler(event, context) {
  if (event.httpMethod !== "POST") {
    return methodNotAllowed("POST");
  }
  if (!bodyWithinLimit(event, 8 * 1024)) return response(413, { error: "Request body too large" });

  try {
    if (!await enforceRateLimits(event, "create-pix", [
      { maxRequests: 10, windowSeconds: 60 },
      { maxRequests: 60, windowSeconds: 3600 },
    ], context)) {
      return response(429, { error: "Too many payment requests" });
    }
  } catch (error) {
    console.error("Payment rate limit unavailable", { status: error.status || "internal_error" });
    return response(503, { error: "Payment service is temporarily unavailable" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "");
  } catch {
    return response(400, { error: "Invalid JSON body" });
  }

  const { orderId, checkoutToken } = body || {};
  if (
    !validUuid(orderId) ||
    typeof checkoutToken !== "string" ||
    checkoutToken.length < 32 ||
    checkoutToken.length > 256
  ) {
    return response(400, { error: "Invalid order credentials" });
  }

  try {
    const env = process.env;
    if (!hasApiKey(env)) {
      return response(503, { error: "Payment service is not configured" });
    }
    if (!await enforceRateLimits(event, `create-pix-order:${orderId}`, [
      { maxRequests: 4, windowSeconds: 600 },
    ], context)) return response(429, { error: "Too many payment attempts for this order" });

    let maxAmountCents;
    try {
      maxAmountCents = maxOrderAmountCents(env);
    } catch {
      return response(503, { error: "Payment amount limit is not configured" });
    }

    const order = await getOrder(orderId, env);
    if (
      !order ||
      order.status !== "pending" ||
      !Number.isSafeInteger(order.amount_cents) ||
      order.amount_cents < 1 ||
      order.amount_cents > maxAmountCents ||
      typeof order.reference !== "string" ||
      !order.reference ||
      typeof order.description !== "string" ||
      !order.description ||
      !validCustomer(order.customer)
    ) {
      return response(404, { error: "Order not found or unavailable" });
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(checkoutToken, "utf8")
      .digest("hex");
    if (!safeEqualHex(tokenHash, order.checkout_token_hash)) {
      return response(404, { error: "Order not found or unavailable" });
    }

    const existing = await getPayment(order.id, env);
    if (existing) {
      if (existing.status === "pending" && existing.qr_code) {
        return response(200, pixResult(existing));
      }
      if (existing.status === "creating" || existing.status === "pending") {
        try {
          return await recoverExistingPayment(order, existing, env);
        } catch (error) {
          console.error("Pix reconciliation failed", { status: error.status || "internal_error" });
          return response(502, { error: "Payment requires reconciliation; no new charge was created" });
        }
      }
      return response(409, { error: "Payment requires reconciliation" });
    }

    const priorTransactions = await listTransactionsByReference(order.reference, env);
    if (priorTransactions.length) {
      return response(409, { error: "Payment requires reconciliation" });
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
      return response(502, {
        error: "Payment creation outcome is uncertain; reconciliation required",
      });
    }

    if (
      gatewayResponse?.status !== "success" ||
      !gatewayResponse.qr_code ||
      !gatewayResponse.transaction_id ||
      String(gatewayResponse.id) !== order.reference ||
      !Number.isSafeInteger(gatewayResponse.amount) ||
      gatewayResponse.amount !== order.amount_cents
    ) {
      console.error("PinguPag returned an incomplete transaction response");
      return response(502, {
        error: "Payment creation outcome requires reconciliation",
      });
    }

    await applyGatewayStatus(
      { ...order, amount_cents: order.amount_cents },
      "pending",
      String(gatewayResponse.transaction_id),
      env,
    );
    const updateQuery = new URLSearchParams({ id: `eq.${claim.id}` });
    await supabaseRequest(
      `pix_payments?${updateQuery}`,
      {
        method: "PATCH",
        headers: { prefer: "return=representation" },
        body: JSON.stringify({
          gateway_transaction_id: String(gatewayResponse.transaction_id),
          qr_code: gatewayResponse.qr_code,
          qr_code_base64: gatewayResponse.qr_code_base64 || null,
          expires_at: gatewayResponse.expires_at || null,
        }),
      },
      env,
    );

    const savedPayment = await getPayment(order.id, env);
    if (!savedPayment || savedPayment.gateway_transaction_id !== String(gatewayResponse.transaction_id)) {
      return response(502, { error: "Payment created but not fully recorded; reconciliation required" });
    }
    if (savedPayment.status === "approved") {
      return response(200, { status: "approved", reference: order.reference });
    }
    return response(200, pixResult({
      ...savedPayment,
      qr_code: savedPayment.qr_code || gatewayResponse.qr_code,
      qr_code_base64: savedPayment.qr_code_base64 || gatewayResponse.qr_code_base64 || null,
      expires_at: savedPayment.expires_at || gatewayResponse.expires_at || null,
    }));
  } catch (error) {
    console.error("Pix creation handler failed", {
      status: error.status || "internal_error",
    });
    return response(500, { error: "Unable to create Pix payment" });
  }
}
