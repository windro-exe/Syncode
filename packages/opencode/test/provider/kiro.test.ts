import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { unlink } from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { Env } from "../../src/env"
import { Provider } from "@/provider/provider"
import { ProviderID } from "../../src/provider/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Provider.defaultLayer, Env.defaultLayer))

const originalEnv = new Map<string, string | undefined>()

const set = (k: string, v: string) =>
  Effect.gen(function* () {
    if (!originalEnv.has(k)) originalEnv.set(k, process.env[k])
    process.env[k] = v
    yield* Env.use.set(k, v)
  })

afterEach(async () => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
  await disposeAllInstances()
})

const list = Provider.use.list()

const withAuthJson = (contents: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const authPath = path.join(Global.Path.data, "auth.json")
      let original: string | undefined
      try {
        original = await Filesystem.readText(authPath)
      } catch {
        original = undefined
      }
      await Filesystem.write(authPath, contents)
      return { authPath, original }
    }),
    ({ authPath, original }) =>
      Effect.promise(async () => {
        if (original !== undefined) {
          await Filesystem.write(authPath, original)
          return
        }
        await unlink(authPath).catch(() => undefined)
      }),
  )

it.instance("Kiro: autoloads from KIRO_API_KEY env and exposes built-in models", () =>
  Effect.gen(function* () {
    yield* set("KIRO_API_KEY", "ksk_test_key")
    const providers = yield* list
    const kiro = providers[ProviderID.make("kiro")]
    expect(kiro).toBeDefined()
    expect(kiro.models["claude-opus-4.8"]).toBeDefined()
    expect(kiro.models["claude-sonnet-4.6"]).toBeDefined()
    // Built-in catalog routes through the vendored SDK (npm key "kiro").
    expect(kiro.models["claude-opus-4.8"].api.npm).toBe("kiro")
  }),
)

it.instance("Kiro: autoloads from auth.json api key (the /connect path)", () =>
  Effect.gen(function* () {
    yield* withAuthJson(JSON.stringify({ kiro: { type: "api", key: "ksk_test_key" } }))
    const providers = yield* list
    const kiro = providers[ProviderID.make("kiro")]
    expect(kiro).toBeDefined()
    expect(kiro.source).toBe("api")
  }),
)

it.instance("Kiro: opus-4.8 gets the full adaptive effort variant set", () =>
  Effect.gen(function* () {
    yield* set("KIRO_API_KEY", "ksk_test_key")
    const providers = yield* list
    const kiro = providers[ProviderID.make("kiro")]
    const variants = kiro.models["claude-opus-4.8"].variants ?? {}
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(variants[effort]).toBeDefined()
      // effort lands under providerOptions.kiro.effort (keyed via sdkKey "kiro").
      expect(variants[effort]).toEqual({ effort })
    }
  }),
)

it.instance("Kiro: sonnet-4.6 gets the four-level effort set (no xhigh)", () =>
  Effect.gen(function* () {
    yield* set("KIRO_API_KEY", "ksk_test_key")
    const providers = yield* list
    const kiro = providers[ProviderID.make("kiro")]
    const variants = kiro.models["claude-sonnet-4.6"].variants ?? {}
    expect(Object.keys(variants).sort()).toEqual(["high", "low", "max", "medium"])
    expect(variants["xhigh"]).toBeUndefined()
  }),
)

it.instance(
  "Kiro: built-in is authoritative — a same-id config block cannot redirect it to a proxy",
  () =>
    Effect.gen(function* () {
      yield* set("KIRO_API_KEY", "ksk_test_key")
      const providers = yield* list
      const kiro = providers[ProviderID.make("kiro")]
      expect(kiro).toBeDefined()
      // The config block tries to make kiro the anthropic SDK at a localhost proxy;
      // the built-in must win so the request goes direct to AWS Q.
      expect(kiro.models["claude-opus-4.8"].api.npm).toBe("kiro")
      expect(kiro.options?.baseURL).toBeUndefined()
    }),
  {
    config: {
      provider: {
        kiro: { npm: "@ai-sdk/anthropic", options: { baseURL: "http://localhost:3456/v1", apiKey: "any" } },
      },
    },
  },
)

