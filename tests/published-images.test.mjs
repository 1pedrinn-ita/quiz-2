import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publishRoot = path.join(projectRoot, "quiz oferta extraido");
const publishCampaign = path.join(publishRoot, "campaign");

test("all recovered campaign images are present byte-for-byte in the Netlify publish folder", async () => {
  const recoveredCampaign = path.join(
    projectRoot,
    "frontend-recovery-staging/ocorrecorrendotudo/campaign",
  );
  const recoveredFiles = await readdir(recoveredCampaign);

  for (const name of recoveredFiles) {
    const original = await readFile(path.join(recoveredCampaign, name));
    const published = await readFile(path.join(publishCampaign, name));
    assert.deepEqual(published, original, name + " must match the recovered original");
  }
});

test("campaign image references in published HTML and JavaScript resolve locally", async () => {
  const assetDir = path.join(publishRoot, "assets");
  const assetFiles = await readdir(assetDir);
  const htmlFiles = [
    path.join(publishRoot, "index.html"),
    path.join(publishRoot, "quiz/index.html"),
  ];
  const sources = await Promise.all(
    htmlFiles.map((file) => readFile(file, "utf8")),
  );

  for (const name of assetFiles.filter((file) => file.endsWith(".js"))) {
    sources.push(await readFile(path.join(assetDir, name), "utf8"));
  }

  const references = new Set();
  const imagePath = /\/campaign\/([A-Za-z0-9_.-]+\.(?:webp|png|jpe?g|avif|gif|svg))/gi;
  for (const source of sources) {
    for (const match of source.matchAll(imagePath)) references.add(match[1]);
  }

  for (const name of references) {
    await readFile(path.join(publishCampaign, name));
  }

  for (const name of [
    "pay-hipercard-white.webp",
    "pay-elo-white.webp",
    "pay-mastercard-white.webp",
    "pay-pix-white.webp",
  ]) {
    const bytes = await readFile(path.join(publishCampaign, name));
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF", name);
    assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP", name);
  }
});
