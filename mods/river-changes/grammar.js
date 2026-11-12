// Grammar-based colors for a diff, from the Node helper in ./shiki (Shiki, VS Code's grammars).
// The diff shows the built-in tokenizer's colors at once and takes these when they arrive.

import { appHome, exec } from "herdr";

// A PATH's Node first, then the newest one nvm has (a nvm PATH is often set up by the shell only), then the usual folders.
const NODE_CANDIDATES = ["node", "/opt/homebrew/bin/node", "/usr/local/bin/node"];
const NVM_NODE = 'ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1';
const TIMEOUT_MS = 15000;

const MAX_CACHED = 200;

let workingNode = null;
// Kept for as long as the mod's code is loaded: a file opened again is colored at once.
const cache = new Map();
const pending = new Map();

// The file view asks for the working file alone, the diff for both sides: two entries.
const keyOf = (target) => `${target.root}\u0000${target.path}\u0000${target.isUntracked ? 1 : 0}`;

/** The lines last fetched for this file; they may be older than the file is now. */
export const cachedLines = (target) => cache.get(keyOf(target)) ?? null;

/** Returns { old: Line[], new: Line[] } with Line = [color, text, …], or null without a grammar or Node. */
export function grammarLines(target) {
  const key = keyOf(target);
  if (pending.has(key)) return pending.get(key);

  const promise = fetchLines(target)
    .then((lines) => {
      if (lines) {
        cache.delete(key);
        cache.set(key, lines);
        if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
      }

      return lines;
    })
    .finally(() => pending.delete(key));
  pending.set(key, promise);

  return promise;
}

/** Colors files ahead of their first opening, one at a time. */
export async function warm(targets) {
  for (const target of targets) {
    if (!cache.has(keyOf(target))) await grammarLines(target).catch(() => null);
  }
}

async function nodeCandidates() {
  const nvmNode = (await exec("sh", ["-c", NVM_NODE]).catch(() => null))?.stdout.trim();

  return nvmNode ? [NODE_CANDIDATES[0], nvmNode, ...NODE_CANDIDATES.slice(1)] : NODE_CANDIDATES;
}

async function fetchLines(target) {
  // The helper reads the files itself: this computer only.
  if (target.on) return null;

  const script = `${appHome()}/mods/river-changes/shiki/highlight.mjs`;
  const args = [script, target.root, target.path, target.isUntracked ? "1" : "0"];

  for (const node of workingNode ? [workingNode] : await nodeCandidates()) {
    try {
      const result = await exec(node, args, { timeout: TIMEOUT_MS });
      if (result.code !== 0) continue;

      workingNode = node;
      const lines = JSON.parse(result.stdout);

      return Array.isArray(lines.new) ? lines : null;
    } catch {
      continue;
    }
  }

  return null;
}
