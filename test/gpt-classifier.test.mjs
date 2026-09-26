import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { writeFile, readdir } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { askGpt, classifierArgs, classifierEnvironment, classifierPrompt, CLASSIFIER_SCHEMA,
  isRouterWrapperExecutable, parseClassifierResult } from "../src/gpt-classifier.mjs";
import { resolveClassifierCodex } from "../src/codex-cli.mjs";

const models = [{ id: "gpt-6-luna" }, { id: "gpt-6-sol" }];
const answer = { model: "gpt-6-luna", effort: "medium", confidence: 0.9, reason: "Bounded task" };

function fakeSpawn(result = JSON.stringify(answer), exitCode = 0) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter();
    let prompt = "";
    calls.push({ file, args, options, initialWorkFiles: readdirSync(options.cwd), get prompt() { return prompt; } });
    child.stdin = new Writable({
      write(chunk, _, callback) { prompt += chunk.toString(); callback(); },
      final(callback) {
        void (async () => {
          if (exitCode === 0) await writeFile(args[args.indexOf("--output-last-message") + 1], result);
          child.emit("close", exitCode);
          callback();
        })();
      },
    });
    child.kill = () => { queueMicrotask(() => child.emit("close", 1)); return true; };
    return child;
  };
  return { calls, spawnImpl };
}

test("strict schema and parser reject malformed, unknown model and invalid effort", () => {
  assert.equal(CLASSIFIER_SCHEMA.additionalProperties, false);
  assert.deepEqual(CLASSIFIER_SCHEMA.required, ["model", "effort", "confidence", "reason"]);
  assert.deepEqual(CLASSIFIER_SCHEMA.properties.model.enum, ["gpt-6-luna", "gpt-6-sol"]);
  for (const raw of ["bad", JSON.stringify({ ...answer, model: "gpt-6-astra" }),
    JSON.stringify({ ...answer, effort: "ultra" }), JSON.stringify({ ...answer, confidence: 2 }),
    JSON.stringify({ ...answer, extra: true })]) {
    assert.throws(() => parseClassifierResult(raw));
  }
  assert.deepEqual(parseClassifierResult(JSON.stringify(answer)), answer);
});

test("classifier prompt sends only bounded latest request and routing metadata", () => {
  const text = classifierPrompt({ prompt: "x".repeat(30000), currentModel: "gpt-6-sol", contextTokens: 12, models });
  assert.match(text, /truncated/);
  assert.ok(text.length < 15000);
  assert.match(text, /Available models: gpt-6-luna, gpt-6-sol/);
  assert.doesNotMatch(text, /source code|Git diff|credentials/i);
});

test("classifier uses official executable, ChatGPT login, isolated empty work dir and no tools", async () => {
  const fake = fakeSpawn();
  const parentEnv = {
    PATH: process.env.PATH, CODEX_HOME: "C:/chatgpt-auth", OPENAI_API_KEY: "fake-api-key",
    CODEX_API_KEY: "fake-api-key", CODEX_ACCESS_TOKEN: "fake-token",
    OPENAI_BASE_URL: "http://127.0.0.1:1111", ROUTER_BACKEND: "gpt",
    JEV_API_KEY: "fake-jev-key", CODEX_ROUTER_SHADOW: "1",
  };
  const actual = await askGpt({ prompt: "Read the file", currentModel: "gpt-6-sol", models,
    executable: "C:/official/codex.exe", spawnImpl: fake.spawnImpl, parentEnv });
  assert.deepEqual(actual, answer);
  assert.equal(fake.calls.length, 1);
  const [{ file, args, options, prompt, initialWorkFiles }] = fake.calls;
  assert.equal(file, "C:/official/codex.exe");
  assert.equal(options.shell, false);
  assert.match(prompt, /Read the file/);
  assert.equal(options.env.CODEX_HOME, "C:/chatgpt-auth");
  assert.equal(options.env.CODEX_ROUTER_CLASSIFIER, "1");
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN",
    "OPENAI_BASE_URL", "ROUTER_BACKEND", "JEV_API_KEY", "CODEX_ROUTER_SHADOW"]) {
    assert.equal(options.env[key], undefined);
  }
  assert.equal(args[0], "exec");
  assert.deepEqual(args.slice(1, 3), ["--model", "gpt-6-luna"]);
  for (const setting of ['model_provider="openai"', 'model_reasoning_effort="high"',
    'forced_login_method="chatgpt"', 'approval_policy="never"', 'web_search="disabled"',
    "project_doc_max_bytes=0"]) assert.ok(args.includes(setting), setting);
  for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules",
    "--skip-git-repo-check", "read-only", "shell_tool", "unified_exec", "unified_exec_tty", "multi_agent",
    "apps", "plugins", "computer_use", "browser_use", "image_generation", "hooks",
    "--output-schema", "--output-last-message"]) assert.ok(args.includes(flag), flag);
  assert.equal(args.at(-1), "-");
  assert.equal(options.cwd, args[args.indexOf("--cd") + 1]);
  assert.equal(join(dirname(options.cwd), "work"), options.cwd);
  assert.deepEqual(initialWorkFiles, []);
  assert.deepEqual(await readdir(options.cwd).catch(() => []), []); // temp directory was removed
});

