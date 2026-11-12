// The sidebar's list: the uncommitted files of the selected space's checkout. A click shows
// the file's diff in the space's Diff tab; the bar at the bottom sends the comments.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, hc, layout, notify, run, theme } from "herdr";

import { changedFiles, repoRoot } from "./git.js";
import { warm } from "./grammar.js";
import { activeSpace, activeView, checkoutOf, commentsOf, openFileTab, saveComments } from "./store.js";

const CHECK_MS = 1000;
const REFRESH_MS = 5000;
const STATUS_LABEL = { A: "new", M: "modified", D: "deleted" };
const WARM_FILES = 40;

function find(node, id) {
  if (node?.id === id) return node;

  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }

  return null;
}

// The sidebar's rail goes by its width, as in the other sidebar mods.
const isNarrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function reviewMessage(comments) {
  const sorted = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.from - b.from);
  const where = (comment) => {
    if (comment.side === "file") return comment.path;

    const lines = comment.from === comment.to ? `${comment.from}` : `${comment.from}-${comment.to}`;

    return comment.side === "old" ? `${comment.path}:${lines} (removed lines, numbered as before the change)` : `${comment.path}:${lines}`;
  };
  const parts = sorted.map((comment) => `### ${where(comment)}\n${comment.body}`);

  return `Review comments (${sorted.length}):\n\n${parts.join("\n\n")}`;
}

export class Sidebar {
  init(cx) {
    this.state = null;
    this.contextKey = null;
    this.loadedAt = 0;
    this.isLoading = false;
    this.isSending = false;
    this.roots = new Map();

    cx.timer.every(CHECK_MS, (cx) => this.check(cx));
    this.check(cx);
  }

  context() {
    const space = activeSpace();
    if (!space) return null;

    return { spaceId: space.id, on: space.machine ?? null, cwd: checkoutOf(space) };
  }

  check(cx) {
    const context = this.context();
    if (!context) return;

    const key = JSON.stringify(context);
    const isNew = key !== this.contextKey;
    if (!isNew && (this.isLoading || Date.now() - this.loadedAt < REFRESH_MS)) return;

    this.contextKey = key;
    this.isLoading = true;
    this.loadedAt = Date.now();

    cx.spawn(async (cx) => {
      let state;
      try {
        const root = this.roots.get(key) ?? await repoRoot(context.cwd, context.on);
        if (root) this.roots.set(key, root);
        state = { ...context, root, files: root ? await changedFiles(root, context.on) : [], error: null };
      } catch (error) {
        state = { ...context, root: null, files: [], error: String(error) };
      }

      if (this.contextKey !== key) return;
      this.isLoading = false;

      const isSame = JSON.stringify(state) === JSON.stringify(this.state);
      this.state = state;
      if (!isSame) cx.notify();

      // Color the listed files ahead of their first opening.
      if (state.root && !state.on) {
        await warm(state.files.filter((file) => file.status !== "D").slice(0, WARM_FILES)
          .map((file) => ({ root: state.root, on: state.on, path: file.path, isUntracked: file.isUntracked })));
      }
    });
  }

  open(file, cx) {
    const state = this.state;
    const space = activeSpace();
    if (!state?.root || !space || space.id !== state.spaceId) return;

    cx.spawn(async () => openFileTab({ space: space.id, root: state.root, on: state.on, file: `${state.root}/${file.path}` }));
  }

  send(cx) {
    const state = this.state;
    const comments = state?.root ? commentsOf(state.root) : [];
    if (!comments.length || this.isSending) return;

    const mine = agents().filter((agent) => agent.space === state.spaceId);
    const agent = mine.find((candidate) => candidate.focused) ?? mine[0];
    if (!agent) {
      notify({ title: "No agent in this worktree", body: "Start an agent here, then send the comments.", level: "warning" });

      return;
    }

    this.isSending = true;
    cx.notify();

    cx.spawn(async (cx) => {
      const result = await hc(["send", agent.address, reviewMessage(comments)]).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }));
      this.isSending = false;

      if (result.code === 0) {
        saveComments(state.root, []);
        notify({ title: "Comments sent", body: `${comments.length} to ${agent.title || agent.program?.name || agent.address}`, level: "success" });
        run("pane.focus", { pane: agent.pane });
      } else {
        notify({ title: "Could not send the comments", body: (result.stderr || result.stdout || "").trim().split("\n")[0] || `hc send exited with ${result.code}`, level: "error" });
      }
      cx.notify();
    });
  }

  row(file, t, counts, shownPath) {
    const name = file.path.split("/").pop();
    // As an IDE's changes list colors them: modified blue, new green, deleted red.
    const color = file.status === "A" ? t.ansi2 : file.status === "D" ? t.ansi1 : t.ansi4;
    const count = counts.get(file.path) ?? 0;

    return h_flex().id(`change-${file.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(8).cursor_pointer()
      .when(file.path === shownPath, (el) => el.bg(t.selected))
      .hover((style) => style.bg(t.hover))
      .tooltip(`${file.path} · ${STATUS_LABEL[file.status]}`)
      .on_click((_event, cx) => this.open(file, cx))
      .child(div().flex_1().min_w(0).truncate().text_color(color).child(name))
      .when(count > 0, (el) => el.child(div().flex_none().min_w(18).h(18).px(5).flex().items_center().justify_center().rounded(9).bg(t.accent + "33").text_size(10.5).text_color(t.accent).child(String(count))));
  }

  render(cx) {
    const t = theme();
    const frame = v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13);
    if (isNarrow()) return frame;

    const context = this.context();
    const state = this.state && context && this.state.spaceId === context.spaceId ? this.state : null;
    const files = state?.files ?? [];
    const comments = state?.root ? commentsOf(state.root) : [];
    const counts = new Map();
    for (const comment of comments) counts.set(comment.path, (counts.get(comment.path) ?? 0) + 1);

    // The file of the tab in front is marked, however that tab was reached.
    const front = state?.root ? activeView(activeSpace()) : null;
    const shownPath = front?.file?.startsWith(`${state.root}/`) ? front.file.slice(state.root.length + 1) : null;
    const empty = !state ? "Loading…" : state.error ? state.error : !state.root ? "Not a git checkout" : !files.length ? "No uncommitted changes" : null;
    const canSend = comments.length > 0 && !this.isSending;

    return frame
      .child(h_flex().h(41).pt(14).pb(5).px(16).flex_none().items_center()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Changes")))
      .when(Boolean(empty), (el) => el.child(div().flex_1().px(16).text_size(12).text_color(t.dim).child(empty)))
      .when(!empty, (el) => el.child(v_flex().id("changes-list").flex_1().min_h(0).px(8).overflow_y_scrollbar().mode("always")
        .children(files.map((file) => this.row(file, t, counts, shownPath)))))
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(comments.length ? t.foreground : t.dim)
          .child(`${comments.length} comment${comments.length === 1 ? "" : "s"}`))
        .child(h_flex().id("changes-send").h(24).px(9).gap(6).flex_none().items_center().rounded(6).text_size(11.5).font_medium()
          .bg(canSend ? t.solid : t.raised).text_color(canSend ? t.solid_foreground : t.dim)
          .when(canSend, (el) => el.cursor_pointer().hover((style) => style.opacity(0.88)).on_click((_event, cx) => this.send(cx)))
          .tooltip(canSend ? "Send every comment to this worktree's agent" : "Comment on lines in a diff first")
          .child(svg("mods/river-changes/icons/send.svg").size(12).flex_none())
          .child(this.isSending ? "Sending…" : "Send to agent")));
  }
}
