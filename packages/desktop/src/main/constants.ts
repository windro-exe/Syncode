type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// wnxd fork: HARD-DISABLED on every channel. The in-app updater pulls upstream
// anomalyco releases and would wipe all local fork features. Updates here are
// manual rebuilds only. (Upstream gates this on `app.isPackaged && CHANNEL !== "dev"`.)
export const UPDATER_ENABLED = false
