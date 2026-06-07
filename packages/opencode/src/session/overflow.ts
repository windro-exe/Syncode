import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: Config.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  // The reserved buffer must be AT LEAST as big as the model's actual max output,
  // or a post-prune request that asks for `max_tokens = maxOutputTokens` lands
  // at `kept_tail + new_user + system + maxOutput > input_limit` and the API
  // rejects with "prompt is too long". The previous Math.min capped reserved
  // BELOW maxOutput (e.g. min(20K, 64K) = 20K with extended thinking), which is
  // the wrong direction.
  const reserved =
    input.cfg.compaction?.reserved ??
    Math.max(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

export function isOverflow(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  // The provider-reported `total` can omit cache and reasoning (e.g. Anthropic's
  // shared.totalTokens fallback only sums input+output). The `||` short-circuit
  // would then prefer that under-count over our own better sum below, so use ??
  // to fall back ONLY when total is genuinely absent. And include reasoning —
  // Claude Opus with effort:max regularly emits 16-32K reasoning tokens that
  // the previous fallback ignored, silently delaying eviction.
  const t = input.tokens
  const count = t.total ?? t.input + t.output + (t.reasoning ?? 0) + t.cache.read + t.cache.write
  return count >= usable(input)
}

// Soft-checkpoint threshold. Research (Zylos/Anthropic) puts measurable model
// quality degradation at 60-70% context fill — earlier than the 80% point
// where whole-turn eviction (PRUNE_TURN_TRIGGER_FRACTION) actually runs. We use
// this lower mark to nudge the model to persist durable facts to memory BEFORE
// older turns get evicted, since eviction is otherwise unrecoverable mid-turn.
export const SOFT_CHECKPOINT_FRACTION = 0.6

export function isSoftCheckpoint(input: {
  cfg: Config.Info
  projected: number
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.model.limit.context === 0) return false
  const budget = usable(input)
  if (budget <= 0) return false
  return input.projected >= budget * SOFT_CHECKPOINT_FRACTION
}
