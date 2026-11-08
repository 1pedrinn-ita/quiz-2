/* Staging adapter for the original TanStack Server Function IDs.
 * This is separate from the recovered originals; all data-changing work goes
 * through the existing backend routes. */
(function installLegacyServerFnBridge() {
  "use strict";

  const ids = {
    checkout: "85a7da13ce7fdaba6b1e1edac497a7cc5455cf15bdf57dbd1be6c4e29433c09d",
    paymentStatus: "6d27cbe0ea4d709aed7e944b11729a81069ef97d0cf496742f3d13cab275a658",
    orderByToken: "66943a4c13c970856d03ac8d649dcd873da796b5354a96cfa0fe11d5f8d4ee70",
    orderByCode: "0ecc198371f69ceb2760a2d869ec7911878c744ac3ba2408e7405cf50131d28a",
    trackingOrder: "e4509916e36b444c8db20f8d4ccc349c4e15ae1894a659614855e80cc58f7361",
    serviceCharge: "7554a5172ecf697a7ed1af0dac4020ee4176ff4191c09c425e2fca4100c7a1bb",
    realCharge: "a260c68d52d944daec4017688a6d43886280184d1bc2fead388cdaa7d5c02834a",
  };
  const sku = {
    base: "corre-rosa-kit",
    socks: "socks",
    visor: "visor",
    coloredSocks: "colored-socks",
    express: "express-shipping",
  };
  const prices = { base: 9790, socks: 1990, visor: 2990, coloredSocks: 1990, express: 845 };
  const checkoutKeyName = "legacy-checkout-idempotency-v1";
  let verifiedTrackingHistory;

  const eventLabels = {
    shipped: "Pedido postado",
    in_transit: "Pedido em trânsito",
    delivered: "Entrega confirmada",
    exception: "Ocorrência logística registrada",
    returned: "Pedido devolvido",
  };

  function renderVerifiedTrackingHistory() {
    if (typeof document === "undefined" || !Array.isArray(verifiedTrackingHistory)) return;
    const section = document.querySelector(".order-timeline");
    if (!section) return;
    const list = section.querySelector("ol");
    if (!list) return;
    const events = verifiedTrackingHistory.filter((event) => eventLabels[event?.new_status]);
    const signature = JSON.stringify(events);
    if (section.getAttribute("data-staging-history-hash") === signature) return;
    section.setAttribute("data-staging-history-hash", signature);
    list.replaceChildren();
    if (!events.length) {
      section.remove();
      return;
    }
    for (const event of events) {
      const item = document.createElement("li");
      item.className = "completed";
      const marker = document.createElement("span");
      marker.className = "order-marker";
      marker.textContent = "✓";
      const content = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = eventLabels[event.new_status];
      const detail = document.createElement("p");
      const pieces = [];
      const date = Date.parse(event.created_at || "");
      if (Number.isFinite(date)) pieces.push(new Date(date).toLocaleString("pt-BR"));
      if (typeof event.carrier === "string" && event.carrier) pieces.push(event.carrier);
      if (typeof event.tracking_code === "string" && event.tracking_code) pieces.push(event.tracking_code);
      detail.textContent = pieces.join(" · ");
      content.append(title, detail);
      if (typeof event.tracking_url === "string" && /^https:\/\//i.test(event.tracking_url)) {
        const link = document.createElement("a");
        link.href = event.tracking_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Consultar evento na transportadora";
        content.append(link);
      }
      item.append(marker, content);
      list.append(item);
    }
  }

  function fail(message) { throw new Error(message); }
  function digits(value) { return typeof value === "string" ? value.replace(/\D/g, "") : ""; }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function savedCheckoutKey() {
    try {
      const cached = JSON.parse(sessionStorage.getItem(checkoutKeyName) || "null");
      if (cached && typeof cached.key === "string" && cached.expiresAt > Date.now()) return cached.key;
      const key = uuid();
      sessionStorage.setItem(checkoutKeyName, JSON.stringify({ key, expiresAt: Date.now() + 30 * 60 * 1000 }));
      return key;
    } catch { return uuid(); }
  }
  async function api(path, options) {
    const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...options });
    let data;
    try { data = await response.json(); } catch { fail("Resposta inválida do backend."); }
    if (!response.ok) fail(data?.error || "Falha ao consultar o backend.");
    return data;
  }
  function tokenFromLocalStorage(orderId) {
    try {
      const pending = JSON.parse(localStorage.getItem("corre-rosa:pending-order-tracking-access:v1") || "null");
      const token = pending?.token;
      if (pending?.orderId === orderId && typeof token === "string") {
        const match = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
        if (match) {
          const decode = (s) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
          if (decode(match[1]) === orderId) return decode(match[2]);
        }
      }
    } catch { /* malformed browser storage is treated as no credential */ }
    return null;
  }
  function tokenFor(orderId) {
    let token = tokenFromLocalStorage(orderId);
    if (token) return token;
    try {
      const raw = sessionStorage.getItem(`staging-checkout-token:${orderId}`);
      if (raw) return raw;
    } catch { /* unavailable storage */ }
    return null;
  }
  function shippingAddress(address) {
    if (!address || typeof address !== "object") fail("Endereço de entrega incompleto.");
    const result = {
      street: String(address.street || "").trim(),
      number: String(address.number || "").trim(),
      district: String(address.neighborhood || address.district || "").trim(),
      city: String(address.city || "").trim(),
      state: String(address.state || "").trim().toUpperCase(),
      cep: digits(address.zipcode || address.cep),
    };
    const complement = String(address.complement || "").trim();
    if (complement) result.complement = complement;
    if (!result.street || !result.number || !result.district || !result.city ||
        !/^[A-Z]{2}$/.test(result.state) || !/^\d{8}$/.test(result.cep)) {
      fail("Endereço ou CEP inválido.");
    }
    return result;
  }
  function selectedItems(data) {
    const offers = data.offers && typeof data.offers === "object" ? data.offers : {};
    if (!data.kitSizes || typeof data.kitSizes !== "object") fail("Selecione o tamanho de cada peça do kit.");
    const items = [{ sku: sku.base, quantity: 1, kitSizes: data.kitSizes }];
    if (typeof offers.socks === "string" && offers.socks) items.push({ sku: sku.socks, quantity: 1, variant: offers.socks });
    if (typeof offers.visor === "string" && offers.visor) items.push({ sku: sku.visor, quantity: 1 });
    if (typeof offers["colored-socks"] === "string" && offers["colored-socks"]) items.push({ sku: sku.coloredSocks, quantity: 1, variant: offers["colored-socks"] });
    if (data.shipping === "express") items.push({ sku: sku.express, quantity: 1 });
    return items;
  }
  function expectedAmount(data) {
    const offers = data.offers && typeof data.offers === "object" ? data.offers : {};
    return prices.base +
      (typeof offers.socks === "string" && offers.socks ? prices.socks : 0) +
      (typeof offers.visor === "string" && offers.visor ? prices.visor : 0) +
      (typeof offers["colored-socks"] === "string" && offers["colored-socks"] ? prices.coloredSocks : 0) +
      (data.shipping === "express" ? prices.express : 0);
  }
  function encodeCheckoutToken(orderId, token) {
    const encode = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return `v1.${encode(orderId)}.${encode(token)}`;
  }
  async function createCheckout(data) {
    if (!data || typeof data !== "object") fail("Dados do pedido inválidos.");
    const expected = expectedAmount(data);
    const customer = data.customer || {};
    const orderResult = await api("/api/create-order", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": savedCheckoutKey() },
      body: JSON.stringify({
        items: selectedItems(data),
        customer: {
          name: String(customer.name || "").trim(),
          email: String(customer.email || "").trim(),
          phone: digits(customer.phone),
          document: digits(customer.document),
        },
        shippingAddress: shippingAddress(data.address),
      }),
    });
    if (!orderResult.orderId || !orderResult.checkoutToken || orderResult.amountCents !== expected) {
      fail("O catálogo de staging não corresponde ao preço original do checkout.");
    }
    try { sessionStorage.setItem(`staging-checkout-token:${orderResult.orderId}`, orderResult.checkoutToken); } catch {}
    const payment = await api("/api/create-pix", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${orderResult.checkoutToken}` },
      body: JSON.stringify({ orderId: orderResult.orderId }),
    });
    if (payment.simulated !== true || !String(payment.qr_code || "").startsWith("SIMULATION-ONLY-NOT-A-PIX-")) {
      fail("O endpoint de pagamento não está em modo de simulação seguro.");
    }
    const access = await api("/api/issue-order-access-code", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${orderResult.checkoutToken}` },
      body: JSON.stringify({ orderId: orderResult.orderId }),
    });
    if (!/^CR-[A-F0-9]{32}$/.test(access.trackingAccess || "")) fail("Não foi possível emitir o código de acompanhamento.");
    try { sessionStorage.removeItem(checkoutKeyName); } catch {}
    return {
      id: orderResult.orderId,
      trackingAccess: access.trackingAccess,
      amount: orderResult.amountCents,
      qrCode: payment.qr_code,
      status: payment.status,
      reference: orderResult.reference,
      tracking: data.tracking,
    };
  }
  async function orderByCode(code) {
    const result = await api("/api/lookup-order-by-access-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    verifiedTrackingHistory = result.delivery?.history || [];
    renderVerifiedTrackingHistory();
    const address = result.order.shippingAddress || {};
    return {
      code,
      product: result.order.description,
      amount: result.order.amountCents,
      status: result.payment.status,
      address: {
        street: address.street,
        number: address.number,
        complement: address.complement || "",
        neighborhood: address.district,
        city: address.city,
        state: address.state,
        zipcode: address.cep,
      },
      delivery: result.delivery,
      history: result.delivery.history,
    };
  }
  async function paymentStatus(id) {
    if (typeof id !== "string") fail("Pedido inválido.");
    const token = tokenFor(id);
    if (!token) fail("Credencial de consulta indisponível; consulte pelo código do pedido após a confirmação.");
    const result = await api(`/api/orders?orderId=${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: result.payment?.status || "pending" };
  }
  async function orderByToken(token) {
    if (typeof token !== "string") fail("Credencial do pedido inválida.");
    if (/^CR-[A-F0-9]{32}$/.test(token)) return orderByCode(token);
    const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!m) fail("Credencial do pedido inválida.");
    const decode = (s) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const id = decode(m[1]), checkoutToken = decode(m[2]);
    const result = await api(`/api/orders?orderId=${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${checkoutToken}` },
    });
    return {
      code: result.order.reference,
      product: result.order.description,
      amount: result.order.amountCents,
      status: result.payment?.status || result.order.status,
      customer: result.order.customer,
      address: result.order.shippingAddress,
      delivery: result.delivery,
      history: result.delivery?.history || [],
    };
  }
  async function trackingOrder(token) {
    const order = await orderByToken(token);
    return { ok: true, ...order };
  }
  async function dispatch(id, call) {
    const data = call?.data && typeof call.data === "object" ? call.data : call || {};
    if (id === ids.checkout) return createCheckout(data);
    if (id === ids.paymentStatus) return paymentStatus(data.id);
    if (id === ids.orderByToken) return orderByToken(data.token);
    if (id === ids.orderByCode) return orderByCode(data.code);
    if (id === ids.trackingOrder) return trackingOrder(data.token);
    // The original extra-service/charge functions contain payment behavior.
    // Fail closed in staging; they are never allowed to call a gateway.
    throw new Error("Esta função original não está habilitada no staging de pagamentos simulados.");
  }
  globalThis.__LEGACY_SERVERFN_ADAPTER__ = dispatch;
  if (typeof document !== "undefined" && document.body && typeof MutationObserver !== "undefined") {
    new MutationObserver(renderVerifiedTrackingHistory).observe(document.body, { childList: true, subtree: true });
  }
})();
