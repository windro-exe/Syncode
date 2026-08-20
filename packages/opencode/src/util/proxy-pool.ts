import { getProxyForUrl } from "./proxy-env"

const STICKY_PROXY_MAX = 256
const STICKY_PROXY_TTL_MS = 24 * 60 * 60 * 1000

const stickyProxies = new Map<string, { index: number; lastUsed: number }>()

function parsePoolFromEnv(): string[] {
  const envPool =
    process.env.SYNCODE_PROXY_POOL ||
    process.env.OPENCODE_PROXY_POOL ||
    process.env.SYNCODE_PROXIES ||
    process.env.OPENCODE_PROXIES ||
    ""
  if (!envPool.trim()) return []
  return envPool
    .split(/[\n,;]/)
    .map((p) => p.trim())
    .filter(Boolean)
}

function evictSticky() {
  if (stickyProxies.size < STICKY_PROXY_MAX) return
  const now = Date.now()
  const stale = [...stickyProxies.entries()].filter(([, entry]) => now - entry.lastUsed > STICKY_PROXY_TTL_MS)
  for (const [sessionID] of stale) stickyProxies.delete(sessionID)
  if (stickyProxies.size >= STICKY_PROXY_MAX) {
    const oldest = [...stickyProxies.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]
    if (oldest) stickyProxies.delete(oldest[0])
  }
}

export function getProxyPool(): string[] {
  return parsePoolFromEnv()
}

export function getRotatingProxy(): string | undefined {
  const rotating =
    process.env.SYNCODE_ROTATING_PROXY ||
    process.env.OPENCODE_ROTATING_PROXY ||
    process.env.SYNCODE_FREE_PROXY ||
    process.env.OPENCODE_FREE_PROXY
  return rotating?.trim() || undefined
}

export function getProxyForSession(sessionID: string, targetUrl?: string): string | undefined {
  const rotating = getRotatingProxy()
  if (rotating) return rotating

  const pool = getProxyPool()
  if (pool.length > 0) {
    const now = Date.now()
    const existing = stickyProxies.get(sessionID)
    if (existing) {
      existing.lastUsed = now
      return pool[existing.index % pool.length]
    }
    const index = Math.floor(Math.random() * pool.length)
    stickyProxies.set(sessionID, { index, lastUsed: now })
    evictSticky()
    return pool[index]
  }

  if (targetUrl) {
    return getProxyForUrl(targetUrl)
  }
  return undefined
}

export function rotateProxy(sessionID: string): boolean {
  const pool = getProxyPool()
  if (pool.length <= 1) return false
  const now = Date.now()
  const existing = stickyProxies.get(sessionID)
  const nextIndex = existing ? existing.index + 1 : Math.floor(Math.random() * pool.length)
  stickyProxies.set(sessionID, { index: nextIndex, lastUsed: now })
  return true
}

export * as ProxyPool from "./proxy-pool"
