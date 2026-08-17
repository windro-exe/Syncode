// `/btw` ephemeral asides. A user message whose first text starts with this
// marker is answered normally, then the question and its answer are stamped
// `pruned` so they drop out of future context (recoverable via session_recall).
// The TUI `/btw` command pre-fills this marker; users can also type it.
export const BTW_PREFIX = "btw:"

export function isEphemeralAside(text: string): boolean {
  return text.trim().toLowerCase().startsWith(BTW_PREFIX)
}

export * as Ephemeral from "./ephemeral"
