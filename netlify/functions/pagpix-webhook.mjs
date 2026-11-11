import crypto from "node:crypto";
import { jsonResponse, methodNotAllowed, supabaseRequest } from "../lib/supabase.mjs";
import { mapGatewayStatus } from "../lib/pagpix.mjs";
import { bodyWithinLimit, enforceRateLimits } from "../lib/orders.mjs";

function rawBodyOf(event) {
  return event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";
}

function signatureHeader(headers = {}) {
  const key = Object.keys(headers).find((name) =>
    ["pagpixhub-signature", "x-pagpixhub-signature"].includes(name.toLowerCase()),
  );
  return key ? headers[key] : "";
}

function verifySignature(rawBody, value, secret) {
  if (typeof secret !== "string" || !secret || typeof value !== "string") return false;
  const fields = Object.fromEntries(value.split(",").map((part) => {
    const separator = part.indexOf("=");
    return separator < 0 ? ["", ""] : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }));
  const timestamp = Number(fields.t);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300 || !/^[a-f0-9]{64}$/i.test(fields.v1 || "")) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const received = Buffer.from(fields.v1, "hex");
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

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
  const result = await supabaseRequest("rpc/apply_pix_gateway_status", {
    method: "POST",
    body: JSON.stringify({
      p_reference: payment.reference,
      p_amount_cents: payment.amount_cents,
      p_gateway_transaction_id: transactionId,
      p_status: status,
    }),
  }, env);
  if (result !== true) throw new Error("PagPix event did not match stored payment");
}

export async function handler(event, context) {
  if (event.httpMethod !== "POST") return methodNotAllowed("POST");
  const rawBody = rawBodyOf(event);
  if (Buffer.byteLength(rawBody, "utf8") > 16 * 1024) return jsonResponse(413, { error: "Request body too large" });

  try {
    if (!await enforceRateLimits(event, "pagpix-webhook", [
      { maxRequests: 120, windowSeconds: 60 },
      { maxRequests: 600, windowSeconds: 3600 },
    ], context)) return jsonResponse(429, { error: "Webhook rate limit exceeded" });
  } catch (error) {
    console.error("Webhook rate limit unavailable", { status: error.status || "internal_error" });
    return jsonResponse(503, { error: "Webhook temporarily unavailable" });
  }

  if (!verifySignature(rawBody, signatureHeader(event.headers), process.env.PAGPIXHUB_WEBHOOK_SECRET)) {
    return jsonResponse(401, { error: "Invalid webhook signature" });
  }

  let eventBody;
  try { eventBody = JSON.parse(rawBody); }
  catch { return jsonResponse(400, { error: "Invalid JSON body" }); }

  if (typeof eventBody?.id !== "string" || typeof eventBody?.type !== "string" || !eventBody.data) {
    return jsonResponse(400, { error: "Invalid webhook event" });
  }
  if (!eventBody.type.startsWith("transaction.")) return jsonResponse(200, { received: true });

  const data = eventBody.data;
  const reference = data.external_reference;
  const transactionId = data.id;
  if (typeof reference !== "string" || !reference || typeof transactionId !== "string" || !transactionId || !Number.isSafeInteger(data.amount_cents)) {
    return jsonResponse(400, { error: "Invalid transaction event" });
  }

  try {
    const env = process.env;
    const payment = await getPayment(reference, env);
    if (!payment) return jsonResponse(404, { error: "Payment not found" });
    if (payment.amount_cents !== data.amount_cents || (payment.gateway_transaction_id && payment.gateway_transaction_id !== transactionId)) {
      return jsonResponse(409, { error: "PagPix transaction does not match stored payment" });
    }
    await updatePayment(payment, mapGatewayStatus(data.status), transactionId, env);
    return jsonResponse(200, { received: true });
  } catch (error) {
    console.error("PagPix webhook processing failed", { status: error.status || "internal_error" });
    return jsonResponse(500, { error: "Unable to process payment notification" });
  }
}
