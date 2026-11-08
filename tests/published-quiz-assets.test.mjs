import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("published quiz bundle has every local JavaScript dependency", async () => {
  const publishAssets = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../quiz oferta extraido/assets",
  );
  const files = await readdir(publishAssets);
  const jsFiles = files.filter((name) => name.endsWith(".js"));
  const missing = [];

  for (const name of jsFiles) {
    const source = await readFile(path.join(publishAssets, name), "utf8");
    const imports = /(?:\bfrom\s*|\bimport\s*\()(["'])(\.[^"']+)\1/g;

    for (const match of source.matchAll(imports)) {
      const target = path.resolve(publishAssets, match[2]);
      try {
        await readFile(target);
      } catch {
        missing.push(`${name} -> ${match[2]}`);
      }
    }
  }

  assert.deepEqual(missing, []);
});

test("published recovered modules are byte-for-byte originals", async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const recoveredAssets = path.join(
    projectRoot,
    "frontend-recovery-staging/ocorrecorrendotudo/assets",
  );
  const publishAssets = path.join(projectRoot, "quiz oferta extraido/assets");
  const recoveredFiles = (await readdir(recoveredAssets)).filter((name) =>
    [".js", ".css"].includes(path.extname(name)),
  );

  for (const name of recoveredFiles) {
    assert.deepEqual(
      await readFile(path.join(publishAssets, name)),
      await readFile(path.join(recoveredAssets, name)),
      `${name} must remain identical to the recovered original`,
    );
  }
});
