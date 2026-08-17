// Human-feel ranking: BM25 (lexical relevance from FTS5) blended with recency
// decay, a reinforcement signal (how often the memory was genuinely retrieved),
// and importance (rated once at encode, 1-10).
//
//   final = bm25_norm
//         * (1 + RECENCY_WEIGHT   * recency(last_reinforced))
//         * (1 + REINFORCE_WEIGHT * salience(reinforcement))
//         * (1 + IMPORTANCE_WEIGHT * importance/10)
//
// reinforcement replaces the old raw access_count: it is bumped ONLY on a real
// retrieval (a search hit), never on a plain view, so reading can't inflate a
// memory's own rank. All knobs live here so tuning doesn't ripple through callers.

const RECENCY_HALF_LIFE_DAYS = 30
const RECENCY_WEIGHT = 0.6
const REINFORCE_WEIGHT = 0.4
const IMPORTANCE_WEIGHT = 0.5

export interface RankInput {
  bm25: number
  reinforcedAt: number
  reinforcement: number
  importance: number
  now?: number
}

export function recency(reinforcedAt: number, now = Date.now()) {
  const ageDays = Math.max(0, (now - reinforcedAt) / 86_400_000)
  return Math.exp(-Math.LN2 * (ageDays / RECENCY_HALF_LIFE_DAYS))
}

export function salience(reinforcement: number) {
  return Math.log1p(Math.max(0, reinforcement)) / Math.LN2 / 8
}

export function importanceFactor(importance: number) {
  return Math.min(10, Math.max(1, importance || 5)) / 10
}

// FTS5 rank() is negative (lower = better). Map to 0..1 where 1 is best.
export function normalizeBm25(rank: number) {
  if (!Number.isFinite(rank)) return 0
  const positive = -rank
  return positive / (1 + positive)
}

export function score(input: RankInput) {
  const r = recency(input.reinforcedAt, input.now)
  const s = salience(input.reinforcement)
  const imp = importanceFactor(input.importance)
  const b = normalizeBm25(input.bm25)
  return b * (1 + RECENCY_WEIGHT * r) * (1 + REINFORCE_WEIGHT * s) * (1 + IMPORTANCE_WEIGHT * imp)
}
