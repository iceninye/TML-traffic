// Scoped offline-shell check for the default diagram and technical search path.
// Optional MapLibre chunks and manifest-driven duty/timetable files are
// intentionally excluded: they are lazy-loaded or cached by their own flow.
//   node tools/validate_sw.mjs
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, posix, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const read = (path) => readFileSync(resolve(root, path), "utf8")
const normalize = (path) => path.replace(/^\.\//u, "").replace(/^\//u, "")

const sw = read("sw.js")
const shellBlock = sw.match(/const SHELL = \[([\s\S]*?)\]/u)?.[1] ?? ""
const shell = new Set([...shellBlock.matchAll(/["']([^"']+)["']/gu)].map((match) => normalize(match[1])))

const required = new Set()
const html = read("index.html")
for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/gu)) {
  const value = match[1]
  if (!value || value.startsWith("#") || /^https?:/u.test(value)) continue
  required.add(normalize(value))
}

const entry = "assets/app.js"
const queue = [entry]
const seen = new Set()
while (queue.length) {
  const path = queue.shift()
  if (seen.has(path)) continue
  seen.add(path)
  required.add(path)
  const source = read(path)
  for (const match of source.matchAll(/^\s*import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/gmu)) {
    const specifier = match[1]
    if (!specifier.startsWith(".")) continue
    queue.push(posix.normalize(posix.join(dirname(path), specifier)))
  }
}

for (const path of [
  "data/tml-network.json",
  "data/tml-timetable.json",
  "lib/td-search.js",
  "lib/td-infrastructure.js",
  "data/td-segments.json",
  "data/td-tml-v2_3_5.json",
]) required.add(path)

const isFile = (path) => {
  const absolute = resolve(root, path)
  return existsSync(absolute) && statSync(absolute).isFile()
}
const missingFiles = [...required].filter((path) => !isFile(path)).sort()
if (missingFiles.length) {
  console.error(`✗ SW critical-path 檔案不存在：${missingFiles.join("、")}`)
  process.exit(1)
}
const missingShellFiles = [...shell].filter(Boolean).filter((path) => !isFile(path)).sort()
if (missingShellFiles.length) {
  console.error(`✗ SW shell 列出但檔案不存在：${missingShellFiles.join("、")}`)
  process.exit(1)
}

const missing = [...required].filter((path) => !shell.has(path)).sort()
if (missing.length) {
  console.error(`✗ SW shell 缺少搜尋 critical-path 資源：${missing.join("、")}`)
  process.exit(1)
}
console.log(`✓ SW shell 涵蓋搜尋 critical-path 共 ${required.size} 個資源`)
