import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../run-codex.ps1", import.meta.url));
const windows = process.platform === "win32";

const fakeCodex = [
  'import { readFileSync, writeFileSync } from "node:fs";',
  'const args = process.argv.slice(2);',
  'const report = args[args.indexOf("--output-last-message") + 1];',
  'const promptBytes = readFileSync(process.env.CODEX_ROUTER_PROMPT_FILE);',
  'const stdinChunks = [];',
  'for await (const chunk of process.stdin) stdinChunks.push(chunk);',
  'writeFileSync(process.env.TEST_RECORD, JSON.stringify({',
  '  args, prompt: promptBytes.toString("utf8"),',
  '  promptBytes: promptBytes.toString("base64"),',
  '  stdinBytes: Buffer.concat(stdinChunks).length,',
  '  backend: process.env.ROUTER_BACKEND,',
  '  shadow: process.env.CODEX_ROUTER_SHADOW,',
  '  routeFile: process.env.CODEX_ROUTER_ROUTE_FILE,',
  '}));',
  'process.stdout.write("internal Codex output\\n");',
  'if (process.env.TEST_FLOOD === "1") {',
  '  process.stdout.write("o".repeat(1024 * 1024));',
  '  process.stderr.write("e".repeat(1024 * 1024));',
  '}',
  'setTimeout(() => {',
  '  if (process.env.TEST_FAIL === "1") {',
  '    process.stderr.write("The jev-router model is not supported when using Codex with a ChatGPT account.\\n");',
  '    process.exit(7);',
  '  }',
  '  writeFileSync(report, "fake final answer");',
  '  if (process.env.TEST_MISSING_ROUTE !== "1") {',
  '    writeFileSync(process.env.CODEX_ROUTER_ROUTE_FILE, JSON.stringify({',
  '      model: process.env.TEST_ROUTE_MODEL, effort: process.env.TEST_ROUTE_EFFORT,',
  '    }));',
  '  }',
  '}, Number(process.env.TEST_DELAY_MS));',
].join("\n");

async function runFakeScript({ mode, prompt, resumeSessionId, model = "gpt-6-luna",
  effort = "medium", fail = false, missingRoute = false, flood = false, delayMs = 0,
  heartbeatIntervalMs = 80 }) {
  const testRoot = await mkdtemp(join(tmpdir(), "router-script-test-"));
  const directory = join(testRoot, "with space");
  const promptFile = join(directory, "prompt.txt");
  const testScript = join(directory, "run-codex.ps1");
  const recordFile = join(directory, "record.json");
  const clipboardFile = join(directory, "clipboard.txt");
  const restoredFile = join(directory, "restored.json");
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(promptFile, prompt, "utf8");
  await copyFile(script, testScript);
  await writeFile(join(directory, "bin", "jev-codex.mjs"), fakeCodex, "utf8");
  const command = [
    "function Set-Clipboard {",
    "  param([string]$Value)",
    "  [IO.File]::WriteAllText($env:TEST_CLIPBOARD, $Value, [Text.Encoding]::UTF8)",
    "}",
    "$resumeArgs = @{}",
    "if ($env:TEST_RESUME_SESSION_ID) { $resumeArgs.ResumeSessionId = $env:TEST_RESUME_SESSION_ID }",
    "if ($env:TEST_MODE -eq 'File') { & $env:TEST_SCRIPT @resumeArgs $env:TEST_PROMPT_FILE }",
    "else { & $env:TEST_SCRIPT @resumeArgs -Prompt $env:TEST_PROMPT_TEXT }",
    "$scriptExit = $LASTEXITCODE",
    "@{ backend = $env:ROUTER_BACKEND; shadow = $env:CODEX_ROUTER_SHADOW;",
    "   promptFile = $env:CODEX_ROUTER_PROMPT_FILE; routeFile = $env:CODEX_ROUTER_ROUTE_FILE } |",
    "  ConvertTo-Json -Compress | Set-Content -LiteralPath $env:TEST_RESTORED -Encoding UTF8",
    "exit $scriptExit",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, TEST_SCRIPT: testScript, TEST_MODE: mode,
      TEST_PROMPT_FILE: promptFile, TEST_PROMPT_TEXT: prompt,
      TEST_RESUME_SESSION_ID: resumeSessionId ?? "",
      TEST_RECORD: recordFile, TEST_CLIPBOARD: clipboardFile,
      TEST_RESTORED: restoredFile, TEST_FAIL: fail ? "1" : "0",
      TEST_FLOOD: flood ? "1" : "0",
      TEST_ROUTE_MODEL: model, TEST_ROUTE_EFFORT: effort,
      TEST_MISSING_ROUTE: missingRoute ? "1" : "0",
      TEST_DELAY_MS: String(delayMs),
      CODEX_ROUTER_HEARTBEAT_INTERVAL_MS: String(heartbeatIntervalMs),
      ROUTER_BACKEND: "jev", CODEX_ROUTER_SHADOW: "1",
      CODEX_ROUTER_PROMPT_FILE: "original-prompt-file",
      CODEX_ROUTER_ROUTE_FILE: "original-route-file" },
  });
  try {
    return { result,
      record: await readFile(recordFile, "utf8").then(JSON.parse).catch(() => null),
      clipboard: await readFile(clipboardFile, "utf8")
        .then((value) => value.replace(/^\uFEFF/, "")).catch(() => null),
      report: await readFile(join(directory, ".codex-router", "last-report.txt"), "utf8")
        .catch(() => null),
      leftovers: await readdir(join(directory, ".codex-router")).catch(() => []),
      restored: await readFile(restoredFile, "utf8")
        .then((value) => JSON.parse(value.replace(/^\uFEFF/, ""))).catch(() => null),
    };
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}

