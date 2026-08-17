import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/attach"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import { errorMessage } from "./util/error"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { PluginCommand } from "./cli/cmd/plug"
import { Heap } from "./cli/heap"

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .option("custom-prompt", {
    describe:
      "override the system prompt for matching models. format: <providerID>/<modelID>=<path-to-prompt-file>. wildcards allowed (anthropic/*, */claude-opus-4-7, *claude*). repeatable.",
    type: "string",
    array: true,
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    if (opts.customPrompt && (opts.customPrompt as string[]).length > 0) {
      const entries: Array<{ providerID: string; modelID: string; prompt: string }> = []
      for (const raw of opts.customPrompt as string[]) {
        const eq = raw.indexOf("=")
        if (eq <= 0) {
          process.stderr.write(
            `--custom-prompt: skipping malformed entry (missing '='): ${raw}${EOL}`,
          )
          continue
        }
        const target = raw.slice(0, eq).trim()
        const filePath = raw.slice(eq + 1).trim()
        const slash = target.indexOf("/")
        if (slash <= 0) {
          process.stderr.write(
            `--custom-prompt: skipping malformed entry (expected providerID/modelID=path): ${raw}${EOL}`,
          )
          continue
        }
        const providerID = target.slice(0, slash)
        const modelID = target.slice(slash + 1)
        const expanded = filePath.startsWith("~/")
          ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", filePath.slice(2))
          : filePath
        const file = Bun.file(expanded)
        if (!(await file.exists())) {
          process.stderr.write(`--custom-prompt: file not found, skipping: ${expanded}${EOL}`)
          continue
        }
        const prompt = await file.text()
        if (!prompt.trim()) {
          process.stderr.write(`--custom-prompt: file is empty, skipping: ${expanded}${EOL}`)
          continue
        }
        entries.push({ providerID, modelID, prompt })
      }
      if (entries.length > 0) {
        // Windows env vars are capped at ~32KB per key; large prompt bodies
        // silently truncate. Ferry through a temp file and pass only its
        // path so spawned subprocesses inherit the path safely.
        const payload = JSON.stringify(entries)
        try {
          const tmpDir = path.join(Global.Path.data, "tmp")
          await Bun.write(path.join(tmpDir, ".keep"), "")
          const tmpFile = path.join(tmpDir, `custom-prompts-${process.pid}-${Date.now()}.json`)
          await Bun.write(tmpFile, payload)
          process.env.OPENCODE_CUSTOM_PROMPTS_FILE = tmpFile
          process.on("exit", () => {
            try {
              require("fs").unlinkSync(tmpFile)
            } catch {}
          })
        } catch (e) {
          process.stderr.write(
            `--custom-prompt: failed to stage temp file (${String(e).slice(0, 120)}); falling back to inline env (may truncate on Windows)${EOL}`,
          )
          process.env.OPENCODE_CUSTOM_PROMPTS = payload
        }
      }
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command(DbCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
