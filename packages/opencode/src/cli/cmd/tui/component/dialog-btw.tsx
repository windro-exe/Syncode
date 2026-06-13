import { TextAttributes } from "@opentui/core"
import { createSignal, onMount, Show } from "solid-js"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { useTheme } from "../context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { Spinner } from "./spinner"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tui.btw" })

// `/btw`: a quick side question answered concurrently and tool-lessly, using the
// session context but WITHOUT touching the conversation. The input dialog hands
// off (via dialog.replace) to a fresh answer dialog so the answer box is the
// direct dialog content — rendering like any other dialog (e.g. DialogStatus).
export function DialogBtw(props: { sessionID: string }) {
  const dialog = useDialog()

  return (
    <DialogPrompt
      title="btw — quick side question"
      placeholder="ask a quick side question (answered without interrupting the task)…"
      onConfirm={(value) => {
        const q = value.trim()
        if (!q) return dialog.clear()
        dialog.replace(() => <DialogBtwAnswer sessionID={props.sessionID} question={q} />)
      }}
      onCancel={() => dialog.clear()}
    />
  )
}

function DialogBtwAnswer(props: { sessionID: string; question: string }) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const { theme } = useTheme()

  const [pending, setPending] = createSignal(true)
  const [answer, setAnswer] = createSignal<string>()
  const [errored, setErrored] = createSignal(false)

  onMount(() => {
    const msgs = sync.data.message[props.sessionID] ?? []
    const last = msgs.findLast((m): m is AssistantMessage => m.role === "assistant")
    if (!last) {
      setPending(false)
      setErrored(true)
      return
    }
    void (async () => {
      const res = await sdk.client.session
        .btw({
          sessionID: props.sessionID,
          question: props.question,
          providerID: last.providerID,
          modelID: last.modelID,
        })
        .catch(() => undefined)
      setPending(false)
      log.info("btw.client.recv", {
        hasRes: !!res,
        hasData: !!(res && res.data),
        textLen: res?.data?.text?.length ?? -1,
        err: res?.error ? "yes" : "no",
      })
      const text = res?.data?.text?.trim()
      if (text) setAnswer(text)
      else setErrored(true)
    })()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          btw
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word">
        {props.question}
      </text>
      <Show when={pending()}>
        <Spinner color={theme.textMuted}>thinking…</Spinner>
      </Show>
      <Show when={answer()}>
        {(text) => (
          <text fg={theme.text} wrapMode="word">
            {text()}
          </text>
        )}
      </Show>
      <Show when={errored()}>
        <text fg={theme.error}>Couldn't answer that one — try again in a moment.</text>
      </Show>
    </box>
  )
}
