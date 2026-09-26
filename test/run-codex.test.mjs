import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, copyFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../run-codex.ps1", import.meta.url));
const windows = process.platform === "win32";

async function runFakeScript({ mode, prompt, model = "gpt-6-luna", effort = "medium", fail = false,
  missingRoute = false }) {
  const directory = await mkdtemp(join(tmpdir(), "router-script-test-"));
  const promptFile = join(directory, "prompt.txt");
  const testScript = join(directory, "run-codex.ps1");
  const recordFile = join(directory, "record.json");
  const clipboardFile = join(directory, "clipboard.txt");
  const restoredFile = join(directory, "restored.json");
  await writeFile(promptFile, prompt, "utf8");
  await copyFile(script, testScript);
  const command = `
function node {
  param($router, $verb, $configFlag1, $approvalPolicy, $configFlag2, $sandboxMode,
    $flag, $report, $stdinMarker)
  $promptBytes = [IO.File]::ReadAllBytes($env:CODEX_ROUTER_PROMPT_FILE)
  $received = [Text.Encoding]::UTF8.GetString($promptBytes)
  @{ router = $router; verb = $verb; flag = $flag; report = $report;
     configFlag1 = $configFlag1; approvalPolicy = $approvalPolicy;
     configFlag2 = $configFlag2; sandboxMode = $sandboxMode;
     stdinMarker = $stdinMarker; prompt = $received;
     promptBytes = [Convert]::ToBase64String($promptBytes);
     stdinObjects = @($input).Count; backend = $env:ROUTER_BACKEND;
     shadow = $env:CODEX_ROUTER_SHADOW; routeFile = $env:CODEX_ROUTER_ROUTE_FILE } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $env:TEST_RECORD -Encoding UTF8
  if ($env:TEST_FAIL -eq '1') {
    Write-Error 'The jev-router model is not supported when using Codex with a ChatGPT account.'
    $global:LASTEXITCODE = 7
    return
  }
  [IO.File]::WriteAllText($report, 'fake final answer', [Text.Encoding]::UTF8)
  if ($env:TEST_MISSING_ROUTE -ne '1') {
    [IO.File]::WriteAllText($env:CODEX_ROUTER_ROUTE_FILE,
      (@{ model = $env:TEST_ROUTE_MODEL; effort = $env:TEST_ROUTE_EFFORT } | ConvertTo-Json -Compress),
      [Text.Encoding]::UTF8)
  }
  $global:LASTEXITCODE = 0
}
function Set-Clipboard {
  param([string]$Value)
  [IO.File]::WriteAllText($env:TEST_CLIPBOARD, $Value, [Text.Encoding]::UTF8)
}
if ($env:TEST_MODE -eq 'File') { & $env:TEST_SCRIPT $env:TEST_PROMPT_FILE }
else { & $env:TEST_SCRIPT -Prompt $env:TEST_PROMPT_TEXT }
$scriptExit = $LASTEXITCODE
@{ backend = $env:ROUTER_BACKEND; shadow = $env:CODEX_ROUTER_SHADOW;
   promptFile = $env:CODEX_ROUTER_PROMPT_FILE; routeFile = $env:CODEX_ROUTER_ROUTE_FILE } |
  ConvertTo-Json -Compress | Set-Content -LiteralPath $env:TEST_RESTORED -Encoding UTF8
exit $scriptExit
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
    encoding: "utf8",
    env: { ...process.env, TEST_SCRIPT: testScript, TEST_MODE: mode,
      TEST_PROMPT_FILE: promptFile, TEST_PROMPT_TEXT: prompt,
      TEST_RECORD: recordFile, TEST_CLIPBOARD: clipboardFile,
      TEST_RESTORED: restoredFile, TEST_FAIL: fail ? "1" : "0",
      TEST_ROUTE_MODEL: model, TEST_ROUTE_EFFORT: effort,
      TEST_MISSING_ROUTE: missingRoute ? "1" : "0",
      ROUTER_BACKEND: "jev", CODEX_ROUTER_SHADOW: "1",
      CODEX_ROUTER_PROMPT_FILE: "original-prompt-file",
      CODEX_ROUTER_ROUTE_FILE: "original-route-file" },
  });
  try {
    return { result, record: JSON.parse((await readFile(recordFile, "utf8")).replace(/^\uFEFF/, "")),
      clipboard: await readFile(clipboardFile, "utf8")
        .then((value) => value.replace(/^\uFEFF/, "")).catch(() => null),
      report: await readFile(join(directory, ".codex-router", "last-report.txt"), "utf8").catch(() => null),
      leftovers: await readdir(join(directory, ".codex-router")).catch(() => []),
      restored: await readFile(restoredFile, "utf8")
        .then((value) => JSON.parse(value.replace(/^\uFEFF/, ""))).catch(() => null) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Windows helper accepts a UTF-8 prompt file and -Prompt without live Codex", { skip: !windows }, async () => {
  const prompt = "README.mdを読んで、このリポジトリの目的を3行で説明してください。";
  for (const mode of ["File", "Text"]) {
    const { result, record, clipboard, report, restored, leftovers } = await runFakeScript({ mode, prompt });
    assert.equal(result.status, 0, result.stderr);
    assert.match(record.router, /[/\\]bin[/\\]jev-codex\.mjs$/);
    assert.deepEqual([record.verb, record.flag, record.stdinMarker],
      ["exec", "--output-last-message", "-"]);
    assert.deepEqual([record.configFlag1, record.approvalPolicy,
      record.configFlag2, record.sandboxMode],
    ["--config", 'approval_policy="never"', "--config", 'sandbox_mode="workspace-write"']);
    assert.equal(record.prompt, prompt);
    assert.equal(record.promptBytes, Buffer.from(prompt, "utf8").toString("base64"));
    assert.equal(record.stdinObjects, 0);
    assert.deepEqual([record.backend, record.shadow], ["gpt", "0"]);
    assert.equal(clipboard, "fake final answer");
    assert.equal(report.replace(/^\uFEFF/, ""), "fake final answer");
    assert.deepEqual(restored, { backend: "jev", shadow: "1",
      promptFile: "original-prompt-file", routeFile: "original-route-file" });
    assert.match(record.routeFile, /[/\\]\.codex-router[/\\]/);
    assert.deepEqual(leftovers, ["last-report.txt"]);
    assert.match(result.stdout, /^Routed: gpt-6-luna \/ medium\r?\n/);
    assert.match(result.stdout, /Codex report saved: .*last-report\.txt/);
    assert.match(result.stdout, /Report copied to clipboard\./);
    assert.doesNotMatch(result.stdout, /README\.md|fake final answer/);
  }
});

test("Windows helper preserves failure exit code and clipboard", { skip: !windows }, async () => {
  const { result, record, clipboard } = await runFakeScript({ mode: "Text", prompt: "失敗", fail: true });
  assert.equal(result.status, 7);
  assert.equal(record.backend, "gpt");
  assert.equal(clipboard, null);
  assert.match(result.stderr, /Codex failed with exit code 7/);
  assert.match(result.stderr, /The jev-router model is not supported/);
  assert.doesNotMatch(result.stdout, /Routed:/);
});

test("Windows helper prints the applied Sol route without report text", { skip: !windows }, async () => {
  const { result, clipboard, leftovers } = await runFakeScript({ mode: "Text",
    prompt: "日本語の指示", model: "gpt-6-sol", effort: "high" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Routed: gpt-6-sol \/ high\r?\n/);
  assert.doesNotMatch(result.stdout, /日本語の指示|fake final answer/);
  assert.equal(clipboard, "fake final answer");
  assert.deepEqual(leftovers, ["last-report.txt"]);
});

test("Windows helper does not claim success without applied route metadata", { skip: !windows }, async () => {
  const { result, clipboard, leftovers } = await runFakeScript({ mode: "Text",
    prompt: "日本語の指示", missingRoute: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not record an applied route/);
  assert.doesNotMatch(result.stdout, /Routed:|Report copied/);
  assert.equal(clipboard, null);
  assert.deepEqual(leftovers, []);
});
