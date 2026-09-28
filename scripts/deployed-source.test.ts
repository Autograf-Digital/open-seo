import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { deployedSource } from "./deployed-source";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "deployed-source-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git(
    "-c",
    "user.email=t@example.test",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "one",
  );
  return { dir, sha: git("rev-parse", "HEAD") };
}

test("CONTRACT: a clean checkout records its exact commit", () => {
  const { dir, sha } = repo();
  expect(deployedSource(dir)).toBe(sha);
});

test("CONTRACT: a tracked-file change is marked dirty, an untracked file is not", () => {
  const { dir, sha } = repo();
  writeFileSync(join(dir, "untracked.env"), "X=1\n");
  expect(deployedSource(dir)).toBe(sha);
  writeFileSync(join(dir, "a.txt"), "two\n");
  expect(deployedSource(dir)).toBe(`${sha}-dirty`);
});

test("CONTRACT: outside a git checkout the source is unknown, never a guess", () => {
  const dir = mkdtempSync(join(tmpdir(), "deployed-source-nogit-"));
  dirs.push(dir);
  expect(deployedSource(dir)).toBe("unknown");
});