test("classifier errors and unknown catalog model fail open", async () => {
  for (const [result, code] of [["malformed", 0], [JSON.stringify({ ...answer, model: "gpt-6-sol" }), 0],
    [JSON.stringify(answer), 1]]) {
    const fake = fakeSpawn(result, code);
    await assert.rejects(askGpt({ prompt: "Read", models: [models[0]], executable: "codex.exe",
      spawnImpl: fake.spawnImpl }));
  }
});

test("an aborted classifier kills its subprocess and fails open", async () => {
  const controller = new AbortController();
  let killed = 0;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.kill = () => { killed++; queueMicrotask(() => child.emit("close", 1)); return true; };
    queueMicrotask(() => controller.abort());
    return child;
  };
  await assert.rejects(askGpt({ prompt: "Read", models, executable: "codex.exe",
    spawnImpl, signal: controller.signal }));
  assert.equal(killed, 1);
});

test("aborting a classifier reaps its real fake subprocess", async () => {
  const controller = new AbortController();
  let child;
  let markSpawned;
  const spawned = new Promise((resolve) => { markSpawned = resolve; });
  const classification = askGpt({ prompt: "Read", models, executable: "codex.exe",
    signal: controller.signal,
    spawnImpl: (_file, _args, options) => {
      child = spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], options);
      markSpawned();
      return child;
    } });
  await spawned;
  const pid = child.pid;
  controller.abort();
  await assert.rejects(classification);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.throws(() => process.kill(pid, 0));
});

test("recursion guard skips classifier subprocess", async () => {
  const fake = fakeSpawn();
  assert.equal(await askGpt({ prompt: "Read", models, executable: "codex.exe",
    parentEnv: { CODEX_ROUTER_CLASSIFIER: "1" }, spawnImpl: fake.spawnImpl }), null);
  assert.equal(fake.calls.length, 0);
});

test("router wrapper cannot be used as a classifier executable", async () => {
  const wrapper = fileURLToPath(new URL("../bin/jev-codex.mjs", import.meta.url));
  const fake = fakeSpawn();
  assert.equal(isRouterWrapperExecutable(wrapper), true);
  assert.equal(resolveClassifierCodex({ file: wrapper, prefix: [], shell: false }), null);
  assert.equal(await askGpt({ prompt: "Read", models, executable: wrapper,
    spawnImpl: fake.spawnImpl }), null);
  assert.equal(fake.calls.length, 0);
});

test("classifier binary resolver points to installed official binary when present", () => {
  const resolved = resolveClassifierCodex();
  if (resolved) {
    assert.match(resolved, /[/\\]codex(?:\.exe)?$/i);
    assert.doesNotMatch(resolved, /codex-jev|codex-router/i);
  }
});

test("environment keeps Codex auth home while removing inherited provider and credentials", () => {
  const env = classifierEnvironment({ CODEX_HOME: "auth", CODEX_MODEL_PROVIDER: "jev",
    OPENAI_API_KEY: "key", CODEX_API_KEY: "key", CODEX_ACCESS_TOKEN: "token" });
  assert.equal(env.CODEX_HOME, "auth");
  assert.equal(env.CODEX_MODEL_PROVIDER, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.CODEX_ACCESS_TOKEN, undefined);
});
