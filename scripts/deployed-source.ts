// Autograf: the exact source a deploy was built from, recorded on the Worker as
// a plain-text binding (OPENSEO_DEPLOYED_COMMIT) so Command's upstream watch
// can verify the running commit from the live deployment, not from config.
// A tracked-file change is marked "-dirty": that build is not reproducible
// from the commit alone. Outside a git checkout the value is "unknown".
import { execFileSync } from "node:child_process";

export function deployedSource(cwd: string = process.cwd()): string {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const sha = git("rev-parse", "HEAD");
    if (!/^[0-9a-f]{40}$/.test(sha)) return "unknown";
    return git("status", "--porcelain", "--untracked-files=no")
      ? `${sha}-dirty`
      : sha;
  } catch {
    return "unknown";
  }
}