function assertSuccessfulOutput(result, model, effort) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Routing request\.\.\.\r?\nCodex starting\.\.\.\r?\n/);
  assert.equal((result.stdout.match(/^Routed:/gm) ?? []).length, 1);
  assert.match(result.stdout, new RegExp("Routed: " + model + " / " + effort));
  assert.match(result.stdout, /Codex finished in \d{2}:\d{2}/);
  assert.match(result.stdout, /Codex report saved: .*last-report\.txt/);
  assert.match(result.stdout, /Report copied to clipboard\./);
  assert.doesNotMatch(result.stdout, /internal Codex output|fake final answer/);
}

test("Windows helper preserves new exec, prompt file and text, report, route and cleanup", { skip: !windows }, async () => {
  const prompt = "README.mdを読んで、目的を3行で説明してください。";
  for (const mode of ["File", "Text"]) {
    const { result, record, clipboard, report, restored, leftovers } =
      await runFakeScript({ mode, prompt });
    assertSuccessfulOutput(result, "gpt-6-luna", "medium");
    assert.deepEqual(record.args.slice(0, 5), ["exec", "--config",
      'approval_policy="never"', "--config", 'sandbox_mode="workspace-write"']);
    assert.equal(record.args[5], "--output-last-message");
    assert.match(record.args[6], /[/\\]\.codex-router[/\\]/);
    assert.equal(record.args[7], "-");
    assert.equal(record.args.length, 8);
    assert.equal(record.prompt, prompt);
    assert.equal(record.promptBytes, Buffer.from(prompt, "utf8").toString("base64"));
    assert.equal(record.stdinBytes, 0);
    assert.deepEqual([record.backend, record.shadow], ["gpt", "0"]);
    assert.equal(clipboard, "fake final answer");
    assert.equal(report, "fake final answer");
    assert.deepEqual(restored, { backend: "jev", shadow: "1",
      promptFile: "original-prompt-file", routeFile: "original-route-file" });
    assert.match(record.routeFile, /[/\\]\.codex-router[/\\]/);
    assert.deepEqual(leftovers, ["last-report.txt"]);
    assert.doesNotMatch(result.stdout, /README\.md/);
  }
});

