# codex-jev-router

[![CI](https://github.com/tiandee/codex-jev-router/actions/workflows/ci.yml/badge.svg)](https://github.com/tiandee/codex-jev-router/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Route OpenAI Codex CLI turns through a separate Codex classifier. GPT routing is the default; the earlier Jev backend remains available with `ROUTER_BACKEND=jev`.

The wrapper starts a local loopback Responses API proxy. Automatic routing selects `gpt-6-luna` or `gpt-6-sol` and a supported reasoning effort for each new user turn. Tool continuations reuse the route. Explicit `--model` selections pass through without automatic routing.

The virtual model `jev-router` is retained for compatibility and appears as “Codex Router” in GPT mode. The proxy never forwards this virtual ID upstream. If classification fails, a previous route is preserved. On the first virtual-model turn, the proxy uses Sol when available, then Luna. If the native model catalog contains neither candidate, it returns `503 routing_unavailable` instead of choosing an unrelated model. If the catalog request itself fails, a static Luna/Sol capability fallback is used.

## Prerequisites

- Windows 11 and PowerShell
- Node.js 20 or newer
- npm-installed official OpenAI Codex CLI on `PATH` (`codex.cmd` or its official `codex.exe`)
- Existing ChatGPT/Codex login for GPT mode; no new OpenAI API key is needed
- Jev or TypeSafe API key only for optional Jev mode

This MIT-licensed package is not published to npm. Install it from source:

```powershell
git clone https://github.com/tiandee/codex-jev-router.git
cd codex-jev-router
npm.cmd install
npm.cmd link
codex-router --version
```

`codex-router` is the recommended entry point. `codex-jev` remains a compatible alias. Both use GPT mode by default.

## GPT routing

Start the wrapper in the project where you want to work:

```powershell
Set-Location C:\path\to\your\project
codex-router
```

From the router repository, `run-codex.ps1` runs a one-shot GPT-routed task without Shadow Mode:

```powershell
.\run-codex.ps1 .\prompt.txt
.\run-codex.ps1 -Prompt "指示"
```

It applies `approval_policy="never"` and `sandbox_mode="workspace-write"` only to that Codex invocation. Both prompt forms are passed to Codex through a temporary UTF-8 file, preserving Japanese text in Windows PowerShell 5.1. On success it prints the applied model and effort, saves the final Codex message to `.codex-router\last-report.txt`, and copies it to the Windows clipboard. The parent PowerShell environment is restored, and temporary prompt and route files are removed. The report directory is ignored by Git. A failed run shows Codex's stderr and leaves the clipboard unchanged.

On each new user turn, the wrapper starts one separate official `codex exec` process using `gpt-6-luna` with `high` reasoning. The classifier receives the latest user prompt (limited to 12,000 characters), the available candidate IDs, current model, approximate context size, and routing policy. It does not automatically receive earlier conversation turns, repository files, diffs, `.env`, or credentials.

The classifier uses the existing ChatGPT login. It runs with an ephemeral session, ignored user config and rules, an empty temporary working directory, a read-only sandbox, no approvals, disabled web search, shell, apps, plugins, and multi-agent features, and a strict JSON Schema response. Its process environment omits inherited OpenAI and Codex API credentials and router variables. It explicitly selects the official `openai` provider; the loopback proxy configuration used by the parent Codex is not inherited. A recursion guard skips classification if the wrapper is entered by a classifier process. The temporary schema and response files are removed after the run.

The routing policy chooses the least costly model likely to complete correctly in one pass. Luna is favored for inspection, status, short explanations, wording, local changes, routine work, and bounded implementation with direct verification. Sol is favored for architecture, unclear debugging, security-sensitive work, concurrency, migrations, large refactors, cross-cutting work, final integration, and critical review. Task length, file count, and the mere presence of code do not force Sol. A small local safety floor raises low-confidence or high-risk implementation decisions to Sol. Effort is limited to `low`, `medium`, `high`, or `max` and normalized to the selected model's native `supported_reasoning_levels`.

## Optional Jev mode

Set `ROUTER_BACKEND=jev` before starting the wrapper. Jev mode retains the existing Jev request, scoring, timeout, and fail-open behavior. Store its key outside the repository, for example in `$HOME\.jev-codex.env`:

```powershell
Set-Content -Path "$HOME\.jev-codex.env" -Value 'JEV_API_KEY=your_typesafe_api_key'
```

`JEV_API_KEY` may also be exported in the shell. Do not commit the key. Without it, Jev mode uses the normal first-turn fallback. `JEV_CODEX_AUTO_EFFORT=0` preserves Codex's incoming effort in Jev mode; otherwise Jev's `reasoning_required` score maps to `low` (< 0.30), `medium` (< 0.60), `high` (< 0.85), or `max`.

## Shadow Mode

Shadow Mode runs the selected classifier and shows its recommendation while forwarding the actual request unchanged:

```powershell
$env:CODEX_ROUTER_SHADOW="1"
codex-router
```

Example GPT commentary:

```text
Router recommendation: gpt-6-luna / medium
Actual request unchanged: gpt-6-sol / high
Backend: gpt
```

The older `JEV_CODEX_SHADOW=1` is supported as an alias. Shadow Mode rejects explicit `--model jev-router`, since a virtual model cannot be forwarded unchanged. Remove the environment variable to turn Shadow Mode off.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROUTER_BACKEND` | `gpt` | Choose `gpt` or `jev` |
| `CODEX_ROUTER_SHADOW` | unset | Set to `1` for non-mutating recommendations |
| `JEV_CODEX_SHADOW` | unset | Legacy Shadow Mode alias |
| `JEV_API_KEY` | unset | Enable optional Jev mode |
| `JEV_BASE_URL` | TypeSafe default | Override Jev endpoint |
| `JEV_CODEX_AUTO_EFFORT` | `1` | Derive Jev effort from reasoning score |
| `JEV_CODEX_API_BASE_URL` | OpenAI API default | Override the upstream in Jev mode only |
| `JEV_CODEX_CHATGPT_BASE_URL` | ChatGPT Codex default | Override the upstream in Jev mode only |
| `JEV_CODEX_DEBUG` | unset | Log route metadata without prompts or keys when `1` |

## Development

```powershell
npm.cmd test
npm.cmd run smoke
npm.cmd audit --omit=dev
```

The tests use a fake classifier subprocess, fake Jev boundary, and local fake upstream. They do not consume Codex quota. The smoke check also uses a local fake upstream.

## Security notes

- Keep Codex and optional TypeSafe credentials outside the repository.
- The proxy binds to `127.0.0.1` and does not log prompts or authorization headers.
- Full-access mode for the main Codex session remains unrestricted.
- GPT classification sends the bounded latest user prompt to the official Codex backend through the existing ChatGPT login. Jev mode sends the routing prompt to Jev.

Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

This project is licensed under the [MIT License](LICENSE).
