# dsh-imagegen v0.1

[English](README.md) | [简体中文](README.zh-CN.md)

Image generation for **DeepSeek Harness 0.2.0-rc.2**. Supports Gemini `generateContent` and OpenAI-compatible Images endpoints. Based on [ZhaoJun233/dsh-imagegen](https://github.com/ZhaoJun233/dsh-imagegen).

## Features

- Lock the configured image model by default; no automatic fallback to chat models.
- Wait once for short 429 cooldowns and retry at most once. Return long cooldowns immediately with remaining seconds.
- Cache known cooldowns in memory so immediate repeat calls do not probe the provider.
- Distinguish cooldown, network, timeout, HTTP rejection, cancellation and missing images.
- Instruct the agent to report failures and stop instead of scanning the machine or trying unrelated models.
- Report elapsed time, request count and cooldown wait. Logs omit credentials, URLs, prompts and image data.

## Local install

Desktop, without adding `dsh` to PATH:

```powershell
$dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add "link:C:\path\to\dsh-imagegen"
```

CLI/Web:

```powershell
dsh plugin --profile web add "link:C:\path\to\dsh-imagegen"
```

Restart the corresponding DSH host after installing/updating. Linked Desktop plugins reuse the bundled runtime. Web deployments need the declared DSH peer packages in their package resolution tree. An unusual runtime location can be supplied with `DSH_RUNTIME_DIR`.

## Configure

Open **Plugins → Plugin configuration → Image generation**. Set the API URL, credential and default image model. Credentials are write-only in settings responses; no real keys ship with the repository.

Example for local CPA:

```json
{
  "protocol": "gemini",
  "url": "http://127.0.0.1:8317",
  "apiKeyEnv": "IMAGEGEN_API_KEY",
  "apiKeyHeader": "Authorization",
  "apiKeyPrefix": "Bearer ",
  "defaultModel": "gemini-3.1-flash-image"
}
```

Supply the credential in plugin settings or define `IMAGEGEN_API_KEY` in the environment that starts DSH. The legacy `~/.dsh/dsh-imagegen.json` accepts this connection shape and is the fallback when settings provide no connection or credential. See [examples](examples/) for both protocols.

Gemini base URLs expand to `/v1beta/models/{model}:generateContent`. For `image2`, a base such as `https://example.com/v1` gets `/images/generations` appended.

## Cooldown policy

Advanced fields belong under the `imagegen` entry in the profile's `cordis.patch.yml`:

```yaml
- id: imagegen
  config:
    allowModelOverride: false
    maxRetries: 1
    maxCooldownWaitMs: 60000
    requestTimeoutMs: 90000
    timeoutMs: 180000
```

These are restart-required policy fields, not live settings-page controls. Retry count is limited to 0–2; automatic wait budget to 0–120000 ms. The provider reset gets a one-second margin. A wait is skipped if it exceeds the wait budget or leaves insufficient time for a full request window. Missing reset information uses a 30-second initial backoff. Network errors and timeouts are not automatically resubmitted, to avoid duplicate generations.

Current `Retry-After` / structured reset fields take precedence over messages. A stored `last_upstream_error` countdown is not treated as a live timer. The cache is process-local and cleared on reload. This policy cannot add upstream quota or shorten provider cooldowns.

## Tool

`image_generate` accepts `prompt`, optional `aspect_ratio`, `image_size` (Gemini), `size` / `quality` (image2), and workspace-relative `output_path`. Normally omit `model`; changing models requires user settings, unless `allowModelOverride` is explicitly enabled. Outputs default to `generated-images/`.

| Error tag | Meaning |
| --- | --- |
| `IMAGE_COOLDOWN` | Limit/quota cooldown; includes remaining seconds |
| `IMAGE_MODEL_LOCKED` | Override differs from configured image model |
| `IMAGE_NO_IMAGE` | Valid response but no supported image data |
| `IMAGE_NETWORK` | Image API connection/read failure |
| `IMAGE_TIMEOUT` | Request or overall deadline exceeded |
| `IMAGE_HTTP_ERROR` | Other HTTP rejection with a redacted message |
| `IMAGE_INVALID_RESPONSE` | Invalid JSON from provider |
| `IMAGE_CANCELLED` | User/runtime cancellation |

## Test and package

Node.js 22+. Policy and client tests need no installed npm dependencies and make no real API calls:

```powershell
npm run check
npm test
npm run test:desktop
npm pack
```

Desktop smoke tests use an installed Windows DSH 0.2.0-rc.2 with fixture responses; they do not open/restart the app. Set `DSH_DESKTOP_EXE` for a non-default executable location. GitHub Actions is configured for Node 22/24 on Windows, macOS and Linux; that is not a claim of end-to-end DSH acceptance on every OS.

## Install from GitHub

Repository: [laishaojue-commits/dsh-imagegen](https://github.com/laishaojue-commits/dsh-imagegen).

```powershell
dsh plugin --profile desktop add github:laishaojue-commits/dsh-imagegen
```

Without `dsh` on PATH, use the Desktop CLI path shown in Local install. For Web profiles, replace `desktop` with `web`. Restart DSH after installation. `private: true` blocks accidental npm publishing, not GitHub installation.

Do not include local profiles, credentials or actual API keys.
