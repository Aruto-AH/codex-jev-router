import { accessSync, closeSync, constants, openSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { askGpt, chatgptEnvironment, isRouterWrapperExecutable } from "./gpt-classifier.mjs";
import { startCodexProxy } from "./proxy.mjs";

const AUTO_MODEL = "jev-router";
const hasVirtualModelArg = (args) => args.some((arg, index) =>
  (arg === "--model" || arg === "-m") ? args[index + 1] === AUTO_MODEL :
    arg === `--model=${AUTO_MODEL}`,
);

export function loadEnv({ cwd = process.cwd(), home = homedir() } = {}) {
  for (const file of [
    join(cwd, ".env"),
    join(home, ".jev-codex.env"),
    join(home, ".jev-router.env"),
  ]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Missing local secret files are valid; the process environment may already contain a key.
    }
  }
}

export function resolveCodex() {
  if (process.platform !== "win32") return null;
  for (const directory of (process.env.PATH ?? "").split(";")) {
    if (!directory) continue;
    for (const extension of [".exe", ".cmd"]) {
      const file = join(directory.replace(/^"|"$/g, ""), `codex${extension}`);
      try {
        accessSync(file, constants.F_OK);
        return { file, prefix: [], shell: /\.cmd$/i.test(file) };
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}

/** Resolve the official native binary, never a router command or a shell shim. */
export function resolveClassifierCodex(command = resolveCodex()) {
  if (process.platform !== "win32" || !command) return null;
  const file = command.file;
  if (!file || /codex-jev|codex-router/i.test(file)) return null;
  const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const platformPackage = `codex-win32-${process.arch}`;
  const binary = "codex.exe";
  const npmRoot = dirname(file);
  const packageRoot = join(npmRoot, "node_modules", "@openai", "codex");
  let realFile;
  try { realFile = realpathSync(file); } catch { return null; }
  if (isRouterWrapperExecutable(realFile)) return null;
  const vendorSuffix = join("vendor", triple, "bin", binary).toLowerCase();
  if (realFile.toLowerCase().endsWith(vendorSuffix) &&
      /[/\\]node_modules[/\\]@openai[/\\]codex(?:-win32-(?:x64|arm64))?[/\\]/i.test(realFile)) {
    return realFile;
  }
  const linkedPackageRoot = /[/\\]bin[/\\]codex\.js$/i.test(realFile)
    ? dirname(dirname(realFile)) : null;
  for (const root of [
    join(packageRoot, "node_modules", "@openai", platformPackage),
    join(npmRoot, "node_modules", "@openai", platformPackage),
    ...(linkedPackageRoot ? [join(linkedPackageRoot, "node_modules", "@openai", platformPackage), linkedPackageRoot] : []),
    packageRoot,
  ]) {
    const candidate = join(root, "vendor", triple, "bin", binary);
    try {
      accessSync(candidate, constants.F_OK);
      const resolved = realpathSync(candidate);
      if (!isRouterWrapperExecutable(resolved)) return resolved;
    } catch { /* next */ }
  }
  return null;
}

export function codexArgs(baseURL, args = [], {
  shadow = process.env.CODEX_ROUTER_SHADOW === "1" ||
    (process.env.CODEX_ROUTER_SHADOW === undefined && process.env.JEV_CODEX_SHADOW === "1"),
  backend = process.env.ROUTER_BACKEND ?? "gpt",
} = {}) {
  if (shadow && hasVirtualModelArg(args)) {
    throw new Error("Shadow Mode requires a real model; --model jev-router cannot be used.");
  }
  const hasExplicitModel = args.some(
    (arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="),
  );
  const provider = backend === "jev" ? "jev" : "router";
  const name = backend === "jev" ? "Jev Codex Bridge" : "Codex Router Bridge";
  const routerArgs = [
    ...(shadow || hasExplicitModel ? [] : ["--model", AUTO_MODEL]),
    "--config",
    `model_provider="${provider}"`,
    "--config",
    `model_providers.${provider}.name="${name}"`,
    "--config",
    `model_providers.${provider}.base_url="${baseURL}"`,
    "--config",
    `model_providers.${provider}.wire_api="responses"`,
    "--config",
    `model_providers.${provider}.requires_openai_auth=true`,
    "--config",
    `model_providers.${provider}.supports_websockets=false`,
    ...(backend === "gpt" ? ["--config", 'forced_login_method="chatgpt"'] : []),
  ];
  if (args[0] === "exec" || args[0] === "e") {
    if (args[1] === "resume") {
      return [args[0], args[1], ...routerArgs, ...args.slice(2)];
    }
    return [args[0], ...routerArgs, ...args.slice(1)];
  }
  return [...routerArgs, ...args];
}

export async function runCodex({ spawnImpl = spawn } = {}) {
  const userArgs = process.argv.slice(2);
  const shadow = process.env.CODEX_ROUTER_SHADOW === "1" ||
    (process.env.CODEX_ROUTER_SHADOW === undefined && process.env.JEV_CODEX_SHADOW === "1");
  const backend = process.env.ROUTER_BACKEND ?? "gpt";
  if (backend !== "gpt" && backend !== "jev") {
    process.stderr.write(`[codex-router] Unknown ROUTER_BACKEND: ${backend}\n`);
    process.exitCode = 1;
    return;
  }
  if (backend === "jev" && process.env.CODEX_ROUTER_CLASSIFIER !== "1") loadEnv();
  if (shadow && hasVirtualModelArg(userArgs)) {
    process.stderr.write("[codex-jev] Shadow Mode requires a real model; --model jev-router cannot be used.\n");
    process.exitCode = 1;
    return;
  }
  const command = resolveCodex();
  if (!command) {
    process.stderr.write("[codex-jev] OpenAI Codex is not installed or is not on PATH.\n");
    process.exitCode = 1;
    return;
  }
  const nativeExecutable = resolveClassifierCodex(command);
  const launch = nativeExecutable
    ? { file: nativeExecutable, prefix: [], shell: false } : command;

  if (process.env.CODEX_ROUTER_CLASSIFIER === "1") {
    if (!nativeExecutable) {
      process.stderr.write("[codex-router] Official Codex classifier binary not found.\n");
      process.exitCode = 1;
      return;
    }
    const child = spawnImpl(nativeExecutable, userArgs, {
      stdio: "inherit", shell: false, env: process.env,
    });
    child.on("error", () => { process.exitCode = 1; });
    child.on("exit", (code, signal) => { process.exitCode = signal ? 1 : (code ?? 0); });
    return;
  }

  const apiKey = backend === "jev" ? process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY : null;
  if (backend === "jev" && !apiKey) {
    process.stderr.write(
      "[codex-jev] no Jev API key found; running with routing fallback. " +
      "Set JEV_API_KEY in ~/.jev-codex.env to enable routing.\n",
    );
  }
  const jevModule = backend === "jev" ? await import("./jev-client.mjs") : null;
  const jev = apiKey ? jevModule.createJevClient({ apiKey, baseURL: process.env.JEV_BASE_URL }) : null;
  const classifierExecutable = backend === "gpt" ? nativeExecutable : null;
  if (backend === "gpt" && !classifierExecutable) {
    process.stderr.write("[codex-router] Official Codex classifier binary not found; using routing fallback.\n");
  }
  const proxy = await startCodexProxy({
    backend,
    route: backend === "gpt"
      ? (input) => askGpt({ ...input, executable: classifierExecutable })
      : (input) => jevModule.askJev({ ...input, client: jev }),
  });
  const args = codexArgs(`http://${proxy.host}:${proxy.port}`, userArgs, { shadow, backend });
  const promptFile = process.env.CODEX_ROUTER_PROMPT_FILE;
  const routeFile = process.env.CODEX_ROUTER_ROUTE_FILE;
  let promptFd;
  let child;
  try {
    if (promptFile) {
      if (!(["exec", "e"].includes(userArgs[0]) && userArgs.at(-1) === "-")) {
        throw new Error("CODEX_ROUTER_PROMPT_FILE requires an exec request ending in '-'.");
      }
      promptFd = openSync(promptFile, "r");
    }
    const env = backend === "gpt" ? chatgptEnvironment() : { ...process.env };
    delete env.CODEX_ROUTER_PROMPT_FILE;
    child = spawnImpl(launch.file, [...launch.prefix, ...args], {
      stdio: promptFd === undefined ? "inherit" : [promptFd, "inherit", "inherit"],
      shell: launch.shell,
      env,
    });
  } catch (error) {
    await proxy.close();
    throw error;
  } finally {
    if (promptFd !== undefined) closeSync(promptFd);
  }

  const cleanup = () => proxy.close().catch(() => {});
  child.on("error", (error) => {
    cleanup();
    process.stderr.write(`[codex-jev] could not start Codex: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    cleanup();
    process.exitCode = signal ? 1 : (code ?? 0);
    if (process.exitCode === 0 && routeFile) {
      const applied = proxy.getLastAppliedRoute();
      if (!applied) {
        process.stderr.write("[codex-router] No applied route was recorded.\n");
        process.exitCode = 1;
      } else {
        try {
          writeFileSync(routeFile, JSON.stringify(applied), { encoding: "utf8", flag: "wx" });
        } catch (error) {
          process.stderr.write(`[codex-router] Could not save applied route: ${error.message}\n`);
          process.exitCode = 1;
        }
      }
    }
  });
}
