// Git reads: the uncommitted files of a checkout and one file's diff against HEAD.

import { exec, readTextFile } from "herdr";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const WHOLE_FILE = "-U1000000";

export async function repoRoot(cwd, on) {
  if (!cwd) return null;

  try {
    const result = await exec("git", [...READ, "rev-parse", "--show-toplevel"], { cwd, on });

    return result.code === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** Returns [{ path, status: "A" | "M" | "D", isUntracked }], sorted by path. */
export async function changedFiles(root, on) {
  const result = await exec("git", [...READ, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git status failed");

  const files = result.stdout.split("\0").filter(Boolean).map((entry) => {
    const code = entry.slice(0, 2), path = entry.slice(3);
    const isUntracked = code === "??";
    const status = isUntracked || code.includes("A") ? "A" : code.includes("D") ? "D" : "M";

    return { path, status, isUntracked };
  });

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Returns { status, isUntracked } for a file with uncommitted changes, else null. */
export async function fileStatus(root, on, path) {
  const result = await exec("git", [...READ, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", path], { cwd: root, on });
  const entry = result.code === 0 ? result.stdout.split("\0").find(Boolean) : null;
  if (!entry) return null;

  const code = entry.slice(0, 2), isUntracked = code === "??";

  return { status: isUntracked || code.includes("A") ? "A" : code.includes("D") ? "D" : "M", isUntracked };
}

/** Returns a file's lines as unchanged rows: { rows, note }. */
export async function fileRows(path, on) {
  const text = await readTextFile(path, { on }).catch(() => null);
  if (text === null || text.includes("\0")) return { rows: [], note: "No text preview for this file (binary, too large or unreadable)" };

  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();

  return { rows: lines.map((line, index) => ({ kind: "ctx", old: null, new: index + 1, text: line })), note: null };
}

/** Returns { rows: [{ kind: "ctx" | "add" | "del", old, new, text }], note } for the whole file. */
export async function fileDiff(root, on, file) {
  if (file.isUntracked) {
    const text = await readTextFile(`${root}/${file.path}`, { on }).catch(() => null);
    if (text === null || text.includes("\0")) return { rows: [], note: "No text preview for this file (binary, too large or unreadable)" };

    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();

    return { rows: lines.map((line, index) => ({ kind: "add", old: null, new: index + 1, text: line })), note: null };
  }

  const result = await exec("git", [...READ, "diff", "HEAD", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", WHOLE_FILE, "--", file.path], { cwd: root, on });
  if (result.code !== 0) return { rows: [], note: result.stderr.trim() || "git diff failed" };

  const lines = result.stdout.split("\n");
  const first = lines.findIndex((line) => line.startsWith("@@"));
  if (first < 0) return { rows: [], note: /^Binary files /m.test(result.stdout) ? "Binary file changed" : "No text changes" };

  const rows = [];
  let oldLine = 0, newLine = 0;

  for (const line of lines.slice(first)) {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      oldLine = Number(match[1]);
      newLine = Number(match[2]);
      continue;
    }

    const sign = line[0], text = line.slice(1);
    if (sign === "+") rows.push({ kind: "add", old: null, new: newLine++, text });
    else if (sign === "-") rows.push({ kind: "del", old: oldLine++, new: null, text });
    else if (sign === " ") rows.push({ kind: "ctx", old: oldLine++, new: newLine++, text });
  }

  return { rows, note: null };
}
