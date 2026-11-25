// Runs the path-sensitive tools from a real directory whose name contains a space.
//   node tools/validate_tool_paths.mjs
import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const tmpDir = mkdtempSync(join(tmpdir(), "tml traffic "))
const copyRoot = join(tmpDir, "repo")

try {
  for (const dir of ["tools", "lib", "data", "worker"]) {
    cpSync(join(root, dir), join(copyRoot, dir), { recursive: true })
  }

  const cases = [
    { script: "validate_data.mjs", args: [], allowed: [0] },
    { script: "validate_calendar.mjs", args: [], allowed: [0] },
    { script: "validate_td.mjs", args: [], allowed: [0] },
    { script: "validate_proxy.mjs", args: [], allowed: [0] },
    { script: "coverage.mjs", args: ["--days", "1"], allowed: [0, 2] },
  ]

  for (const { script, args, allowed } of cases) {
    const result = spawnSync(process.execPath, [join(copyRoot, "tools", script), ...args], {
      cwd: copyRoot,
      encoding: "utf8",
      env: process.env,
    })
    if (result.error) throw result.error
    if (result.status === null || !allowed.includes(result.status)) {
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n")
      throw new Error(`${script} exited ${result.status ?? "without a status"}; expected ${allowed.join(" or ")}\n${output}`)
    }
    console.log(`✓ ${script} exit ${result.status}`)
  }

  console.log("validate_tool_paths OK")
} catch (error) {
  console.error(`validate_tool_paths FAILED: ${error.message}`)
  process.exitCode = 1
} finally {
  rmSync(tmpDir, { recursive: true, force: true })
}
