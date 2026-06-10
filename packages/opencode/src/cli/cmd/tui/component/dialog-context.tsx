import { TextAttributes } from "@opentui/core"
import { createMemo, For, Show } from "solid-js"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { useTheme } from "../context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"

// Thresholds mirror the server (src/session/overflow.ts + src/session/compaction.ts).
// Kept by hand: the TUI bundle deliberately doesn't import the server compaction
// module. If these change there, change them here.
const OUTPUT_MAX = 32_000
const COMPACTION_BUFFER = 20_000
const SOFT_CHECKPOINT_FRACTION = 0.6
const PRUNE_TURN_TRIGGER_FRACTION = 0.8

const fmt = (n: number) => Math.round(n).toLocaleString("en-US")

// A real, client-side `/context`: computes the window breakdown purely from
// already-synced state — NO model round-trip. The per-category split is a cheap
// char/4 estimate calibrated so the buckets sum to the provider's real total
// (the provider figure is exact; the split is proportional).
export function DialogContext(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()

  const stats = createMemo(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    const last = messages.findLast((m): m is AssistantMessage => m.role === "assistant" && m.tokens.output > 0)
    if (!last) return undefined

    const model = sync.data.provider.find((p) => p.id === last.providerID)?.models[last.modelID]
    const limit = model?.limit.context ?? 0
    const realTotal =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write

    // usable budget — mirrors overflow.ts:usable()
    const out = Math.min(model?.limit.output || OUTPUT_MAX, OUTPUT_MAX) || OUTPUT_MAX
    const reserved = Math.max(COMPACTION_BUFFER, out)
    const usable = model?.limit.input ? Math.max(0, model.limit.input - reserved) : Math.max(0, limit - out)

    // Category estimate (char/4) over conversation text vs completed tool output.
    let textChars = 0
    let toolChars = 0
    for (const m of messages) {
      for (const part of sync.data.part[m.id] ?? []) {
        if ((part.type === "text" || part.type === "reasoning") && part.text) textChars += part.text.length
        else if (part.type === "tool" && part.state.status === "completed" && part.state.output)
          toolChars += part.state.output.length
      }
    }
    const textEst = textChars / 4
    const toolEst = toolChars / 4
    const estTotal = textEst + toolEst
    // Calibrate: scale the estimate down to the real total if it overshoots, then
    // attribute any remainder to system + tool-schema overhead (not in messages).
    const scale = estTotal > realTotal && estTotal > 0 ? realTotal / estTotal : 1
    const text = textEst * scale
    const tool = toolEst * scale
    const overhead = Math.max(0, realTotal - text - tool)

    const softAt = usable * SOFT_CHECKPOINT_FRACTION
    const evictAt = usable * PRUNE_TURN_TRIGGER_FRACTION
    const turnCount = messages.filter((m) => m.role === "user").length || 1
    const avgTurn = realTotal / turnCount
    const turnsLeft = avgTurn > 0 ? Math.max(0, Math.floor((evictAt - realTotal) / avgTurn)) : 0

    return {
      model: last.modelID,
      limit,
      realTotal,
      usable,
      pct: limit ? Math.round((realTotal / limit) * 100) : 0,
      softAt,
      evictAt,
      softReached: realTotal >= softAt,
      evictReached: realTotal >= evictAt,
      turnsLeft,
      rows: [
        { label: "conversation text", value: text },
        { label: "tool output", value: tool },
        { label: "system + tools (est)", value: overhead },
      ],
      lastInput: last.tokens.input,
      cacheRead: last.tokens.cache.read,
      lastOutput: last.tokens.output,
      cost: sync.session.get(props.sessionID)?.cost ?? 0,
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Context
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show
        when={stats()}
        fallback={<text fg={theme.textMuted}>No usage yet — send a message first.</text>}
      >
        {(s) => (
          <box gap={1}>
            <text fg={theme.text}>
              <b>{s().model}</b>{" "}
              <span style={{ fg: theme.textMuted }}>
                {fmt(s().realTotal)} / {fmt(s().limit)} ({s().pct}%)
              </span>
            </text>

            <box>
              <text fg={theme.textMuted}>usable budget: {fmt(s().usable)}</text>
              <text fg={s().softReached ? theme.warning : theme.textMuted}>
                soft checkpoint {fmt(s().softAt)} (60%) — {s().softReached ? "reached" : "ok"}
              </text>
              <text fg={s().evictReached ? theme.error : theme.textMuted}>
                eviction trigger {fmt(s().evictAt)} (80%) — {s().evictReached ? "evicting" : `ok · ~${s().turnsLeft} turns left`}
              </text>
            </box>

            <box>
              <text fg={theme.text}>breakdown (calibrated to provider total):</text>
              <For each={s().rows}>
                {(row) => (
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme.textMuted}>{row.label}</text>
                    <text fg={theme.text}>
                      {fmt(row.value)} ({s().realTotal ? Math.round((row.value / s().realTotal) * 100) : 0}%)
                    </text>
                  </box>
                )}
              </For>
            </box>

            <text fg={theme.textMuted}>
              last request (real): in {fmt(s().lastInput)} · cache {fmt(s().cacheRead)} · out {fmt(s().lastOutput)}
              {s().cost > 0 ? ` · $${s().cost.toFixed(4)}` : ""}
            </text>
          </box>
        )}
      </Show>
    </box>
  )
}
