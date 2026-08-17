# zcode-proxy

Local OpenAI-compatible proxy for the **Z.AI / BigModel GLM Coding Plan** (GLM-5.3 etc).
Speaks OpenAI `chat/completions` to clients, translates to Anthropic `v1/messages` upstream.

Zero dependencies — plain Node (22+). Built 2026-08-16; upstream details verified against
the public `lkonga/zcode-api-public` proxy and ZCode's own bundle/docs.

## Setup

1. Get a coding-plan API key: Z.ai platform (z.ai → API Keys; coding-plan eligible account)
   or BigModel (bigmodel.cn). Z.AI account-based (OAuth) mode is not supported yet.
2. Put the key in `%USERPROFILE%\.config\zcode-proxy\key` (no trailing newline worries)
   **or** set `ZCODE_API_KEY` env. Key is read at startup.
3. Run: `.\start.ps1` (or `node proxy.mjs`). Defaults: port 8788, provider zai.

```
GET  /healthz             status + resolved upstream
GET  /v1/models           model list (glm-5.3, glm-5.2, glm-5-turbo, glm-5.1, glm-5, ...)
POST /v1/chat/completions OpenAI format, streaming + non-streaming, tools, images
```

Client auth: optional — set `ZCODE_PROXY_TOKEN` and clients must send
`Authorization: Bearer <token>`.

## Env knobs

| Var | Default | Meaning |
|---|---|---|
| `ZCODE_API_KEY` | keyfile `~/.config/zcode-proxy/key` | upstream key |
| `ZCODE_PROVIDER` | `zai` | `zai` → `https://api.z.ai/api/anthropic`, `bigmodel` → `https://open.bigmodel.cn/api/anthropic` |
| `ZCODE_ANTHROPIC_BASE` | provider default | override upstream base (e.g. `https://api.z.ai/api/zcode-plan/anthropic`) |
| `ZCODE_PROXY_PORT` / `ZCODE_PROXY_HOST` | `8788` / `127.0.0.1` | listen addr |
| `ZCODE_PROXY_TOKEN` | — | require as client Bearer |
| `ZCODE_DEFAULT_MODEL` | `glm-5.3` | injected when request omits `model` |

## Wire into Syncode / opencode

Add a custom provider to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "zcode": {
      "options": {
        "baseURL": "http://127.0.0.1:8788/v1",
        "apiKey": "zcode-local"
      }
    }
  }
}
```

Then: `opencode -m zcode/glm-5.3`. If reasoning text should show separately, set
`"compatibility": { "reasoningField": "reasoning_content" }` on the provider.

## Wire into Hermes (when the project resumes)

Custom endpoint in `config.yaml`:

```yaml
providers:
  zc:
    name: ZCode Proxy
    base_url: http://127.0.0.1:8788/v1
    model: glm-5.3
    discover_models: true
```

Then `model.provider: zc` / pick `glm-5.3` in the model picker. (Hermes zai 429
insufficient-balance problem disappears — this rides the coding-plan subscription.)

## Notes / limits

- Reasoning (thinking) arrives as `delta.reasoning_content` in streams and
  `message.reasoning_content` in batches.
- Anthropic prompt-caching `cache_control` is not injected; fine for now.
- Upstream timeout 10 min; GLM-5.3 can think long.
- The coding endpoint (`/api/coding/paas/v4`) is for coding scenarios only — this proxy
  uses the coding-plan **Anthropic** route, same plan billing. Don't use general
  `/api/paas/v4` for subscription quota.