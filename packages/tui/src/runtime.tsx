import path from "path"

export function abbreviateHome(input: string, home: string) {
  if (!home) return input
  const p = input.startsWith("/") ? path.posix : path
  const relative = p.relative(home, input)
  if (relative === "") return "~"
  if (relative === ".." || relative.startsWith(".." + p.sep) || p.isAbsolute(relative)) return input
  return `~/${relative.split(p.sep).join("/")}`
}
