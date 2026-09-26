import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { askJev, createJevClient } from "./jev-client.mjs";
import { startCodexProxy } from "./proxy.mjs";

const PROVIDER = "jev";
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
  const windows = process.platform === "win32";
  const extensions = windows ? [".exe", ".ps1", ".cmd", ".bat"] : [""];
  for (const directory of (process.env.PATH ?? "").split(windows ? ";" : ":")) {
    if (!directory) continue;
    for (const extension of extensions) {
      const file = join(directory.replace(/^"|"$/g, ""), `codex${extension}`);
      try {
        accessSync(file, constants.F_OK);
        if (/\.ps1$/i.test(file)) {
          return { file: "powershell.exe", prefix: ["-NoProfile", "-File", file], shell: false };
        }
        return { file, prefix: [], shell: /\.(cmd|bat)$/i.test(file) };
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}

export function codexArgs(baseURL, args = [], { shadow = process.env.JEV_CODEX_SHADOW === "1" } = {}) {
  if (shadow && hasVirtualModelArg(args)) {
    throw new Error("Shadow Mode requires a real model; --model jev-router cannot be used.");
  }
  const hasExplicitModel = args.some(
    (arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="),
  );
  return [
    ...(shadow || hasExplicitModel ? [] : ["--model", AUTO_MODEL]),
    "--config",
    `model_provider="${PROVIDER}"`,
    "--config",
    `model_providers.${PROVIDER}.name="Jev Codex Bridge"`,
    "--config",
    `model_providers.${PROVIDER}.base_url="${baseURL}"`,
    "--config",
    `model_providers.${PROVIDER}.wire_api="responses"`,
    "--config",
    `model_providers.${PROVIDER}.requires_openai_auth=true`,
    "--config",
    `model_providers.${PROVIDER}.supports_websockets=false`,
    ...args,
  ];
}

export async function runCodex({ spawnImpl = spawn } = {}) {
  loadEnv();
  const userArgs = process.argv.slice(2);
  const shadow = process.env.JEV_CODEX_SHADOW === "1";
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

  const apiKey = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      "[codex-jev] no Jev API key found; running with routing fallback. " +
      "Set JEV_API_KEY in ~/.jev-codex.env to enable routing.\n",
    );
  }
  const jev = apiKey ? createJevClient({ apiKey, baseURL: process.env.JEV_BASE_URL }) : null;
  const proxy = await startCodexProxy({
    route: (input) => askJev({ ...input, client: jev }),
  });
  const args = codexArgs(`http://${proxy.host}:${proxy.port}`, userArgs, { shadow });
  const child = spawnImpl(command.file, [...command.prefix, ...args], {
    stdio: "inherit",
    shell: command.shell,
    env: process.env,
  });

  const cleanup = () => proxy.close().catch(() => {});
  child.on("error", (error) => {
    cleanup();
    process.stderr.write(`[codex-jev] could not start Codex: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    cleanup();
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}
