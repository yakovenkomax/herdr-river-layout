// What the list and the diff share, and the three shared keys other mods may use (README.md).

import { exec, focused, panes, run, setShared, shared, spaces } from "herdr";

export const MOD = "river-changes";
// The name of the mod that shows files, set by that mod. Another mod opens a file with
// tab.new { mod: <that name>, props: { role: "file", file, root, on } }.
export const VIEWER = "river.viewer";
// { [pane id]: { file, on, hasChanges } }: what each open file tab shows. A pane listed here is a
// file view; a tab bar, a pane header or a file tree marks the file of the tab in front with it.
export const VIEWS = "river.views";
// { [repo root]: [{ id, path, side: "new" | "old" | "file", from, to, body }] }
export const COMMENTS = "river-changes.comments";
// "unified" | "split": written by whoever draws the toggle, read by the file view.
export const MODE = "river.diff-mode";

export function announceViewer() {
  if (shared(VIEWER) !== MOD) setShared(VIEWER, MOD);
}

export const diffMode = () => (shared(MODE) === "split" ? "split" : "unified");

// The file tab in front in a space, if its active tab is one: { file, on, hasChanges } or null.
export function activeView(space) {
  const tab = space?.tabs.find((candidate) => candidate.active)?.id;
  const pane = panes().find((candidate) => candidate.tab === tab && candidate.mod === MOD);

  return pane ? (shared(VIEWS) ?? {})[pane.pane] ?? null : null;
}

export function publishView(paneId, view) {
  const views = { ...(shared(VIEWS) ?? {}) };
  // Entries of panes that are gone go with any change.
  const live = new Set(panes().map((pane) => pane.pane));
  for (const id of Object.keys(views)) if (!live.has(id)) delete views[id];

  if (view) views[paneId] = view;
  else delete views[paneId];

  if (JSON.stringify(views) !== JSON.stringify(shared(VIEWS) ?? {})) setShared(VIEWS, views);
}

export const commentsOf = (root) => (shared(COMMENTS) ?? {})[root] ?? [];

export function saveComments(root, list) {
  const all = { ...(shared(COMMENTS) ?? {}) };
  if (list.length) all[root] = list;
  else delete all[root];

  setShared(COMMENTS, all);
}

export function activeSpace() {
  const focus = focused();

  return spaces().find((space) => space.id === focus?.space) ?? spaces().find((space) => space.active) ?? null;
}

// Where a space is now: its first terminal's live folder, else where it was made.
export function checkoutOf(space, allPanes = panes()) {
  const tabs = new Set((space?.tabs ?? []).map((tab) => tab.id));

  return allPanes.find((pane) => tabs.has(pane.tab) && pane.terminal && pane.cwd)?.cwd || space?.folder || null;
}

// The pane of the tab that shows this file, from the core's layout document (panes() has no
// props): { space, tab, pane } or null.
export async function findFileTab(file, on) {
  if (!panes().some((pane) => pane.mod === MOD)) return null;

  const query = JSON.stringify({ jsonrpc: "2.0", id: "river-changes-open", method: "doc.get", params: { name: "herdr-app", ...(on ? { on } : {}) } });
  const result = await exec("sh", ["-c", 'printf "%s\\n" "$1" | hc connect', "river-changes", query]);
  if (result.code !== 0) return null;

  const reply = result.stdout.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .find((value) => value?.id === "river-changes-open");
  const qualify = (id) => (on ? `${on}/${id}` : id);
  const live = new Set(panes().map((pane) => pane.pane));
  let found = null;

  for (const space of reply?.result?.value?.spaces ?? []) {
    for (const tab of space.tabs ?? []) {
      const visit = (node) => {
        const fileProps = node?.content?.mod === MOD ? node.content.props : null;
        if (!found && fileProps?.role === "file" && fileProps.file === file && (fileProps.on ?? null) === (on ?? null) && live.has(qualify(node.id))) {
          found = { space: qualify(space.id), tab: qualify(tab.id), pane: qualify(node.id) };
        }
        for (const child of node?.children ?? []) visit(child);
      };
      visit(tab.root);
    }
  }

  return found;
}

// A file opens in its own tab; opened again, that tab is shown.
export async function openFileTab({ space, root, on, file }) {
  const existing = await findFileTab(file, on).catch(() => null);
  if (existing) {
    run("space.select", { id: existing.space });
    run("tab.select", { id: existing.tab });
    run("pane.focus", { pane: existing.pane });
  } else {
    run("tab.new", { space, name: file.split("/").pop(), mod: MOD, props: { role: "file", file, root, on } });
  }
}

export const describeLines = (comment) => {
  if (comment.side === "file") return "";

  const lines = comment.from === comment.to ? `line ${comment.from}` : `lines ${comment.from}-${comment.to}`;

  return comment.side === "old" ? `${lines} (removed code)` : lines;
};
