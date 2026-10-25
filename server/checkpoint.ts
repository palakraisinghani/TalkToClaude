import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A snapshot of an agent's folder before each of its turns, so "undo what Juno just did" can put
 * the folder back exactly as it was.
 *
 * It is taken with git's plumbing, through a temporary index, so it never touches the lead's own
 * staging area, branch or stash: the snapshot is a commit object kept under refs/claudecall/, out of
 * sight of normal git use. Only the agent's own folder is covered (it may sit inside a bigger
 * repository), and files git ignores — node_modules, build output — are left alone both ways.
 * Folders that are not in a git repository simply have no undo.
 */

const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  run("git", args, { cwd, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout.trim());

/** The repository root for a folder, or null when it is not inside one. */
export async function repoOf(dir: string): Promise<string | null> {
  try { return await git(dir, ["rev-parse", "--show-toplevel"]); } catch { return null; }
}

/** The tree of the folder as it is on disk now, built in a throwaway index. */
async function treeNow(root: string, path: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "cc-index-"));
  const env = { GIT_INDEX_FILE: join(tmp, "index") };
  try {
    // start from HEAD so files outside the folder are carried along unchanged, then take the folder as it is
    const hasHead = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).then(() => true, () => false);
    if (hasHead) await git(root, ["read-tree", "HEAD"], env);
    await git(root, ["add", "-A", "--", path], env);
    return await git(root, ["write-tree"], env);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export interface Checkpoint { commit: string; root: string; path: string; label: string; at: number }

/** Snapshot the folder. Returns null if it is not in a git repository, or git is unavailable. */
export async function checkpoint(dir: string, label: string, ref: string): Promise<Checkpoint | null> {
  const root = await repoOf(dir);
  if (!root) return null;
  // git gives the root by its real path (macOS /var is really /private/var): compare like with like
  const path = relative(root, await realpath(resolve(dir)).catch(() => resolve(dir))) || ".";
  try {
    const tree = await treeNow(root, path);
    const parent = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "");
    const commit = await git(root, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `ClaudeCall checkpoint: ${label}`],
      { GIT_AUTHOR_NAME: "ClaudeCall", GIT_AUTHOR_EMAIL: "claudecall@localhost", GIT_COMMITTER_NAME: "ClaudeCall", GIT_COMMITTER_EMAIL: "claudecall@localhost" });
    // a ref keeps the snapshot from being garbage-collected while it may still be wanted
    await git(root, ["update-ref", `refs/claudecall/${ref}`, commit]);
    return { commit, root, path, label, at: Date.now() };
  } catch {
    return null;
  }
}

/** What has changed in the folder since the snapshot: added, modified and deleted files. */
export async function changedSince(cp: Checkpoint): Promise<{ status: string; file: string }[]> {
  const now = await treeNow(cp.root, cp.path);
  const out = await git(cp.root, ["diff", "--name-status", "--no-renames", cp.commit, now, "--", cp.path]);
  return out ? out.split("\n").map((l) => { const [status, ...f] = l.split("\t"); return { status, file: f.join("\t") }; }) : [];
}

/**
 * Put the folder back as it was at the snapshot: changed and deleted files restored, files the turn
 * added removed. Only the files that differ are touched; the lead's staging area is left as it is.
 */
export async function restore(cp: Checkpoint): Promise<string[]> {
  const changes = await changedSince(cp);
  const back = changes.filter((c) => c.status !== "A").map((c) => c.file);
  const added = changes.filter((c) => c.status === "A").map((c) => c.file);
  if (back.length) await git(cp.root, ["restore", `--source=${cp.commit}`, "--worktree", "--", ...back]);
  for (const f of added) await unlink(join(cp.root, f)).catch(() => {});
  return changes.map((c) => c.file);
}
