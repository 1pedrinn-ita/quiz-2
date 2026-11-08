import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/assets/unified-checkout.js", import.meta.url), "utf8");

class Element {
  constructor(selector = "") {
    this.selector = selector;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.dataset = {};
    this.className = "";
    this.value = "";
    this.textContent = "";
    this.disabled = false;
    this.hidden = false;
    this.classList = {
      add: (name) => this.setClass(name, true),
      remove: (name) => this.setClass(name, false),
      toggle: (name, force) => this.setClass(name, force),
    };
  }
  setClass(name, enabled) {
    const names = new Set(this.className.split(/\s+/).filter(Boolean));
    enabled ? names.add(name) : names.delete(name);
    this.className = [...names].join(" ");
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  dispatch(type, event = {}) { for (const listener of this.listeners[type] || []) listener({ target: this, ...event }); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  querySelector(selector) {
    if (selector === ".unified-error") return this.error;
    if (selector === ".unified-size") return this.sizeButton;
    if (selector === "button") return this.children[0];
    return null;
  }
  querySelectorAll(selector) { return selector === "input" ? this.radios || [] : []; }
  scrollIntoView() {}
  focus() {}
}

function createPage(fetchImpl) {
  const selectors = new Map();
  const get = (selector) => {
    if (!selectors.has(selector)) selectors.set(selector, new Element(selector));
    return selectors.get(selector);
  };
  const products = {};
  const productShortcuts = [];
  for (const id of ["shoe", "shirt", "shorts"]) {
    const block = get(`[data-product="${id}"]`);
    block.error = new Element(".unified-error");
    block.children = [];
    block.scrollCount = 0;
    block.scrollIntoView = () => { block.scrollCount += 1; };
    block.sizeButton = new Element(".unified-size");
    products[id] = block;
    get(`[data-options="${id}"]`);
    const shortcut = new Element("product checkout shortcut");
    shortcut.setAttribute("data-focus-product", id);
    productShortcuts.push(shortcut);
  }
  const shipping = get("#shipping-options");
  const calculate = get("#calculate-cep");
  shipping.radios = [new Element("free radio"), new Element("express radio")];
  shipping.radios[0].value = "free";
  shipping.radios[1].value = "express";
  shipping.radios.forEach((radio) => { radio.name = "shipping"; });
  const storage = new Map();
  const context = {
    document: {
      querySelector: get,
      querySelectorAll: (selector) => selector === "[data-focus-product]" ? productShortcuts : [],
      createElement: (tag) => new Element(tag),
    },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    window: { location: { assigned: "", search: "", assign(value) { this.assigned = value; } } },
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ logradouro: "Praça da Sé", bairro: "Sé", localidade: "São Paulo", uf: "SP" }) })),
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    console,
  };
  vm.runInNewContext(source, context);
  return { context, get, products, storage, shipping, calculate, productShortcuts };
}

test("unified selection blocks incomplete sizes, resolves CEP, calculates both freight totals, and hands off choices", async () => {
  const page = createPage();
  const shoeButtons = page.get('[data-options="shoe"]').children;
  assert.equal(shoeButtons.length, 12);
  assert.equal(shoeButtons[0].textContent, "34");
  assert.equal(shoeButtons.at(-1).textContent, "45");
  assert.equal(page.get('[data-options="shirt"]').children.map((button) => button.textContent).join(","), "P,M,G");
  assert.equal(page.get('[data-options="shorts"]').children.map((button) => button.textContent).join(","), "P,M,G");
  assert.equal(page.get("#continue-button").disabled, true);

  shoeButtons[4].dispatch("click");
  let prevented = false;
  const incompleteSubmit = { preventDefault() { prevented = true; } };
  page.get("#unified-form").dispatch("submit", incompleteSubmit);
  assert.equal(prevented, true);
  assert.match(page.products.shirt.error.textContent, /Regata/);
  assert.match(page.products.shorts.error.textContent, /Shorts/);

  page.get('[data-options="shirt"]').children[1].dispatch("click");
  page.get('[data-options="shorts"]').children[2].dispatch("click");
  const cep = page.get("#unified-cep");
  cep.value = "01001000";
  cep.dispatch("input");
  assert.equal(cep.value, "01001-000");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(page.get("#cep-status").dataset.state, "success");
  assert.equal(page.shipping.disabled, false);
  page.shipping.dispatch("change", { target: page.shipping.radios[0] });
  assert.equal(page.get("#summary-total").textContent.replace(/\u00a0/g, " "), "R$ 97,90");
  assert.equal(page.get("#continue-button").disabled, false);

  page.shipping.dispatch("change", { target: page.shipping.radios[1] });
  assert.equal(page.get("#summary-total").textContent.replace(/\u00a0/g, " "), "R$ 106,35");
  const submit = { preventDefault() {} };
  page.get("#unified-form").dispatch("submit", submit);
  assert.equal(page.context.window.location.assigned, "/checkout");
  assert.deepEqual(JSON.parse(page.storage.get("corre-rosa-kit-selection-v1")), { shoe: "38", shirt: "M", shorts: "G" });
  const handoff = JSON.parse(page.storage.get("corre-rosa-unified-selection-v1"));
  assert.equal(handoff.cep, "01001000");
  assert.deepEqual(handoff.address, { street: "Praça da Sé", district: "Sé", city: "São Paulo", state: "SP" });
  assert.equal(handoff.shipping, "express");
});

test("invalid CEP never unlocks shipping or checkout", async () => {
  const page = createPage(async () => ({ ok: true, json: async () => ({ erro: true }) }));
  page.get("#unified-cep").value = "99999999";
  page.get("#unified-cep").dispatch("input");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(page.get("#cep-status").dataset.state, "error");
  assert.match(page.get("#cep-status").textContent, /CEP n.o encontrado/);
  assert.equal(page.shipping.disabled, true);
  assert.equal(page.get("#continue-button").disabled, true);
});
