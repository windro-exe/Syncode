#!/usr/bin/env bun
import { $ } from "bun"

import { downloadCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../opencode && bun script/build-node.ts`
// wnxd fork: refresh the bundled CLI from the local install for dev and prod so
// the desktop sidecar always runs this fork's build.
if (channel !== "beta") await downloadCliToResources()
