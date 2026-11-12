import { exec, panes, spaces, window, run, shared } from "herdr";
import { resolvePath } from "./roots.js";

// Local change: files open in the mod named by the shared "river.viewer", when one is set.
export const fileViewer = () => shared("river.viewer") || null;
const viewer = mod => mod === "river-files" || mod === "preview-plus" || mod === fileViewer();
const pathKey = (path, on) => {
  if (!on && window().platform === "windows") {
    const normalized = resolvePath("/", path);
    return /^[a-z]:\//i.test(normalized) ? normalized[0].toLowerCase() + normalized.slice(1) : normalized;
  }
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return "/" + parts.join("/");
};

export async function findOpenFile(file, on, preferredSpace) {
  if (!panes().some(pane => viewer(pane.mod))) return null;
  const query = JSON.stringify({ jsonrpc: "2.0", id: "river-files-open", method: "doc.get", params: { name: "herdr-app", ...(on ? { on } : {}) } });
  const result = window().platform === "windows"
    ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", '& { param($request) $request | hc connect }', query])
    : await exec("sh", ["-c", 'printf "%s\\n" "$1" | hc connect', "river-files", query]);
  if (result.code !== 0) throw new Error("Cannot check open files");
  const reply = result.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(value => value.id === "river-files-open");
  if (reply?.error || !Array.isArray(reply?.result?.value?.spaces)) throw new Error("Cannot check open files");
  const qualify = id => on ? `${on}/${id}` : id;
  const livePanes = new Map(panes().map(pane => [pane.pane, pane]));
  const liveSpaces = spaces();
  const matches = [];
  for (const space of reply.result.value.spaces) {
    const spaceId = qualify(space.id), liveSpace = liveSpaces.find(value => value.id === spaceId);
    if (!liveSpace) continue;
    for (const tab of space.tabs || []) {
      const tabId = qualify(tab.id);
      if (!liveSpace.tabs.some(value => value.id === tabId)) continue;
      const visit = node => {
        const content = node.content, target = content?.props, pane = livePanes.get(qualify(node.id));
        if (pane?.tab === tabId && pane.mod === content?.mod && viewer(content?.mod)
          && (content.mod !== "river-files" || target?.role === "preview")
          && (content.mod !== fileViewer() || target?.role === "file")
          && typeof target?.file === "string" && (target.on || null) === (on || null) && pathKey(target.file, on) === pathKey(file, on)) {
          matches.push({ space: spaceId, tab: tabId, pane: pane.pane });
        }
        for (const child of node.children || []) visit(child);
      };
      visit(tab.root);
    }
  }
  return matches.find(match => match.space === preferredSpace) || matches[0] || null;
}

export function focusOpenFile(target) {
  run("space.select", { id: target.space });
  run("tab.select", { id: target.tab });
  const zoomed = panes().find(pane => pane.tab === target.tab && pane.zoomed && pane.pane !== target.pane);
  if (zoomed) run("pane.zoom", { pane: zoomed.pane });
  run("pane.focus", { pane: target.pane });
}
