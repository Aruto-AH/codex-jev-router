import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexArgs, resolveCodex, runCodex } from "../src/codex-cli.mjs";

test("Windows prefers the runnable Codex command shim over PowerShell script", () => {
  const command = resolveCodex();
  if (process.platform === "win32" && command && /[/\\]codex\.cmd$/i.test(command.file)) {
    assert.equal(command.shell, true);
    assert.deepEqual(command.prefix, []);
  }
});

test("injects the bridge provider while forwarding full-access flags", () => {
  const args = codexArgs("http://127.0.0.1:4123", [
    "--dangerously-bypass-approvals-and-sandbox",
  ], { backend: "jev" });

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

test("default GPT CLI uses the router provider and ChatGPT login", () => {
  const args = codexArgs("http://127.0.0.1:4123");
  assert.ok(args.includes('model_provider="router"'));
  assert.ok(args.includes('model_providers.router.base_url="http://127.0.0.1:4123"'));
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.ok(args.includes("jev-router"));
  const jev = codexArgs("http://127.0.0.1:4123", [], { backend: "jev" });
  assert.ok(jev.includes('model_provider="jev"'));
  assert.equal(jev.includes('forced_login_method="chatgpt"'), false);
});

test("exec receives the virtual model and local proxy provider as exec options", () => {
  const args = codexArgs("http://127.0.0.1:4123", ["exec", "--config",
    'approval_policy="never"', "--config", 'sandbox_mode="workspace-write"', "-"],
  { backend: "gpt", shadow: false });
  assert.equal(args[0], "exec");
  assert.deepEqual(args.slice(1, 3), ["--model", "jev-router"]);
  assert.ok(args.includes('model_provider="router"'));
  assert.ok(args.includes('model_providers.router.base_url="http://127.0.0.1:4123"'));
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.deepEqual(args.slice(-5), ["--config", 'approval_policy="never"',
    "--config", 'sandbox_mode="workspace-write"', "-"]);
});

test("exec resume receives automatic model and proxy options after the resume command", () => {
  const args = codexArgs("http://127.0.0.1:4123", ["exec", "resume", "--config",
    'approval_policy="never"', "--output-last-message", "report.txt", "thread-name", "-"],
  { backend: "gpt", shadow: false });
  assert.deepEqual(args.slice(0, 4), ["exec", "resume", "--model", "jev-router"]);
  assert.ok(args.includes('model_provider="router"'));
  assert.ok(args.includes('model_providers.router.base_url="http://127.0.0.1:4123"'));
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.deepEqual(args.slice(-6), ["--config", 'approval_policy="never"',
    "--output-last-message", "report.txt", "thread-name", "-"]);
});

test("exec launch passes local proxy config and raw UTF-8 prompt bytes to fake Codex", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-exec-test-"));
  const vendor = join(directory, "node_modules", "@openai", "codex", "node_modules",
    "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin");
  const promptFile = join(directory, "prompt.txt");
  const prompt = "README.mdを読んで、目的を3行で説明してください。";
  await mkdir(vendor, { recursive: true });
  await writeFile(join(directory, "codex.cmd"), "@echo off\r\n");
  await writeFile(join(vendor, "codex.exe"), "fake");
  await writeFile(promptFile, prompt, "utf8");
  const previous = { argv: process.argv, path: process.env.PATH,
    backend: process.env.ROUTER_BACKEND, shadow: process.env.CODEX_ROUTER_SHADOW,
    promptFile: process.env.CODEX_ROUTER_PROMPT_FILE, exitCode: process.exitCode };
  let launched;
  try {
    process.argv = [process.execPath, "router", "exec", "--config",
      'approval_policy="never"', "--config", 'sandbox_mode="workspace-write"', "-"];
    process.env.PATH = `${directory};${previous.path ?? ""}`;
    process.env.ROUTER_BACKEND = "gpt";
    process.env.CODEX_ROUTER_SHADOW = "0";
    process.env.CODEX_ROUTER_PROMPT_FILE = promptFile;
    await runCodex({ spawnImpl: (file, args, options) => {
      launched = { file, args, options, promptBytes: readFileSync(options.stdio[0]) };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    } });
    assert.match(launched.file, /[/\\]codex\.exe$/);
    assert.equal(launched.options.shell, false);
    assert.equal(launched.args[0], "exec");
    assert.ok(launched.args.includes('model_provider="router"'));
    assert.ok(launched.args.some((arg) =>
      /^model_providers\.router\.base_url="http:\/\/127\.0\.0\.1:\d+"$/.test(arg)));
    assert.ok(launched.args.includes('approval_policy="never"'));
    assert.ok(launched.args.includes('sandbox_mode="workspace-write"'));
    assert.deepEqual(launched.promptBytes, Buffer.from(prompt, "utf8"));
    assert.equal(launched.options.env.CODEX_ROUTER_PROMPT_FILE, undefined);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.argv = previous.argv;
    if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
    for (const [name, value] of [["ROUTER_BACKEND", previous.backend],
      ["CODEX_ROUTER_SHADOW", previous.shadow],
      ["CODEX_ROUTER_PROMPT_FILE", previous.promptFile]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    process.exitCode = previous.exitCode;
    await rm(directory, { recursive: true, force: true });
  }
});

test("exec saves only the applied proxy route after a successful fake Codex run", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-route-test-"));
  const vendor = join(directory, "node_modules", "@openai", "codex", "node_modules",
    "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin");
  const routeFile = join(directory, "route.json");
  await mkdir(vendor, { recursive: true });
  await writeFile(join(directory, "codex.cmd"), "@echo off\r\n");
  await writeFile(join(vendor, "codex.exe"), "fake");
  const previous = { argv: process.argv, path: process.env.PATH,
    backend: process.env.ROUTER_BACKEND, shadow: process.env.CODEX_ROUTER_SHADOW,
    routeFile: process.env.CODEX_ROUTER_ROUTE_FILE, exitCode: process.exitCode,
    fetch: globalThis.fetch };
  let forwarded;
  let child;
  try {
    process.argv = [process.execPath, "router", "exec", "-"];
    process.env.PATH = `${directory};${previous.path ?? ""}`;
    process.env.ROUTER_BACKEND = "gpt";
    process.env.CODEX_ROUTER_SHADOW = "0";
    process.env.CODEX_ROUTER_ROUTE_FILE = routeFile;
    globalThis.fetch = async (url, options) => {
      if (new URL(url).pathname.endsWith("/models")) {
        return new Response(JSON.stringify({ models: [
          { slug: "gpt-6-luna", supported_reasoning_levels: ["medium"] },
          { slug: "gpt-6-sol", supported_reasoning_levels: ["high"] },
        ] }), { headers: { "content-type": "application/json" } });
      }
      forwarded = JSON.parse(options.body);
      return new Response('event: response.created\ndata: {"type":"response.created"}\n\n',
        { headers: { "content-type": "text/event-stream" } });
    };
    await runCodex({ spawnImpl: (_file, args) => {
      child = new EventEmitter();
      queueMicrotask(async () => {
        try {
          const base = args.find((arg) => arg.startsWith('model_providers.router.base_url='));
          const url = JSON.parse(base.slice(base.indexOf("=") + 1));
          const response = await previous.fetch(`${url}/responses`, { method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "jev-router", input: [], reasoning: { effort: "high" } }) });
          await response.text();
          child.emit("exit", 0, null);
        } catch (error) { child.emit("error", error); child.emit("exit", 1, null); }
      });
      return child;
    } });
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(process.exitCode, 0);
    assert.equal(forwarded.model, "gpt-6-sol");
    assert.deepEqual(JSON.parse(readFileSync(routeFile, "utf8")),
      { model: "gpt-6-sol", effort: "high" });
  } finally {
    globalThis.fetch = previous.fetch;
    process.argv = previous.argv;
    if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
    for (const [name, value] of [["ROUTER_BACKEND", previous.backend],
      ["CODEX_ROUTER_SHADOW", previous.shadow],
      ["CODEX_ROUTER_ROUTE_FILE", previous.routeFile]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    process.exitCode = previous.exitCode;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Shadow Mode keeps Codex's model selection and explicit models", () => {
  const baseURL = "http://127.0.0.1:4123";
  const automatic = codexArgs(baseURL, [], { shadow: true });
  assert.equal(automatic.includes("--model"), false);
  assert.equal(automatic.includes("jev-router"), false);
  assert.ok(automatic.includes('model_provider="router"'));

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

test("CODEX_ROUTER_SHADOW takes precedence over its legacy alias", () => {
  const previous = [process.env.CODEX_ROUTER_SHADOW, process.env.JEV_CODEX_SHADOW];
  try {
    process.env.CODEX_ROUTER_SHADOW = "1";
    process.env.JEV_CODEX_SHADOW = "0";
    assert.equal(codexArgs("http://127.0.0.1:4123").includes("jev-router"), false);
    process.env.CODEX_ROUTER_SHADOW = "0";
    process.env.JEV_CODEX_SHADOW = "1";
    assert.equal(codexArgs("http://127.0.0.1:4123").includes("jev-router"), true);
  } finally {
    for (const [name, value] of [["CODEX_ROUTER_SHADOW", previous[0]], ["JEV_CODEX_SHADOW", previous[1]]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
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
