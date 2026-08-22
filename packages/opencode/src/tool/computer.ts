import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./computer.txt"
import { readFile, unlink } from "node:fs/promises"
import * as Process from "@/util/process"

// Windows-only computer-use tool. Every action spawns a short-lived
// powershell.exe that does the real work: .NET/System.Drawing for screen
// capture, user32 SendInput for mouse/keyboard, UI Automation (UIA) for the
// observe/element-ref path. No native dependencies — this machine has no MSVC,
// so anything node-gyp based is out.

export const Parameters = Schema.Struct({
  action: Schema.Literals([
    "screenshot",
    "observe",
    "click",
    "double_click",
    "right_click",
    "type",
    "key",
    "scroll",
    "move",
    "drag",
    "window",
  ]).annotate({ description: "The action to perform." }),
  ref: Schema.optional(
    Schema.Number.annotate({
      description: "Element id (#N) from your last observe result. Preferred over x/y for click actions.",
    }),
  ),
  x: Schema.optional(Schema.Number.annotate({ description: "X in the most recent screenshot's pixel space." })),
  y: Schema.optional(Schema.Number.annotate({ description: "Y in the most recent screenshot's pixel space." })),
  to_x: Schema.optional(Schema.Number.annotate({ description: "Drag end X (drag only)." })),
  to_y: Schema.optional(Schema.Number.annotate({ description: "Drag end Y (drag only)." })),
  text: Schema.optional(
    Schema.String.annotate({
      description:
        "Text for type; key combo or space-separated sequence for key (e.g. 'ctrl+shift+s', 'down down enter'); title substring for window.",
    }),
  ),
  direction: Schema.optional(
    Schema.Literals(["up", "down", "left", "right"]).annotate({ description: "Scroll direction (default down)." }),
  ),
  amount: Schema.optional(Schema.Number.annotate({ description: "Wheel clicks for scroll (default 3)." })),
})

type Metadata = {
  action: string
  target?: string
}

type Mark = { id: number; role: string; name: string; px: number; py: number; w: number; h: number }
type Viewport = { vx: number; vy: number; vw: number; vh: number; ow: number; oh: number }
type State = { view?: Viewport; marks: Map<number, Mark> }

// Per-session cache of the last screenshot's geometry and observe marks. Keyed
// by sessionID so concurrent sessions don't click each other's targets.
const states = new Map<string, State>()

const stateFor = (sessionID: string): State => {
  const existing = states.get(sessionID)
  if (existing) return existing
  const fresh: State = { marks: new Map() }
  states.set(sessionID, fresh)
  return fresh
}

// ---- key/text parsing ------------------------------------------------------

type Op =
  | { k: "kd"; vk: number }
  | { k: "ku"; vk: number }
  | { k: "ch"; u: number }
  | { k: "mv"; x: number; y: number }
  | { k: "dn"; b: number }
  | { k: "up"; b: number }
  | { k: "wh"; d: number }
  | { k: "hw"; d: number }

const VK: Record<string, number> = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, shift: 0x10, ctrl: 0x11, control: 0x11,
  alt: 0x12, pause: 0x13, capslock: 0x14, esc: 0x1b, escape: 0x1b, space: 0x20, pageup: 0x21,
  pgup: 0x21, pagedown: 0x22, pgdn: 0x22, end: 0x23, home: 0x24, left: 0x25, up: 0x26, right: 0x27,
  down: 0x28, insert: 0x2d, delete: 0x2e, del: 0x2e, win: 0x5b, meta: 0x5b, windows: 0x5b,
  apps: 0x5d, menu: 0x5d, printscreen: 0x2c, multiply: 0x6a, add: 0x6b, subtract: 0x6d,
  decimal: 0x6e, divide: 0x6f,
}
for (let i = 1; i <= 24; i++) VK[`f${i}`] = 0x6f + i
for (let i = 0; i <= 9; i++) VK[String(i)] = 0x30 + i
for (let i = 0; i < 26; i++) VK[String.fromCharCode(97 + i)] = 0x41 + i

