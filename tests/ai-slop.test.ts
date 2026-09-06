import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, beforeAll, afterAll } from "bun:test";

const ROOT = join(__dirname, "..");
const script = join(ROOT, "scripts/check-ai-slop.ts");
let tmp: string;

function run(env: Record<string, string>): { code: number; out: string } {
  try {
    const out = execFileSync("bun", [script], { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" });
    return { code: 0, out };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return { code: err.status ?? 1, out: (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "") };
  }
}

beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "ai-slop-")); });
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function writeDiff(name: string, body: string): string {
  const p = join(tmp, name);
  writeFileSync(p, body);
  return p;
}

test("red: diff that introduces a TODO and console.log exits 2", () => {
  const d = writeDiff("bad.diff", [
    "diff --git a/src/a.ts b/src/a.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/a.ts",
    "@@ -0,0 +1,3 @@",
    "+export const a = 1;",
    "+// TODO: fix later",
    '+console.log("x");',
  ].join("\n"));
  const r = run({
    DIFF_FILE: d,
    PR_TITLE: "feat: a real feature with a sufficiently long title",
    PR_BODY: "adds real behavior with enough description and details.",
  });
  expect(r.code).toBe(2);
  expect(r.out).toContain("leftover TODO");
  expect(r.out).toContain("stray console.log");
});

test("green: diff with real title and no leftovers exits 0", () => {
  const good = writeDiff("good.diff", [
    "diff --git a/src/b.ts b/src/b.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/b.ts",
    "@@ -0,0 +1,3 @@",
    "+export const p = 1;",
    "+export const q = 2;",
    "+export const r = 3;",
  ].join("\n"));
  const r = run({
    DIFF_FILE: good,
    PR_TITLE: "feat: add b module with a fully descriptive title here",
    PR_BODY: "Adds module b with a real description and enough details to pass.",
  });
  expect(r.code).toBe(0);
});

test("red: whole-tree scan flags a merge marker as error (exit 1)", () => {
  const markerFile = join(ROOT, "src", "__marker_probe_ai_slop__.ts");
  writeFileSync(markerFile, "x\n" + String.fromCharCode(60,60,60,60,60,60,60) + " HEAD\nfork\n=======\ntail\n" + String.fromCharCode(62,62,62,62,62,62,62) + " feature\n");
  try {
    const r = run({});
    expect(r.code).toBe(1);
    expect(r.out).toContain("unresolved merge conflict marker in tree");
  } finally {
    rmSync(markerFile, { force: true });
  }
});
