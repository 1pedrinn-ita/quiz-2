const API_BASE_URL = "https://pagamento-processador.org.ua";

export function hasApiKey(env = process.env) {
  const apiKey = env.PINGUPAG_API_KEY;
  return typeof apiKey === "string" && apiKey.length > 0;
}

function getApiKey(env = process.env) {
  if (!hasApiKey(env)) {
    throw new Error("Missing PINGUPAG_API_KEY");
  }
  return env.PINGUPAG_API_KEY;
}

async function request(path, options = {}, env = process.env) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "X-API-Key": getApiKey(env),
      "content-type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(15000),
  });

  const text = await response.text();
  let data;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("PinguPag returned an invalid response");
    }
  }

  if (!response.ok) {
    const error = new Error("PinguPag request failed");
    error.status = response.status;
    throw error;
  }

  return data;
}

export function createTransaction(payload, env = process.env) {
  return request(
    "/gateway/v1/transaction",
    { method: "POST", body: JSON.stringify(payload) },
    env,
  );
}

export async function listTransactionsByReference(reference, env = process.env) {
  const query = new URLSearchParams({
    action: "list_transactions",
    external_id: reference,
  });
  const data = await request(`/gateway/v1/query?${query}`, {}, env);
  if (!Array.isArray(data)) {
    throw new Error("PinguPag returned an invalid transaction list");
  }
  return data;
}

export function mapGatewayStatus(status) {
  switch (status) {
    case "approved":
    case "pending":
    case "processing":
    case "under_review":
    case "failed":
    case "refunded":
    case "chargeback":
      return status;
    default:
      throw new Error("PinguPag returned an unknown transaction status");
  }
}
