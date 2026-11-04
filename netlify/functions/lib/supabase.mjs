const JSON_HEADERS = {
  "content-type": "application/json",
};

export function getSupabaseConfig(env = process.env) {
  const url = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") {
    throw new Error("SUPABASE_URL must use HTTPS");
  }

  return { url: parsedUrl.toString().replace(/\/$/, ""), serviceKey };
}

export async function supabaseRequest(path, options = {}, env = process.env) {
  const { url, serviceKey } = getSupabaseConfig(env);
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });

  const text = await response.text();
  let data;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Supabase returned an invalid response");
    }
  }

  if (!response.ok) {
    const error = new Error("Supabase request failed");
    error.status = response.status;
    throw error;
  }

  return data;
}

export function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

export function methodNotAllowed(allowed) {
  return {
    ...jsonResponse(405, { error: "Method not allowed" }),
    headers: { ...JSON_HEADERS, allow: allowed },
  };
}
