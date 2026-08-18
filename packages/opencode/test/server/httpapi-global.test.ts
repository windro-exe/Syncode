import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"
import path from "path"
import os from "os"

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

describe("global HttpApi", () => {
  it.live("upgrades to latest when the request body is omitted", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.post(GlobalPaths.upgrade)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ success: true, version: "9.9.9" })
    }),
  )

  it.live("rejects malformed upgrade payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text("{", "application/json")),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({ success: false, error: "Invalid request body" })
    }),
  )

  it.live("lists global operational rules", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(GlobalPaths.rules)

      expect(response.status).toBe(200)
      expect(Array.isArray(yield* response.json)).toBe(true)
    }),
  )

  it.live("adds a rule to the global rules.md", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.make("POST")(GlobalPaths.rules).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ rule: "always verify before claiming done" })),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      const list = yield* response.json
      expect(Array.isArray(list)).toBe(true)
      expect((list as { rule: string }[]).some((item) => item.rule === "always verify before claiming done")).toBe(true)

      // Clean up: never leave test rules in the real global rules.md.
      const rulesPath = path.join(os.homedir(), ".syncode", "rules", "rules.md")
      const text = yield* Effect.promise(() => Bun.file(rulesPath).text())
      const cleaned = text
        .split("\n")
        .filter((line) => !line.includes("always verify before claiming done"))
        .join("\n")
      yield* Effect.promise(() => Bun.write(rulesPath, cleaned))
    }),
  )

  it.live("deletes a rule from its rule file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "global.md")
      yield* Effect.promise(() => Bun.write(filePath, "- keep this rule forever\n- remove this one now\n"))
      yield* Effect.promise(() => Bun.write(path.join(dir, "keep.md"), "- keep me\n"))

      const response = yield* HttpClientRequest.make("DELETE")(GlobalPaths.rules).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ rule: "remove this one now", filePath })),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe(true)
      const text = yield* Effect.promise(() => Bun.file(filePath).text())
      expect(text).toContain("keep this rule forever")
      expect(text).not.toContain("remove this one now")
    }),
  )
})