function parseKeys(text: string): Op[] {
  const tokens = text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) throw new Error("key action needs text like 'ctrl+s' or 'down down enter'")
  const ops: Op[] = []
  for (const token of tokens) {
    const parts = token.split("+").map((p) => p.trim()).filter(Boolean)
    const vks: number[] = []
    for (const part of parts) {
      const vk = VK[part] ?? (part.length === 1 ? part.toUpperCase().charCodeAt(0) : undefined)
      if (!vk) throw new Error(`unknown key name '${part}' — use named keys (enter, tab, f1...) or modifier combos`)
      vks.push(vk)
    }
    for (let i = 0; i < vks.length - 1; i++) ops.push({ k: "kd", vk: vks[i] })
    ops.push({ k: "kd", vk: vks[vks.length - 1] }, { k: "ku", vk: vks[vks.length - 1] })
    for (let i = vks.length - 2; i >= 0; i--) ops.push({ k: "ku", vk: vks[i] })
  }
  return ops
}

function parseText(text: string): Op[] {
  const ops: Op[] = []
  for (const ch of text) {
    if (ch === "\n" || ch === "\r") {
      ops.push({ k: "kd", vk: VK.enter }, { k: "ku", vk: VK.enter })
      continue
    }
    const u = ch.codePointAt(0)
    if (u !== undefined) ops.push({ k: "ch", u })
  }
  return ops
}

// ---- PowerShell interop ----------------------------------------------------

const payloadB64 = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64")

async function runPS(script: string): Promise<any> {
  const encoded = Buffer.from(script, "utf16le").toString("base64")
  const out = await Process.run(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { nothrow: true },
  )
  const stdout = out.stdout.toString()
  const err = out.stderr.toString()
  if (out.code !== 0) throw new Error(`computer backend failed (${out.code}): ${err.trim().slice(-1500)}`)
  const line = stdout.split("\n").filter((l) => l.trimStart().startsWith("{")).pop()
  if (!line) throw new Error(`computer backend produced no JSON output${err ? `: ${err.trim().slice(-500)}` : ""}`)
  try {
    return JSON.parse(line)
  } catch {
    // -Compress output is a single line, but stray stdout can precede it; retry from the first brace
    const start = stdout.indexOf("{")
    return JSON.parse(stdout.slice(start))
  }
}

// Shared C# helpers compiled once per spawn.
const CS_HELPERS = String.raw`
using System;
using System.Runtime.InteropServices;
public static class DpiFix {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
`

const PS_HEAD = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
${CS_HELPERS}
"@
[void][DpiFix]::SetProcessDPIAware()
`

// Captures the virtual screen, downscales it, optionally draws Set-of-Marks
// boxes from $marks, saves a temp PNG and prints geometry as JSON.
// Requires: $marks variable defined beforehand (may be an empty array).
const PS_CAPTURE = String.raw`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.X, $vs.Y, 0, 0, (New-Object System.Drawing.Size($vs.Width, $vs.Height)))
$g.Dispose()
$ratio = [Math]::Min(1.0, 1280 / [double]$vs.Width)
$outW = [Math]::Max(1, [int][Math]::Round($vs.Width * $ratio))
$outH = [Math]::Max(1, [int][Math]::Round($vs.Height * $ratio))
$small = New-Object System.Drawing.Bitmap($outW, $outH)
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $outW, $outH)
$g2.Dispose()
$bmp.Dispose()
if ($marks.Count -gt 0) {
  $font = New-Object System.Drawing.Font("Arial", 14, [System.Drawing.FontStyle]::Bold)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Red, 2)
  $g3 = [System.Drawing.Graphics]::FromImage($small)
  foreach ($m in $marks) {
    $sx = ($m.x - $vs.X) * $ratio
    $sy = ($m.y - $vs.Y) * $ratio
    $g3.DrawRectangle($pen, [float]$sx, [float]$sy, [float]($m.w * $ratio), [float]($m.h * $ratio))
    $label = "" + $m.id
    $sz = $g3.MeasureString($label, $font)
    $boxY = [Math]::Max(0.0, $sy - $sz.Height)
    $g3.FillRectangle([System.Drawing.Brushes]::Red, [float]$sx, [float]$boxY, ($sz.Width + 4), $sz.Height)
    $g3.DrawString($label, $font, [System.Drawing.Brushes]::White, ([float]($sx + 2)), ([float]$boxY))
  }
  $g3.Dispose(); $pen.Dispose(); $font.Dispose()
}
$file = Join-Path $env:TEMP ("syncode-computer-" + [guid]::NewGuid().ToString("N") + ".png")
$small.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$small.Dispose()
`

function captureScript(): string {
  return (
    PS_HEAD +
    `$marks = @()\n` +
    PS_CAPTURE +
    String.raw`
