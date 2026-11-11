const API_BASE_URL = "https://pagpixhub.com/api/v1";

export function hasApiKey(env = process.env) {
  return typeof env.PAGPIXHUB_API_KEY === "string" && env.PAGPIXHUB_API_KEY.length > 0;
}

function getApiKey(env) {
  if (!hasApiKey(env)) throw new Error("Missing PAGPIXHUB_API_KEY");
  return env.PAGPIXHUB_API_KEY;
}

async function request(path, options = {}, env = process.env) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getApiKey(env)}`,
      "content-type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let data;
  if (text) {
    try { data = JSON.parse(text); }
    catch { throw new Error("PagPix returned an invalid response"); }
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || "PagPix request failed");
    error.status = response.status;
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}

export function createTransaction(payload, idempotencyKey, env = process.env) {
  return request("/transactions", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(payload),
  }, env);
}

export async function getTransaction(id, env = process.env) {
  return request(`/transactions/${encodeURIComponent(id)}`, {}, env);
}

export async function listTransactionsByReference(reference, env = process.env) {
  const query = new URLSearchParams({ external_reference: reference, limit: "100" });
  const data = await request(`/transactions?${query}`, {}, env);
  if (!Array.isArray(data?.data)) throw new Error("PagPix returned an invalid transaction list");
  return data.data;
}

export function mapGatewayStatus(status) {
  switch (String(status).toUpperCase()) {
    case "PAID": return "approved";
    case "PENDING": return "pending";
    case "PROCESSING": return "processing";
    case "UNDER_REVIEW": return "under_review";
    case "FAILED":
    case "EXPIRED": return "failed";
    case "REFUNDED": return "refunded";
    case "CHARGEBACK": return "chargeback";
    default: throw new Error("PagPix returned an unknown transaction status");
  }
}