test("Windows helper preserves exec resume with both prompt forms", { skip: !windows }, async () => {
  for (const mode of ["File", "Text"]) {
    const resumeSessionId = mode === "File"
      ? "12345678-1234-1234-1234-123456789abc" : "desktop-thread-name";
    const { result, record, clipboard, leftovers } = await runFakeScript({
      mode, prompt: "Continue the work", resumeSessionId,
      model: "gpt-6-sol", effort: "high",
    });
    assertSuccessfulOutput(result, "gpt-6-sol", "high");
    assert.deepEqual(record.args.slice(0, 6), ["exec", "resume", "--config",
      'approval_policy="never"', "--config", 'sandbox_mode="workspace-write"']);
    assert.equal(record.args[6], "--output-last-message");
    assert.deepEqual(record.args.slice(8), [resumeSessionId, "-"]);
    assert.equal(record.args.includes("--model"), false);
    assert.equal(record.prompt, "Continue the work");
    assert.equal(record.stdinBytes, 0);
    assert.equal(clipboard, "fake final answer");
    assert.deepEqual(leftovers, ["last-report.txt"]);
  }
});

test("Windows helper emits periodic heartbeat without exposing Codex output", { skip: !windows }, async () => {
  const { result } = await runFakeScript({
    mode: "Text", prompt: "Wait", delayMs: 320, heartbeatIntervalMs: 80,
  });
  assertSuccessfulOutput(result, "gpt-6-luna", "medium");
  const heartbeats = result.stdout.match(/^Codex running\.\.\. \d{2}:\d{2}$/gm) ?? [];
  assert.ok(heartbeats.length >= 2 && heartbeats.length <= 6, result.stdout);
  assert.ok(result.stdout.indexOf("Codex running...") < result.stdout.indexOf("Routed:"));
});

test("Windows helper drains large stdout and stderr concurrently", { skip: !windows }, async () => {
  const { result, record, report, leftovers } = await runFakeScript({
    mode: "Text", prompt: "Drain streams", flood: true,
  });
  assertSuccessfulOutput(result, "gpt-6-luna", "medium");
  assert.equal(record.stdinBytes, 0);
  assert.equal(report, "fake final answer");
  assert.deepEqual(leftovers, ["last-report.txt"]);
  assert.doesNotMatch(result.stdout, /o{100}/);
  assert.doesNotMatch(result.stderr, /e{100}|internal Codex output/);
});

test("Windows helper preserves Codex failure, stderr and exit code", { skip: !windows }, async () => {
  const { result, record, clipboard, leftovers } = await runFakeScript({
    mode: "Text", prompt: "Fail", fail: true, delayMs: 180,
  });
  assert.equal(result.status, 7);
  assert.equal(record.backend, "gpt");
  assert.equal(clipboard, null);
  assert.deepEqual(leftovers, []);
  assert.match(result.stdout, /^Routing request\.\.\.\r?\nCodex starting\.\.\.\r?\n/);
  assert.match(result.stdout, /Codex failed after \d{2}:\d{2}/);
  assert.match(result.stderr, /Codex failed with exit code 7/);
  assert.match(result.stderr, /The jev-router model is not supported/);
  assert.doesNotMatch(result.stdout, /Routed:|Codex finished|Report copied/);
});

test("Windows helper rejects absent or invalid applied route", { skip: !windows }, async () => {
  for (const options of [{ missingRoute: true }, { model: "gpt-6-astra" }]) {
    const { result, clipboard, leftovers } = await runFakeScript({
      mode: "Text", prompt: "Check route", ...options,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /applied route/);
    assert.doesNotMatch(result.stdout, /Routed:|Codex finished|Report copied/);
    assert.equal(clipboard, null);
    assert.deepEqual(leftovers, []);
  }
});