@{ file = $file; vx = $vs.X; vy = $vs.Y; vw = $vs.Width; vh = $vs.Height; ow = $outW; oh = $outH } | ConvertTo-Json -Compress
`
  )
}

function observeScript(): string {
  return (
    PS_HEAD +
    String.raw`
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes

function Walk-Tree($startEl) {
  $interesting = @("Button","CheckBox","ComboBox","Edit","Hyperlink","ListItem","MenuItem","TabItem","TreeItem","RadioButton","Slider","Spinner","Document","DataItem","Calendar","Header","HeaderItem","List","Menu","Tab","Table","Tree")
  $found = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@{ el = $startEl; d = 0 })
  $visited = 0
  $nextId = 1
  while ($queue.Count -gt 0 -and $visited -lt 600 -and $nextId -le 120) {
    $item = $queue.Dequeue()
    $el = $item.el
    $depth = $item.d
    $visited++
    try {
      $c = $el.Current
      $pn = $c.ControlType.ProgrammaticName
      if ($pn) {
        $tn = $pn.Replace("ControlType.", "")
        $ok = $interesting -contains $tn
        if (-not $ok) {
          $ok = $c.IsInvokePatternAvailable -or $c.IsTogglePatternAvailable -or $c.IsExpandCollapsePatternAvailable -or $c.IsValuePatternAvailable -or $c.IsSelectionItemPatternAvailable -or $c.IsRangeValuePatternAvailable
        }
        if ($ok) {
          $r = $c.BoundingRectangle
          if ($r.Width -gt 0 -and $r.Height -gt 0 -and $r.X -gt -50000 -and $r.Y -gt -50000) {
            $nm = $c.Name
            if (-not $nm) { $nm = "" }
            if ($nm.Length -gt 60) { $nm = $nm.Substring(0, 57) + "..." }
            [void]$found.Add(@{
              id = $nextId
              role = $tn
              name = $nm
              x = [int]$r.X
              y = [int]$r.Y
              w = [int]$r.Width
              h = [int]$r.Height
            })
            $nextId++
          }
        }
      }
    } catch {}
    if ($depth -lt 7) {
      try {
        $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($k in $kids) { $queue.Enqueue(@{ el = $k; d = $depth + 1 }) }
      } catch {}
    }
  }
  return ,$found
}

$hwnd = [DpiFix]::GetForegroundWindow()
$startEl = $null
$winTitle = ""
if ($hwnd -ne [IntPtr]::Zero) {
  try { $startEl = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd) } catch {}
  $sb = New-Object System.Text.StringBuilder 512
  [void][DpiFix]::GetWindowText($hwnd, $sb, 512)
  $winTitle = $sb.ToString()
}
if (-not $startEl) { $startEl = [System.Windows.Automation.AutomationElement]::RootElement }

$elements = Walk-Tree $startEl
# Chromium/Electron build their UIA tree lazily on first query; retry once.
if ($elements.Count -lt 3) {
  Start-Sleep -Milliseconds 700
  $elements = Walk-Tree $startEl
}

$marks = @($elements | ForEach-Object { @{ id = $_.id; x = $_.x; y = $_.y; w = $_.w; h = $_.h } })
` +
    PS_CAPTURE +
    String.raw`
