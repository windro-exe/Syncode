// Human-feel ranking: BM25 (lexical relevance from FTS5) blended with
// recency decay and access-frequency salience.
//
// final = bm25_norm * (1 + RECENCY_WEIGHT * recency) * (1 + ACCESS_WEIGHT * salience)
//
// We keep all knobs here so future tuning doesn't ripple through callers.

const RECENCY_HALF_LIFE_DAYS = 30
const RECENCY_WEIGHT = 0.6
const ACCESS_WEIGHT = 0.4

export interface RankInput {
  bm25: number
  accessedAt: number
  accessCount: number
  now?: number
}

export function recency(accessedAt: number, now = Date.now()) {
  const ageDays = Math.max(0, (now - accessedAt) / 86_400_000)
  return Math.exp(-Math.LN2 * (ageDays / RECENCY_HALF_LIFE_DAYS))
}

export function salience(accessCount: number) {
  return Math.log1p(Math.max(0, accessCount)) / Math.LN2 / 8
}

// FTS5 rank() is negative (lower = better). Map to 0..1 where 1 is best.
export function normalizeBm25(rank: number) {
  if (!Number.isFinite(rank)) return 0
  const positive = -rank
  return positive / (1 + positive)
}

export function score(input: RankInput) {
  const r = recency(input.accessedAt, input.now)
  const s = salience(input.accessCount)
  const b = normalizeBm25(input.bm25)
  return b * (1 + RECENCY_WEIGHT * r) * (1 + ACCESS_WEIGHT * s)
}
