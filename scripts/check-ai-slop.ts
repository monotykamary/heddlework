/**
 * check-ai-slop.ts — objective "AI slop removal" gate.
 *
 * Scans a diff (or the full tree) for the deterministic artifacts that machine-generated
 * or sloppy PRs leave behind, and enforces a minimal PR surface. It never judges intent;
 * every rule is an objective string/structural check so passing/failing is reproducible.
 *
 * Usage (from repo root):
 *   bun scripts/check-ai-slop.ts                 # whole tree
 *   DIFF_BASE=<sha> bun scripts/check-ai-slop.ts  # only added lines in base..HEAD
 *   DIFF_FILE=/path/to/diff.txt bun scripts/check-ai-slop.ts
 *
 * Exit codes: 0 = clean · 1 = blocking findings · 2 = only warnings (passes, but loud)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ERROR = "error";
// merge-conflict markers are built from char codes so this file never self-matches
const CM_OPEN = String.fromCharCode(60, 60, 60, 60, 60, 60, 60) + " ";
const CM_CLOSE = String.fromCharCode(62, 62, 62, 62, 62, 62, 62) + " ";
const WARN = "warn";
const INFO = "info";

// Concrete, foolproof markers. Patterns carry NO /g flag on purpose: RegExp.prototype.test()
// with /g mutates lastIndex and silently skips matches in the next file, so we rely on stateless
// default behavior. The checker's own source is exempt: it must literally name these artifacts.
const SELF_PATH = "scripts/check-ai-slop.ts";
const LEFTOVER_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:TODO|FIXME|HACK|XXX)\b(?::|\s|$)/, "leftover TODO/FIXME/HACK/XXX marker"],
  [/\bYOUR\s+(?:NAME|CODE|TEXT|MESSAGE)?\s*HERE\b/i, "generated placeholder (YOUR ... HERE)"],
  [/\bLorem ipsum\b/gi, "placeholder lorem-ipsum copy"],
  [/\bconsole\.log\b/, "stray console.log"],
  [/\bdebugger;?\b/, "stray debugger statement"],
];

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function diffText(): string {
  if (process.env.DIFF_FILE) return readFileSync(process.env.DIFF_FILE, "utf8");
  const base = process.env.DIFF_BASE;
  if (base) return git(["diff", base + "...HEAD"]);
  // default: diff working tree against HEAD
  return git(["diff", "HEAD"]);
}

function addedLinesOf(diff: string): Map<string, string> {
  const perFile = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      current = [];
      perFile.set(line.slice(6), current);
    } else if (current && (line.startsWith("+") && !line.startsWith("+++"))) {
      current.push(line.slice(1));
    }
  }
  const out = new Map<string, string>();
  for (const [f, lines] of perFile) out.set(f, lines.join("\n"));
  return out;
}

function treeFiles(): string[] {
  // tracked + untracked-but-not-ignored source; skip vendor/build pulls and the .pi state dir
  const tracked = git(["ls-files"]).split("\n").filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  return [...tracked, ...untracked].filter((p) => !p.startsWith("external/") && !p.startsWith("node_modules/"));
}

const findings: Array<{ severity: string; file: string; detail: string }> = [];

// Scope. Leftover patterns (TODO/console.log/debugger/…) only ever apply to ADDED lines:
// an unfixed whole-tree scan would flag every pre-existing script/src console.log as slop,
// which is noise, not signal. So:
//   - DIFF_BASE / DIFF_FILE  -> scan added lines of that PR/hunk diff (the CI gate)
//   - otherwise              -> scan the working-tree diff v HEAD, i.e. what you are about
//                               to commit. Whole-tree mode then checks ONLY merge markers
//                               (a real, never-intended artifact) for safety.
const scope = process.env.DIFF_FILE || process.env.DIFF_BASE ? "diff" : "worktree";

for (const [file, addedSrc] of addedLinesOf(diffText())) {
  if (file === SELF_PATH) continue; // don't self-flag
  if (addedSrc.includes(CM_OPEN) || addedSrc.includes(CM_CLOSE)) {
    findings.push({ severity: ERROR, file, detail: "unresolved merge conflict marker" });
  }
  for (const [re, label] of LEFTOVER_PATTERNS) {
    if (re.test(addedSrc)) findings.push({ severity: WARN, file, detail: label });
  }
  if (file.endsWith(".ts") && addedSrc.split("\n").length > 500) {
    findings.push({ severity: WARN, file, detail: "large addition (>500 lines) — split or justify" });
  }
}
if (scope === "worktree") {
  for (const file of treeFiles()) {
    if (file === SELF_PATH) continue;
    const src = readFileSync(file, "utf8");
    if (src.includes(CM_OPEN) || src.includes(CM_CLOSE)) {
      findings.push({ severity: ERROR, file, detail: "unresolved merge conflict marker in tree" });
    }
  }
}
if (scope === "diff") {
  const title = process.env.PR_TITLE || "";
  if (title.length < 8) findings.push({ severity: WARN, file: "(PR)", detail: "missing/short PR title" });
  const body = process.env.PR_BODY || "";
  if (body.trim().length < 20) findings.push({ severity: INFO, file: "(PR)", detail: "thin PR description (<20 chars)" });
}

let errors = 0, warnings = 0, info = 0;
for (const f of findings) {
  if (f.severity === ERROR) errors++;
  else if (f.severity === WARN) warnings++;
  else info++;
  const ch = f.severity === ERROR ? console.error : f.severity === WARN ? console.warn : console.log;
  ch(`[${f.severity}] ${f.file}: ${f.detail}`);
}

console.log(`\ncheck-ai-slop: scope=${scope} errors=${errors} warnings=${warnings} info=${info}`);
if (errors > 0) process.exit(1);
if (warnings > 0) process.exit(2);
process.exit(0);