@{ file = $file; vx = $vs.X; vy = $vs.Y; vw = $vs.Width; vh = $vs.Height; ow = $outW; oh = $outH; elements = $elements; window = $winTitle } | ConvertTo-Json -Compress -Depth 4
`
  )
}

function inputScript(ops: Op[]): string {
  const p = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SendInp {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
}
public static class DpiFix2 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][DpiFix2]::SetProcessDPIAware()
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payloadB64({ ops })}')) | ConvertFrom-Json
$ops = @($p.ops)
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$dflags = @(0x0002, 0x0008, 0x0020)
$uflags = @(0x0004, 0x0010, 0x0040)
$sent = 0
foreach ($o in $ops) {
  if ($o.k -eq "ch") {
    foreach ($fl in @(4, 6)) {
      $inp = New-Object SendInp+INPUT
      $inp.type = 1
      $inp.u.ki.wScan = [uint16]$o.u
      $inp.u.ki.dwFlags = [uint32]$fl
      $arr = [System.Array]::CreateInstance([SendInp+INPUT], 1)
      $arr[0] = $inp
      $r = [SendInp]::SendInput(1, $arr, [System.Runtime.InteropServices.Marshal]::SizeOf([type][SendInp+INPUT]))
      if ($r -eq 1) { $sent++ }
    }
    continue
  }
  $inp = New-Object SendInp+INPUT
  if ($o.k -eq "mv") {
    $nx = [int][Math]::Floor((($o.x - $vs.X) * 65536) / $vs.Width)
    $ny = [int][Math]::Floor((($o.y - $vs.Y) * 65536) / $vs.Height)
    if ($nx -lt 0) { $nx = 0 }; if ($nx -gt 65535) { $nx = 65535 }
    if ($ny -lt 0) { $ny = 0 }; if ($ny -gt 65535) { $ny = 65535 }
    $inp.type = 0
    $inp.u.mi.dx = $nx
    $inp.u.mi.dy = $ny
    $inp.u.mi.dwFlags = [uint32](0x8001 -bor 0x4000)
  } elseif ($o.k -eq "dn") {
    $inp.type = 0
    $inp.u.mi.dwFlags = [uint32]$dflags[$o.b]
  } elseif ($o.k -eq "up") {
    $inp.type = 0
    $inp.u.mi.dwFlags = [uint32]$uflags[$o.b]
  } elseif ($o.k -eq "wh") {
    $inp.type = 0
    $inp.u.mi.mouseData = [uint32]($o.d -band 4294967295)
    $inp.u.mi.dwFlags = [uint32]0x0800
  } elseif ($o.k -eq "hw") {
    $inp.type = 0
    $inp.u.mi.mouseData = [uint32]($o.d -band 4294967295)
    $inp.u.mi.dwFlags = [uint32]0x1000
  } elseif ($o.k -eq "kd") {
    $inp.type = 1
    $inp.u.ki.wVk = [uint16]$o.vk
  } elseif ($o.k -eq "ku") {
    $inp.type = 1
    $inp.u.ki.wVk = [uint16]$o.vk
    $inp.u.ki.dwFlags = [uint32]2
  } else {
    continue
  }
  $arr = [System.Array]::CreateInstance([SendInp+INPUT], 1)
  $arr[0] = $inp
  $r = [SendInp]::SendInput(1, $arr, [System.Runtime.InteropServices.Marshal]::SizeOf([type][SendInp+INPUT]))
  if ($r -eq 1) { $sent++ }
  if ($o.k -eq "dn") { Start-Sleep -Milliseconds 40 }
  elseif ($o.k -eq "mv") { Start-Sleep -Milliseconds 10 }
  else { Start-Sleep -Milliseconds 12 }
}
@{ sent = $sent; total = $ops.Count } | ConvertTo-Json -Compress
`
  return p
}

function windowScript(focusText?: string): string {
  const focus = focusText ? "true" : "false"
  return (
    PS_HEAD +
    String.raw`
$p = @{ focus = ${focus}; text = '${focusText ? focusText.replace(/'/g, "''") : ""}' } | ConvertFrom-Json
$wins = New-Object System.Collections.ArrayList
$cb = [DpiFix+EnumProc]{ param($h, $l)
  if (-not [DpiFix]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][DpiFix]::GetWindowText($h, $sb, 512)
  $t = $sb.ToString()
  if ($t.Length -gt 0) {
    [void]$wins.Add(@{
      hwnd = $h.ToInt64()
      title = $t
      minimized = [bool][DpiFix]::IsIconic($h)
      focused = $h.Equals([DpiFix]::GetForegroundWindow())
    })
  }
  return $true
}
[void][DpiFix]::EnumWindows($cb, [IntPtr]::Zero)

if ($p.focus) {
  $pattern = "*" + $p.text + "*"
  $match = $wins | Where-Object { $_.title -like $pattern } | Select-Object -First 1
  if ($match) {
    $h = [IntPtr]$match.hwnd
    if ([DpiFix]::IsIconic($h)) { [void][DpiFix]::ShowWindow($h, 9) ; Start-Sleep -Milliseconds 200 }
    $ok = [DpiFix]::SetForegroundWindow($h)
    @{ ok = [bool]$ok; focusedTitle = $match.title; windows = @() } | ConvertTo-Json -Compress -Depth 4
  } else {
    @{ ok = $false; focusedTitle = ""; windows = @() } | ConvertTo-Json -Compress
  }
} else {
  @{ ok = $true; focusedTitle = ""; windows = $wins } | ConvertTo-Json -Compress -Depth 4
}
`
  )
}

