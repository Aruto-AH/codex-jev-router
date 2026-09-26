# codex-jev-router

[![CI](https://github.com/tiandee/codex-jev-router/actions/workflows/ci.yml/badge.svg)](https://github.com/tiandee/codex-jev-router/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Route OpenAI Codex CLI turns through Jev. Jev selects a suitable Codex model and reasoning effort for each fresh turn.

The bridge runs locally. It starts a loopback Responses API proxy, sends the routing context to Jev, and forwards the request to Codex. Automatic routing offers only `gpt-6-luna` and `gpt-6-sol`. The native Codex model picker still shows its other models, and an explicit `--model` passes through.

The bridge uses the native `/models` catalog when available. It routes with both allowed models if both are present, or the single allowed model if only one is present. If catalog retrieval fails, a static GPT-6 Luna/Sol catalog is used. If the native catalog succeeds but contains neither allowed model, automatic routing returns `503 routing_unavailable` instead of selecting an unrelated model.

If Jev times out, throws, returns no answer, or selects an unavailable model, an existing conversation keeps its previous model and effort. On the first turn, `jev-router` resolves to `gpt-6-sol` when available, otherwise `gpt-6-luna`; its requested effort is normalized to that model's supported levels. The proxy never forwards `jev-router` upstream.

## Prerequisites

- Node.js 20 or newer
- OpenAI Codex CLI installed and available as `codex` on your `PATH`
- Codex authentication configured
- A Jev or TypeSafe API key

This project is open source under the MIT License. The package is not published to npm; install it from the public GitHub repository with the steps below.

## Install from source

Clone the repository, install its dependencies, and create the global `codex-jev` command:

```bash
git clone https://github.com/tiandee/codex-jev-router.git
cd codex-jev-router
npm install
npm link
codex-jev --version
```

If your GitHub account uses SSH, replace the clone URL with the SSH URL configured for your account.

## Configure the Jev key

Store the key outside the repository. The bridge loads `~/.jev-codex.env` automatically:

```bash
printf '%s\n' 'JEV_API_KEY=your_typesafe_api_key' > ~/.jev-codex.env
chmod 600 ~/.jev-codex.env
```

You can also export `JEV_API_KEY` in the shell that starts Codex. Do not commit the key or place it in a tracked file.

## Run Codex with routing

Change to the project where you want to work, then start Codex through the wrapper:

```bash
cd /path/to/your/project
codex-jev
```

The wrapper forwards normal Codex arguments, including `--model`, `--sandbox`, and `--dangerously-bypass-approvals-and-sandbox`.

Without a Jev key, the wrapper still starts Codex and prints a fallback notice. Add the key when you want automatic routing.

### Observe recommendations with Shadow Mode

In PowerShell, enable Shadow Mode for the current session:

```powershell
$env:JEV_CODEX_SHADOW="1"
codex-jev
```

Jev still recommends a GPT-6 Luna/Sol model and reasoning effort, but the request sent to Codex keeps its original model and effort. The wrapper lets Codex select its own model unless you pass an explicit `--model`. Shadow Mode rejects `--model jev-router` because that virtual model cannot be forwarded unchanged. To turn Shadow Mode off:

```powershell
Remove-Item Env:JEV_CODEX_SHADOW
```

For each fresh turn, the bridge adds a Codex commentary item with the selected model and reasoning effort. Codex renders this item with the same layout and colors as the rest of the conversation:

```text
🔹 [Jev] routed this turn to gpt-6-sol (max reasoning, confidence 0.95).
```

## Reasoning-effort policy

Automatic effort selection is enabled by default. The bridge maps Jev's `reasoning_required` score as follows:

```text
reasoning_required < 0.30  -> low
reasoning_required < 0.60  -> medium
reasoning_required < 0.85  -> high
otherwise                   -> max
```

Set `JEV_CODEX_AUTO_EFFORT=0` to preserve the effort selected in Codex.

The selected model's advertised capabilities take precedence. If a model does not support the requested effort, the bridge chooses the strongest supported lower level.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `JEV_API_KEY` | unset | Enables Jev routing |
| `JEV_BASE_URL` | TypeSafe default | Overrides the Jev API endpoint |
| `JEV_CODEX_AUTO_EFFORT` | `1` | Derives reasoning effort from Jev's score |
| `JEV_CODEX_SHADOW` | unset | Set to `1` to observe recommendations without changing the actual model or effort |
| `JEV_CODEX_API_BASE_URL` | OpenAI API default | Overrides the OpenAI Responses endpoint |
| `JEV_CODEX_CHATGPT_BASE_URL` | ChatGPT Codex default | Overrides the ChatGPT Codex endpoint |
| `JEV_CODEX_DEBUG` | unset | Logs route metadata without prompts or keys when set to `1` |

## Troubleshooting

### `codex-jev: command not found`

Run `npm link` from the cloned repository. If the command remains unavailable, add the npm global bin directory to your `PATH`:

```bash
npm prefix -g
```

On macOS with Homebrew, the directory is commonly `/opt/homebrew/bin`.

### Codex is not installed or is not on `PATH`

Run `codex --version` first. Install and authenticate the OpenAI Codex CLI, then run `codex-jev` again.

### Codex starts without routing

Check that the key file exists and has the expected variable:

```bash
ls -l ~/.jev-codex.env
grep -q '^JEV_API_KEY=' ~/.jev-codex.env && echo 'JEV_API_KEY is configured'
```

The bridge keeps the prior route when Jev cannot be reached. For a first turn, it selects an available GPT-6 candidate as described above.

## Development

Run the local checks from the repository root:

```bash
npm test
npm run smoke
npm audit --omit=dev
```

The tests use a fake Jev decision boundary and a local fake upstream. They do not require an API key.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, required checks, and pull request expectations.

## Security notes

- Keep TypeSafe and Codex credentials outside the repository.
- The proxy binds to `127.0.0.1` and does not log prompts or authorization headers.
- Full-access Codex mode remains unrestricted. The bridge does not make it safer.
- Jev receives the text needed to make the routing decision. Do not route sensitive prompts through Jev unless that data flow is acceptable.

To report a vulnerability privately, see [SECURITY.md](SECURITY.md).

## License

This project is licensed under the [MIT License](LICENSE).
