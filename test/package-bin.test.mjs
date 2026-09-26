import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("exposes the new CLI name and the backward-compatible alias", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  assert.equal(packageJson.bin["codex-jev"], "./bin/jev-codex.mjs");
  assert.equal(packageJson.bin["codex-router"], "./bin/jev-codex.mjs");
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(lock.packages[""].bin["codex-jev"], "bin/jev-codex.mjs");
  assert.equal(lock.packages[""].bin["codex-router"], "bin/jev-codex.mjs");
});
