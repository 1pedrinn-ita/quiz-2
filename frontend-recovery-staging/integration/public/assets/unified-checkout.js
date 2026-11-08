(() => {
  "use strict";

  const selectionKey = "corre-rosa-kit-selection-v1";
  const handoffKey = "corre-rosa-unified-selection-v1";
  const shoeSizes = Array.from({ length: 12 }, (_, index) => String(index + 34));
  const apparelSizes = ["P", "M", "G"];
  const products = [
    { id: "shoe", title: "Corre Max 2 Outubro Rosa", field: "shoe", sizes: shoeSizes, image: "/campaign/tenis-galeria-v2.webp" },
    { id: "shirt", title: "Regata do Kit Corre Rosa", field: "shirt", sizes: apparelSizes, image: "/campaign/regata-frente.webp" },
    { id: "shorts", title: "Shorts do Kit Corre Rosa", field: "shorts", sizes: apparelSizes, image: "/campaign/shorts-frente.webp" },
  ];
  const prices = { kitCents: 9790, free: 0, express: 845 };
  const data = { sizes: readSelection(), cep: "", address: null, cepValid: false, shipping: "" };
  const form = document.querySelector("#unified-form");
  const cepInput = document.querySelector("#unified-cep");
  const cepStatus = document.querySelector("#cep-status");
  const addressPreview = document.querySelector("#address-preview");
  const shippingOptions = document.querySelector("#shipping-options");
  const continueButton = document.querySelector("#continue-button");
  let lookupController;
  let lookupTimer;

  function readSelection() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(selectionKey) || "null");
      return saved && typeof saved === "object" ? { shoe: saved.shoe || "", shirt: saved.shirt || "", shorts: saved.shorts || "" } : { shoe: "", shirt: "", shorts: "" };
    } catch { return { shoe: "", shirt: "", shorts: "" }; }
  }

  function digits(value) { return String(value || "").replace(/\D/g, ""); }
  function money(cents) { return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
  function formatCep(value) { const clean = digits(value).slice(0, 8); return clean.length > 5 ? `${clean.slice(0, 5)}-${clean.slice(5)}` : clean; }

  function renderSizes() {
    for (const product of products) {
      const container = document.querySelector(`[data-options="${product.field}"]`);
      container.replaceChildren();
      for (const size of product.sizes) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "unified-size";
        button.textContent = size;
        button.setAttribute("aria-pressed", String(data.sizes[product.field] === size));
        button.setAttribute("aria-label", `${product.title}, tamanho ${size}`);
        button.addEventListener("click", () => {
          data.sizes[product.field] = size;
          try { sessionStorage.setItem(selectionKey, JSON.stringify(data.sizes)); } catch { /* keep in memory for this visit */ }
          document.querySelector(`[data-product="${product.id}"]`).classList.remove("is-invalid");
          document.querySelector(`[data-product="${product.id}"] .unified-error`).textContent = "";
          renderSizes();
          renderSummary();
          updateContinueState();
        });
        container.append(button);
      }
    }
  }

  function renderSummary() {
    const summary = document.querySelector("#summary-items");
    summary.replaceChildren();
    for (const product of products) {
      const row = document.createElement("div");
      row.className = "unified-summary-item";
      const image = document.createElement("img"); image.src = product.image; image.alt = "";
      const text = document.createElement("div");
      const name = document.createElement("strong"); name.textContent = product.title;
      const size = document.createElement("small"); size.textContent = data.sizes[product.field] ? `Tamanho ${data.sizes[product.field]}` : "Tamanho ainda não selecionado";
      text.append(name, size);
      const included = document.createElement("em"); included.textContent = "Incluído no kit";
      row.append(image, text, included);
      summary.append(row);
    }
    const shippingLabel = document.querySelector("#summary-shipping-label");
    const shippingPrice = document.querySelector("#summary-shipping-price");
    if (data.shipping) {
      shippingLabel.textContent = data.shipping === "free" ? "Frete grátis · 5 a 12 dias úteis" : "Frete standard · 2 a 5 dias úteis";
      shippingPrice.textContent = money(prices[data.shipping]);
    } else {
      shippingLabel.textContent = "Frete";
      shippingPrice.textContent = "Selecione uma modalidade";
    }
    document.querySelector("#summary-total").textContent = money(prices.kitCents + (data.shipping ? prices[data.shipping] : 0));
  }

  function updateContinueState() {
    continueButton.disabled = !products.every((product) => data.sizes[product.field] && product.sizes.includes(data.sizes[product.field])) || !data.cepValid || !data.shipping;
  }

  function setCepStatus(message, state = "") {
    cepStatus.textContent = message;
    cepStatus.dataset.state = state;
  }

  function clearAddress() {
    data.cepValid = false;
    data.address = null;
    data.shipping = "";
    shippingOptions.disabled = true;
    shippingOptions.querySelectorAll("input").forEach((radio) => { radio.checked = false; });
    addressPreview.hidden = true;
    addressPreview.textContent = "";
    renderSummary();
    updateContinueState();
  }

  async function lookupCep(cep) {
    lookupController?.abort();
    lookupController = new AbortController();
    setCepStatus("Consultando CEP\u2026");
    try {
      const response = await fetch("https://viacep.com.br/ws/" + cep + "/json/", { signal: lookupController.signal, cache: "no-store" });
      if (!response.ok) throw new Error("N\u00e3o foi poss\u00edvel consultar este CEP.");
      const result = await response.json();
      if (!result || result.erro || !/^[A-Z]{2}$/.test(result.uf || "") || !result.localidade) throw new Error("CEP n\u00e3o encontrado. Confira os n\u00fameros e tente novamente.");
      data.address = { street: result.logradouro || "", district: result.bairro || "", city: result.localidade, state: result.uf };
      data.cepValid = true;
      data.cep = cep;
      const addressParts = [data.address.street, data.address.district, data.address.city + " - " + data.address.state].filter(Boolean);
      addressPreview.textContent = addressParts.join(" \u00b7 ") + " \u00b7 CEP " + formatCep(cep);
      addressPreview.hidden = false;
      shippingOptions.disabled = false;
      setCepStatus("CEP localizado. Selecione o frete.", "success");
    } catch (error) {
      if (error.name === "AbortError") return;
      clearAddress();
      setCepStatus(error.message || "Falha ao consultar o CEP. Tente novamente.", "error");
    }
    updateContinueState();
  }

  cepInput.addEventListener("input", () => {
    cepInput.value = formatCep(cepInput.value);
    data.cep = digits(cepInput.value);
    clearAddress();
    const cep = digits(cepInput.value);
    if (cep.length !== 8) { setCepStatus(cep.length ? "Digite os 8 n\u00fameros do CEP." : ""); return; }
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(() => lookupCep(cep), 250);
  });

  shippingOptions.addEventListener("change", (event) => {
    if (event.target.name !== "shipping") return;
    data.shipping = event.target.value;
    document.querySelector("#shipping-error").textContent = "";
    renderSummary();
    updateContinueState();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    let firstMissing;
    for (const product of products) {
      const block = document.querySelector(`[data-product="${product.id}"]`);
      const missing = !product.sizes.includes(data.sizes[product.field]);
      block.classList.toggle("is-invalid", missing);
      block.querySelector(".unified-error").textContent = missing ? `Selecione o tamanho de ${product.title}.` : "";
      if (missing && !firstMissing) firstMissing = block;
    }
    if (firstMissing) { firstMissing.scrollIntoView({ behavior: "smooth", block: "center" }); firstMissing.querySelector("button")?.focus(); return; }
    if (!data.cepValid || !data.address) { document.querySelector("#form-error").textContent = "Valide o CEP para continuar."; cepInput.focus(); return; }
    if (!data.shipping) { document.querySelector("#shipping-error").textContent = "Selecione uma modalidade de frete."; shippingOptions.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    const handoff = { sizes: data.sizes, cep: data.cep, address: data.address, shipping: data.shipping, expiresAt: Date.now() + 30 * 60 * 1000 };
    try {
      sessionStorage.setItem(selectionKey, JSON.stringify(data.sizes));
      sessionStorage.setItem(handoffKey, JSON.stringify(handoff));
    } catch { document.querySelector("#form-error").textContent = "Não foi possível salvar suas escolhas neste navegador. Habilite o armazenamento da sessão e tente novamente."; return; }
    window.location.assign("/checkout" + window.location.search);
  });

  renderSizes();
  renderSummary();
  updateContinueState();
})();
