type Channel = "dev" | "beta" | "prod"
const raw = (process.env.OPENCODE_CHANNEL as string) ?? (import.meta.env.OPENCODE_CHANNEL as string)
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "prod"

// wnxd fork: the in-app updater now points at this fork's GitHub releases
// (windro-exe/Syncode, publish feed in electron-builder.config.ts) instead of
// upstream anomalyco. Prod builds update from fork releases; dev/beta installs
// stay manual so a dev checkout never gets clobbered by a release build.
export const UPDATER_ENABLED = CHANNEL === "prod"