// ---- helpers ---------------------------------------------------------------

const readPng = Effect.fn("Computer.readPng")(function* (file: string) {
  const buf = yield* Effect.promise(() => readFile(file))
  yield* Effect.promise(() =>
    unlink(file).catch(() => {}),
  )
  return buf.toString("base64")
})

const runBackend = Effect.fn("Computer.runBackend")(function* (script: string) {
  return yield* Effect.tryPromise({
    try: () => runPS(script),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
})

const toPhys = (view: Viewport, x: number, y: number) => ({
  px: view.vx + Math.round((x * view.vw) / view.ow),
  py: view.vy + Math.round((y * view.vh) / view.oh),
})

const attachment = (b64: string) => [{ type: "file" as const, mime: "image/png", url: `data:image/png;base64,${b64}` }]

// ---- tool ------------------------------------------------------------------

export const ComputerTool = Tool.define<typeof Parameters, Metadata, never>("computer", Effect.succeed({
  description: DESCRIPTION,
  parameters: Parameters,
  execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
    Effect.gen(function* () {
      const st = stateFor(ctx.sessionID)

      yield* ctx.ask({
        permission: "computer",
        patterns: [params.action],
        always: ["*"],
        metadata: { action: params.action },
      })

      switch (params.action) {
        case "screenshot": {
          const r = yield* runBackend(captureScript())
          const b64 = yield* readPng(r.file)
          st.view = { vx: r.vx, vy: r.vy, vw: r.vw, vh: r.vh, ow: r.ow, oh: r.oh }
          return {
            title: "screenshot",
            metadata: { action: "screenshot" as const, target: `${r.ow}x${r.oh}` },
            output: `Screenshot captured (${r.ow}x${r.oh}; virtual screen ${r.vw}x${r.vh}). All coordinates you pass are in this image's pixel space.`,
            attachments: attachment(b64),
          }
        }

        case "observe": {
          const r = yield* runBackend(observeScript())
          const b64 = yield* readPng(r.file)
          const ratio = r.vw / r.ow
          st.view = { vx: r.vx, vy: r.vy, vw: r.vw, vh: r.vh, ow: r.ow, oh: r.oh }
          st.marks.clear()
          const lines: string[] = []
          const elements = Array.isArray(r.elements) ? r.elements : []
          for (const el of elements) {
            st.marks.set(el.id, {
              id: el.id,
              role: el.role ?? "",
              name: el.name ?? "",
              px: el.x,
              py: el.y,
              w: el.w,
              h: el.h,
            })
            const ix = Math.round((el.x - r.vx) / ratio)
            const iy = Math.round((el.y - r.vy) / ratio)
            lines.push(
              `#${el.id} ${el.role}${el.name ? ` "${el.name}"` : ""} @ (${ix},${iy}) ${Math.round(el.w / ratio)}x${Math.round(el.h / ratio)}`,
            )
          }
          return {
            title: `observe (${lines.length})`,
            metadata: { action: "observe" as const },
            output: [`Observed ${lines.length} interactable element(s). Click with ref=N — preferred over raw coordinates.`, "", ...lines].join("\n"),
            attachments: attachment(b64),
          }
        }

        case "click":
        case "double_click":
        case "right_click": {
          let px: number, py: number, label: string
          if (typeof params.ref === "number") {
            const mark = st.marks.get(params.ref)
            if (!mark) return yield* Effect.fail(new Error(`ref #${params.ref} is unknown or stale — run observe again`))
            px = mark.px + Math.round(mark.w / 2)
            py = mark.py + Math.round(mark.h / 2)
            label = mark.name || mark.role || `#${mark.id}`
          } else {
            if (params.x === undefined || params.y === undefined)
              return yield* Effect.fail(new Error(`${params.action} needs ref or x/y`))
            if (!st.view) return yield* Effect.fail(new Error("no recent screenshot — coordinates need one to map against"))
            const t = toPhys(st.view, params.x, params.y)
            px = t.px
            py = t.py
            label = `(${params.x},${params.y})`
          }
          const btn = params.action === "right_click" ? 1 : 0
          const reps = params.action === "double_click" ? 2 : 1
          const ops: Op[] = [{ k: "mv", x: px, y: py }]
          for (let i = 0; i < reps; i++) ops.push({ k: "dn", b: btn }, { k: "up", b: btn })
          yield* runBackend(inputScript(ops))
          return {
            title: `${params.action} ${label}`,
            metadata: { action: params.action, target: label },
            output: `${params.action} done at physical (${px},${py}). Take a fresh screenshot/observe before the next decision.`,
          }
        }

        case "type":
        case "key": {
          if (typeof params.text !== "string") return yield* Effect.fail(new Error(`${params.action} needs text`))
          let ops: Op[]
          try {
            ops = params.action === "key" ? parseKeys(params.text) : parseText(params.text)
          } catch (e) {
            return yield* Effect.fail(e instanceof Error ? e : new Error(String(e)))
          }
          yield* runBackend(inputScript(ops))
          return {
            title: params.action === "key" ? `key ${params.text}` : "type",
            metadata: { action: params.action },
            output: params.action === "key" ? `Sent keys: ${params.text}` : `Typed ${params.text.length} character(s).`,
          }
        }

        case "scroll": {
          const dir = params.direction ?? "down"
          const amount = Math.max(1, Math.min(20, Math.round(params.amount ?? 3)))
          const delta = dir === "up" || dir === "right" ? 120 * amount : -(120 * amount)
          const ops: Op[] = []
          if (params.x !== undefined && params.y !== undefined) {
            if (!st.view) return yield* Effect.fail(new Error("no recent screenshot — coordinates need one to map against"))
            const t = toPhys(st.view, params.x, params.y)
            ops.push({ k: "mv", x: t.px, y: t.py })
          }
          for (let i = 0; i < amount; i++) ops.push(dir === "left" || dir === "right" ? { k: "hw", d: Math.trunc(delta / amount) } : { k: "wh", d: Math.trunc(delta / amount) })
          yield* runBackend(inputScript(ops))
          return {
            title: `scroll ${dir}`,
            metadata: { action: "scroll", target: dir },
            output: `Scrolled ${dir} by ${amount}.`,
          }
        }

        case "move": {
          if (params.x === undefined || params.y === undefined) return yield* Effect.fail(new Error("move needs x/y"))
          if (!st.view) return yield* Effect.fail(new Error("no recent screenshot — coordinates need one to map against"))
          const t = toPhys(st.view, params.x, params.y)
          yield* runBackend(inputScript([{ k: "mv", x: t.px, y: t.py }]))
          return {
            title: `move (${params.x},${params.y})`,
            metadata: { action: "move" },
            output: `Pointer moved.`,
          }
        }

        case "drag": {
          if (params.x === undefined || params.y === undefined || params.to_x === undefined || params.to_y === undefined)
            return yield* Effect.fail(new Error("drag needs x/y and to_x/to_y"))
          if (!st.view) return yield* Effect.fail(new Error("no recent screenshot — coordinates need one to map against"))
          const from = toPhys(st.view, params.x, params.y)
          const to = toPhys(st.view, params.to_x, params.to_y)
          const ops: Op[] = [{ k: "mv", x: from.px, y: from.py }, { k: "dn", b: 0 }]
          const steps = 24
          for (let i = 1; i <= steps; i++) {
            ops.push({
              k: "mv",
              x: Math.round(from.px + ((to.px - from.px) * i) / steps),
              y: Math.round(from.py + ((to.py - from.py) * i) / steps),
            })
          }
          ops.push({ k: "up", b: 0 })
          yield* runBackend(inputScript(ops))
          return {
            title: "drag",
            metadata: { action: "drag" },
            output: `Dragged (${params.x},${params.y}) -> (${params.to_x},${params.to_y}).`,
          }
        }

        case "window": {
          const focusing = typeof params.text === "string"
          const r = yield* runBackend(windowScript(focusing ? params.text : undefined))
          if (focusing) {
            if (!r.ok) return yield* Effect.fail(new Error(`no window with title containing '${params.text}'`))
            return {
              title: `focus ${r.focusedTitle}`,
              metadata: { action: "window", target: r.focusedTitle },
              output: `Focused window: ${r.focusedTitle}`,
            }
          }
          const wins = Array.isArray(r.windows) ? r.windows : []
          const lines = wins.map(
            (w: any) => `- ${w.focused ? "[focused] " : ""}${w.minimized ? "(minimized) " : ""}${w.title}`,
          )
          return {
            title: `windows (${wins.length})`,
            metadata: { action: "window" },
            output: lines.join("\n"),
          }
        }
      }
    }).pipe(Effect.orDie),
}))

export * as Computer from "./computer"
