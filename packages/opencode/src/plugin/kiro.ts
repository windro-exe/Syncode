import type { Hooks, PluginInput } from "@opencode-ai/plugin"

// Makes "Kiro" appear in `/connect` with an API-key method. The pasted `ksk_`
// key is stored in auth.json (type "api") and injected as options.apiKey by
// resolveSDK, which the vendored Kiro provider (provider/kiro) uses as its
// bearer token. No proxy, no env var, no kiro-cli login required.
export async function KiroAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "kiro",
      methods: [
        {
          type: "api",
          label: "API key",
        },
      ],
    },
  }
}
