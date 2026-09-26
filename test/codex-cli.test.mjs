import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { codexArgs } from "../src/codex-cli.mjs";

test("injects the bridge provider while forwarding full-access flags", () => {
  const args = codexArgs("http://127.0.0.1:4123", [
    "--dangerously-bypass-approvals-and-sandbox",
  ]);

  assert.ok(args.includes("--model"));
  assert.ok(args.includes("jev-router"));
  assert.ok(args.includes('model_provider="jev"'));
  assert.ok(args.includes('model_providers.jev.base_url="http://127.0.0.1:4123"'));
  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("does not override a user's explicit model", () => {
  const args = codexArgs("http://127.0.0.1:4123", ["--model", "gpt-5.6-sol"]);

  assert.equal(args.includes("jev-router"), false);
  assert.ok(args.includes("gpt-5.6-sol"));
});

test("Shadow Mode keeps Codex's model selection and explicit models", () => {
  const baseURL = "http://127.0.0.1:4123";
  const automatic = codexArgs(baseURL, [], { shadow: true });
  assert.equal(automatic.includes("--model"), false);
  assert.equal(automatic.includes("jev-router"), false);
  assert.ok(automatic.includes('model_provider="jev"'));

  const explicit = codexArgs(baseURL, ["--model", "gpt-6-sol"], { shadow: true });
  assert.deepEqual(explicit.slice(-2), ["--model", "gpt-6-sol"]);
});

test("Shadow Mode rejects explicit jev-router before starting Codex", () => {
  for (const args of [
    ["--model", "jev-router"], ["-m", "jev-router"], ["--model=jev-router"],
  ]) {
    assert.throws(() => codexArgs("http://127.0.0.1:4123", args, { shadow: true }),
      /Shadow Mode requires a real model/);
  }
});

test("JEV_CODEX_SHADOW=1 enables Shadow Mode for CLI arguments", () => {
  const previous = process.env.JEV_CODEX_SHADOW;
  process.env.JEV_CODEX_SHADOW = "1";
  try {
    assert.equal(codexArgs("http://127.0.0.1:4123").includes("jev-router"), false);
  } finally {
    if (previous === undefined) delete process.env.JEV_CODEX_SHADOW;
    else process.env.JEV_CODEX_SHADOW = previous;
  }
});

test("Shadow Mode CLI rejects jev-router before launching Codex", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/jev-codex.mjs", import.meta.url)), "--model", "jev-router"], {
    encoding: "utf8",
    env: { ...process.env, JEV_CODEX_SHADOW: "1" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Shadow Mode requires a real model/);
});
