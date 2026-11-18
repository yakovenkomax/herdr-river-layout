// The diff of the file its space's list picked: unified or side by side (the pane header's
// toggle), unchanged stretches folded, comments on lines kept in shared state.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Scrollbar, Textarea, TextareaState, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { props, settings, theme } from "herdr";

import { fileDiff, fileRows, fileStatus, repoRoot } from "./git.js";
import { cachedLines, grammarLines } from "./grammar.js";
import { commentsOf, describeLines, diffMode, findFileTab, isClosing, publishView, saveComments } from "./store.js";
import { languageOf, tokenize } from "./vendor/highlight.js";

const LINE_HEIGHT = 20;
const FOLD_HEIGHT = 26;
const FILE_ROW_HEIGHT = 30;
const CONTEXT_LINES = 3;
const NUMBER_WIDTH = 44;
const SIGN_WIDTH = 18;
const TAB = "    ";
const NONE = "#00000000";
const REFRESH_MS = 4000;
const CHECK_MS = 250;

// JetBrains' Dark theme token colors (as in WebStorm).
const SYNTAX = Object.freeze({
  keyword: "#cf8e6d", string: "#6aab73", comment: "#7a7e85", number: "#2aacb8", function: "#56a8f5",
  type: "#bcbec4", boolean: "#cf8e6d", variable: "#bcbec4",
});
const ADDED = "#3fb950";
const REMOVED = "#f85149";

const show = (text) => text.replaceAll("\t", TAB);
const PLAIN_TEXT = "#bcbec4";

// A row's spans from the helper's line, if that line is still the row's text. undefined: the
// lines are from another version of the file; null: this row keeps the tokenizer's colors.
function grammarSpans(row, lines) {
  const line = row.kind === "del" ? lines.old?.[row.old - 1] : lines.new?.[row.new - 1];
  if (!line) return undefined;
  if (!line.length) return row.text === "" ? [] : null;

  const spans = [];
  let text = "";
  for (let index = 0; index < line.length; index += 2) {
    const color = line[index].toLowerCase();
    text += line[index + 1];
    spans.push({ text: show(line[index + 1]), color: color === PLAIN_TEXT ? null : color });
  }

  return text === row.text ? spans : undefined;
}

// The tokenizer's spans, with the grammar's wherever its lines fit. isStale: some didn't.
function withGrammar(rows, spans, lines) {
  let isStale = false;
  const merged = rows.map((row, index) => {
    const fromGrammar = grammarSpans(row, lines);
    if (fromGrammar === undefined) isStale = true;

    return fromGrammar ?? spans[index];
  });

  return { spans: merged, isStale };
}

// Spans per row: the new file's lines in their order, the removed ones in the old file's.
function colorRows(rows, path) {
  const language = languageOf(path);
  let newState = null, oldState = null;

  return rows.map((row) => {
    const text = show(row.text);
    if (!language) return [{ text, cls: "" }];

    if (row.kind === "del") {
      const result = tokenize(text, language, oldState);
      oldState = result.state;

      return result.spans;
    }

    const result = tokenize(text, language, newState);
    newState = result.state;
    if (row.kind === "ctx") oldState = tokenize(text, language, oldState).state;

    return result.spans;
  });
}

export class DiffView {
  init(cx) {
    // One file, read-only. With uncommitted changes it is shown as their diff; comments need its repo.
    this.fileTarget = null;
    this.hasChanges = false;
    // Which pane this is: found once in the layout document, to publish what it shows.
    this.paneId = null;
    this.paneLookups = 0;
    this.isLookingUp = false;
    {
      cx.spawn(async (cx) => {
        const file = String(props()?.file ?? ""), on = props()?.on ?? null;
        const folder = file.slice(0, file.lastIndexOf("/")) || "/";
        const root = await repoRoot(folder, on);
        const isInRepo = Boolean(root) && file.startsWith(`${root}/`);

        this.fileTarget = { root: isInRepo ? root : folder, on, path: isInRepo ? file.slice(root.length + 1) : file.split("/").pop(), isUntracked: true, canComment: isInRepo, at: 0 };
        cx.notify();
      });
    }
    this.rows = [];
    this.spans = [];
    this.note = null;
    this.isLoading = false;
    this.loadedKey = null;
    this.loadedAt = 0;
    this.rawKey = "";
    this.expanded = new Set();
    this.selection = null;
    this.editingId = null;
    this.width = 900;
    this.itemsKey = null;
    this.items = [];
    this.sizes = [];

    // The form shows while something is picked: lines, or the file (the row above the first line).
    // With a comment being edited, picking moves that comment there.
    this.input = TextareaState.new({ placeholder: "Ask the agent about this file or the selected lines", rows: 3 });
    this.input.on("submit", (event, cx) => { if (!event?.shift) this.saveComment(cx); });
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();

    cx.timer.every(CHECK_MS, (cx) => this.check(cx));
  }

  target() {
    return this.fileTarget;
  }

  // A new pick loads at once; the shown file is read again every few seconds.
  close() {
    if (this.paneId) publishView(this.paneId, null);
  }

  publish() {
    if (this.paneId) publishView(this.paneId, { file: String(props()?.file ?? ""), on: props()?.on ?? null, hasChanges: this.hasChanges });
  }

  check(cx) {
    const target = this.target();
    if (!target || isClosing(target.root)) return;

    if (!this.paneId && !this.isLookingUp && this.paneLookups < 20) {
      this.isLookingUp = true;
      this.paneLookups++;
      cx.spawn(async (cx) => {
        const found = await findFileTab(String(props()?.file ?? ""), props()?.on ?? null).catch(() => null);
        this.isLookingUp = false;
        if (!found) return;

        this.paneId = found.pane;
        this.publish();
      });
    }

    // A send clears the comments: an edit of one that is gone ends.
    if (this.editingId && !this.comments().some((comment) => comment.id === this.editingId)) {
      this.resetForm();
      cx.notify();
    }

    const key = JSON.stringify([target.root, target.on, target.path, target.at]);
    const isNew = key !== this.loadedKey;
    if (!isNew && (this.isLoading || Date.now() - this.loadedAt < REFRESH_MS)) return;

    if (isNew) {
      this.loadedKey = key;
      this.rows = [];
      this.spans = [];
      this.note = null;
      this.rawKey = "";
      this.expanded = new Set();
      this.resetForm();
    }
    this.isLoading = true;
    this.loadedAt = Date.now();
    if (isNew) cx.notify();

    cx.spawn(async (cx) => {
      let result;
      // Changed files (new and deleted ones too) come as a diff, the rest as they are.
      let colorTarget = { ...target, isUntracked: true };
      try {
        const status = target.canComment ? await fileStatus(target.root, target.on, target.path) : null;
        if (status) colorTarget = { ...target, isUntracked: status.isUntracked };
        result = status ? await fileDiff(target.root, target.on, { path: target.path, isUntracked: status.isUntracked }) : await fileRows(`${target.root}/${target.path}`, target.on);
      }
      catch (error) { result = { rows: [], note: String(error) }; }

      if (this.loadedKey !== key) return;
      this.isLoading = false;

      const rawKey = JSON.stringify([result.note, result.rows.length, result.rows.map((row) => row.kind[0] + row.text).join("\n")]);
      if (rawKey === this.rawKey) return;

      this.rawKey = rawKey;
      this.rows = result.rows;
      this.note = result.note;
      // The grammar's colors from the last time this file was shown, else the tokenizer's;
      // the helper is asked again only when the file changed since.
      const tokenized = colorRows(result.rows, target.path);
      const known = cachedLines(colorTarget);
      const first = known ? withGrammar(result.rows, tokenized, known) : { spans: tokenized, isStale: true };
      this.spans = first.spans;
      this.itemsKey = null;
      this.hasChanges = result.rows.some((row) => row.kind !== "ctx");
      this.publish();
      // A file opens at its first change.
      if (isNew) this.revealRow = this.hasChanges ? result.rows.findIndex((row) => row.kind !== "ctx") : 0;
      cx.notify();
      if (!first.isStale) return;

      const lines = await grammarLines(colorTarget).catch(() => null);
      if (!lines || this.loadedKey !== key || this.rawKey !== rawKey) return;

      this.spans = withGrammar(this.rows, tokenized, lines).spans;
      cx.notify();
    });
  }

  resetForm() {
    this.selection = null;
    this.editingId = null;
    this.input.set_value("");
  }

  comments() {
    const target = this.target();

    return target ? commentsOf(target.root).filter((comment) => comment.path === target.path) : [];
  }

  // The list's items: lines (or pairs of them), folds of unchanged lines, and comments under
  // the last line each is about.
  build(mode, comments) {
    const rows = this.rows;
    // A file with changes folds its unchanged stretches; one without shows whole.
    const foldAt = new Map();
    for (let index = 0; this.hasChanges && index < rows.length;) {
      if (rows[index].kind !== "ctx") { index++; continue; }

      let end = index;
      while (end < rows.length && rows[end].kind === "ctx") end++;

      const from = index === 0 ? index : index + CONTEXT_LINES;
      const to = end === rows.length ? end : end - CONTEXT_LINES;
      if (to - from > CONTEXT_LINES && !this.expanded.has(from)) foldAt.set(from, to);
      index = end;
    }

    const under = new Map();
    for (const comment of comments) {
      if (comment.side === "file") continue;

      const rowIndex = rows.findIndex((row) => (comment.side === "old" ? row.old === comment.to && row.kind !== "add" : row.new === comment.to && row.kind !== "del"));
      const key = rowIndex < 0 ? rows.length - 1 : rowIndex;
      under.set(key, [...(under.get(key) ?? []), comment]);
    }

    const items = [];
    const commentHeight = (comment) => {
      const perLine = Math.max(30, Math.floor((this.width - 190) / 7.2));
      const lines = comment.body.split("\n").reduce((count, line) => count + Math.max(1, Math.ceil(line.length / perLine)), 0);

      return 22 + lines * 18;
    };
    // Above the first line: the row that starts a file comment, then the file's comments.
    if (this.canComment()) items.push({ kind: "file-add", key: "file-add", height: FILE_ROW_HEIGHT });
    for (const comment of comments) {
      if (comment.side === "file") items.push({ kind: "comment", key: `c-${comment.id}`, comment, height: commentHeight(comment) });
    }

    const pushComments = (from, to) => {
      for (let index = from; index < to; index++) {
        for (const comment of under.get(index) ?? []) items.push({ kind: "comment", key: `c-${comment.id}`, comment, height: commentHeight(comment) });
      }
    };

    for (let index = 0; index < rows.length;) {
      const foldEnd = foldAt.get(index);
      if (foldEnd !== undefined) {
        items.push({ kind: "fold", key: `f-${index}`, from: index, count: foldEnd - index, height: FOLD_HEIGHT });
        pushComments(index, foldEnd);
        index = foldEnd;
        continue;
      }

      if (mode === "unified" || rows[index].kind === "ctx") {
        items.push(mode === "unified"
          ? { kind: "line", key: `l-${index}`, row: index, height: LINE_HEIGHT }
          : { kind: "pair", key: `p-${index}`, left: index, right: index, height: LINE_HEIGHT });
        pushComments(index, index + 1);
        index++;
        continue;
      }

      // Side by side: a run of removed lines beside the added lines that follow it.
      let removedEnd = index;
      while (removedEnd < rows.length && rows[removedEnd].kind === "del") removedEnd++;
      let addedEnd = removedEnd;
      while (addedEnd < rows.length && rows[addedEnd].kind === "add") addedEnd++;

      const removed = removedEnd - index, added = addedEnd - removedEnd;
      for (let offset = 0; offset < Math.max(removed, added); offset++) {
        const left = offset < removed ? index + offset : null;
        const right = offset < added ? removedEnd + offset : null;
        items.push({ kind: "pair", key: `p-${left ?? "x"}-${right ?? "x"}`, left, right, height: LINE_HEIGHT });
        if (left !== null) pushComments(left, left + 1);
        if (right !== null) pushComments(right, right + 1);
      }
      index = addedEnd;
    }

    return items;
  }

  isSelected(rowIndex, side) {
    const selection = this.selection, row = this.rows[rowIndex];
    if (!selection || !row || selection.side !== side) return false;

    const line = side === "old" ? row.old : row.new;

    return line !== null && line >= selection.from && line <= selection.to;
  }

  canComment() {
    // Comments are for changes: a file without any takes none.
    return Boolean(this.fileTarget?.canComment) && this.hasChanges;
  }

  // What stands left of the code: two line numbers and the sign in a diff, one number in a file.
  gutter() {
    return this.hasChanges ? NUMBER_WIDTH * 2 + SIGN_WIDTH : NUMBER_WIDTH + 12;
  }

  pick(rowIndex, side, isShift, cx) {
    if (!this.canComment()) return;

    const row = this.rows[rowIndex];
    const line = side === "old" ? row.old : row.new;
    if (line === null) return;

    const current = this.selection;
    const isSameLine = current && current.side === side && current.from === line && current.to === line;
    // A click on the one selected line lets it go, unless a comment is being moved.
    if (isSameLine && !this.editingId) {
      this.cancel(cx);

      return;
    }

    if (isShift && current && current.side === side) {
      this.selection = { side, anchor: current.anchor, from: Math.min(current.anchor, line), to: Math.max(current.anchor, line) };
    } else {
      this.selection = { side, anchor: line, from: line, to: line };
    }

    this.input.focus();
    cx.notify();
  }

  // Always a new comment: an edit in progress ends, and the form starts empty.
  pickFile(cx) {
    this.selection = { side: "file", anchor: 0, from: 0, to: 0 };
    this.editingId = null;
    this.input.set_value("");
    this.input.focus();
    cx.notify();
  }

  // Rows of a virtual list can't hold click handlers: the list reports the clicked item's key,
  // and the press before it says which half of a side-by-side row was hit and whether Shift was down.
  clicked(key, cx) {
    const item = this.items.find((candidate) => candidate.key === key);
    if (!item) return;

    const press = this.press ?? {};
    if (item.kind === "fold") {
      this.expanded.add(item.from);
      this.itemsKey = null;
      cx.notify();
    } else if (item.kind === "file-add") {
      this.pickFile(cx);
    } else if (item.kind === "comment") {
      this.edit(item.comment, cx);
    } else if (item.kind === "line") {
      this.pick(item.row, this.rows[item.row].kind === "del" ? "old" : "new", press.isShift, cx);
    } else {
      const isLeft = (press.ratio ?? 1) < 0.5;
      const side = isLeft ? (item.left !== null ? "old" : "new") : (item.right !== null ? "new" : "old");
      this.pick(side === "old" ? item.left : item.right, side, press.isShift, cx);
    }
  }

  edit(comment, cx) {
    this.selection = { side: comment.side, anchor: comment.from, from: comment.from, to: comment.to };
    this.editingId = comment.id;
    this.input.set_value(comment.body);
    this.input.focus();
    cx.notify();
  }

  cancel(cx) {
    this.resetForm();
    this.handle.focus();
    cx.notify();
  }

  // An empty message deletes the comment being edited.
  saveComment(cx) {
    const target = this.target(), selection = this.selection, body = this.input.value().trim();
    if (!target || !selection) return;

    const others = commentsOf(target.root).filter((other) => other.id !== this.editingId);
    if (!body) {
      if (this.editingId) saveComments(target.root, others);
      this.cancel(cx);

      return;
    }

    const comment = { id: this.editingId ?? `${Date.now()}-${Math.floor(Math.random() * 1e6)}`, path: target.path, side: selection.side, from: selection.from, to: selection.to, body };
    saveComments(target.root, [...others, comment]);
    this.cancel(cx);
  }

  deleteComment(cx) {
    const target = this.target();
    if (target && this.editingId) saveComments(target.root, commentsOf(target.root).filter((comment) => comment.id !== this.editingId));

    this.cancel(cx);
  }

  code(rowIndex, t) {
    return h_flex().flex_1().min_w(0).whitespace_nowrap().overflow_hidden()
      .children(this.spans[rowIndex].map((span) => {
        const color = span.color ?? SYNTAX[span.cls];

        return color ? div().flex_none().text_color(color).child(span.text) : div().flex_none().child(span.text);
      }));
  }

  number(value, tint, t) {
    return div().w(NUMBER_WIDTH).flex_none().text_right().pr(6).text_color(tint ? t.foreground + "b0" : t.dim).child(value === null ? "" : String(value));
  }

  line(item, t, marked) {
    const row = this.rows[item.row];
    const side = row.kind === "del" ? "old" : "new";
    const tint = row.kind === "add" ? ADDED : row.kind === "del" ? REMOVED : null;
    const isOn = this.isSelected(item.row, side);

    // A line that takes no comment (a file without changes) is not something to click.
    return h_flex().w_full().h(LINE_HEIGHT).flex_none().items_center().when(this.canComment(), (el) => el.cursor_pointer()).when(!this.canComment(), (el) => el.cursor_default())
      .border_l(2).border_color(isOn ? t.accent : marked.has(item.row) ? t.accent + "80" : NONE)
      .when(Boolean(tint), (el) => el.bg(tint + (isOn ? "4d" : "26")))
      .when(!tint && isOn, (el) => el.bg(t.selected))
      .when(this.hasChanges, (el) => el.child(this.number(row.old, tint, t)))
      .child(this.number(row.new, tint, t))
      .child(!this.hasChanges ? div().w(12).flex_none() : div().w(SIGN_WIDTH).flex_none().text_center().text_color(tint ?? NONE).child(row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "))
      .child(this.code(item.row, t));
  }

  half(rowIndex, side, key, t, marked) {
    if (rowIndex === null) return div().flex_1().min_w(0).h_full().bg(t.raised + "60");

    const row = this.rows[rowIndex];
    const tint = row.kind === "add" ? ADDED : row.kind === "del" ? REMOVED : null;
    const isOn = this.isSelected(rowIndex, side);

    return h_flex().flex_1().min_w(0).h_full().items_center().when(this.canComment(), (el) => el.cursor_pointer()).overflow_hidden()
      .border_l(2).border_color(isOn ? t.accent : marked.has(`${side}-${rowIndex}`) ? t.accent + "80" : NONE)
      .when(Boolean(tint), (el) => el.bg(tint + (isOn ? "4d" : "26")))
      .when(!tint && isOn, (el) => el.bg(t.selected))
      .child(this.number(side === "old" ? row.old : row.new, tint, t))
      .child(div().w(SIGN_WIDTH).flex_none().text_center().text_color(tint ?? NONE).child(row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "))
      .child(this.code(rowIndex, t));
  }

  pair(item, t, marked) {
    return h_flex().w_full().h(LINE_HEIGHT).flex_none()
      .child(this.half(item.left, "old", item.key, t, marked))
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(this.half(item.right, "new", item.key, t, marked));
  }

  fold(item, t) {
    return h_flex().w_full().h(FOLD_HEIGHT).flex_none().items_center().cursor_pointer().bg(t.raised + "80").text_color(t.dim)
      .child(div().w(NUMBER_WIDTH * 2 + SIGN_WIDTH).flex_none().text_center().child("⋯"))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(`${item.count} unchanged line${item.count > 1 ? "s" : ""}`));
  }

  comment(item, t) {
    const comment = item.comment, isEditing = comment.id === this.editingId;

    return div().w_full().h(item.height).flex_none().pl(this.gutter()).pr(16).py(4).cursor_pointer()
      .child(h_flex().w(Math.max(240, this.width - this.gutter() - 40)).h_full().items_start().gap(10).rounded(8).border_1().border_color(isEditing ? t.accent : t.accent + "66").bg(t.surface).px(10).py(6).overflow_hidden()
        .child(svg("mods/river-changes/icons/message-square.svg").size(14).mt(2).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).font_family(settings().ui_font_family ?? "Geist").text_size(12.5).whitespace_normal().text_color(t.foreground).child(comment.body)));
  }

  composer(t, target) {
    const selection = this.selection;
    const lines = describeLines(selection);
    const stop = (action) => (event, cx) => { cx.stop_propagation(); action(event, cx); };
    const button = (id, label, isPrimary, action) => div().id(id).h(26).px(10).flex().items_center().rounded(6).cursor_pointer()
      .bg(isPrimary ? t.solid : t.raised).text_color(isPrimary ? t.solid_foreground : t.foreground).text_size(11.5).font_medium()
      .hover((style) => style.opacity(0.88)).on_click(stop(action)).child(label);

    return v_flex().id("diff-composer").flex_none().w_full().gap(8).px(14).py(10).border_t(1).border_color(t.border).bg(t.surface)
      .font_family(settings().ui_font_family ?? "Geist").text_size(12)
      .child(div().w_full().truncate().font_semibold().text_color(t.foreground)
        .child(`${target.path.split("/").pop()}${lines ? ` · ${lines}` : ""}`))
      .child(Textarea.new(this.input).w_full().px(8).py(6).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
      .child(h_flex().gap(6).items_center()
        .child(button("diff-comment-save", this.editingId ? "Save" : "Add comment", true, (_event, cx) => this.saveComment(cx)))
        .child(button("diff-comment-cancel", "Cancel", false, (_event, cx) => this.cancel(cx)))
        .when(Boolean(this.editingId), (el) => el.child(div().id("diff-comment-delete").h(26).px(8).flex().items_center().rounded(6).cursor_pointer().text_size(11.5).text_color(t.ansi1)
          .hover((style) => style.bg(t.hover)).on_click(stop((_event, cx) => this.deleteComment(cx))).child("Delete")))
        );
  }

  fileRow(item, t) {
    const isOn = this.selection?.side === "file" && !this.editingId;

    return h_flex().w_full().h(item.height).flex_none().items_center().gap(8).cursor_pointer().pl(this.gutter()).border_l(2).border_color(isOn ? t.accent : NONE)
      .when(isOn, (el) => el.bg(t.selected))
      .font_family(settings().ui_font_family ?? "Geist").text_size(12).text_color(isOn ? t.foreground : t.dim)
      .child(svg("mods/river-changes/icons/message-square-plus.svg").size(14).flex_none())
      .child("Add a file comment");
  }

  message(t, text) {
    return div().size_full().bg(t.background).p(16).text_size(12.5).text_color(t.dim).child(text);
  }

  render(cx) {
    const t = theme(), target = this.target();
    if (!target) return this.message(t, "Loading…");

    const notice = this.note ? `${target.path}: ${this.note}` : !this.rows.length ? (this.isLoading ? "Loading…" : "Empty file") : null;
    const frame = (body) => v_flex().id("task-diff").size_full().min_h(0).bg(t.background)
      .track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === "escape" && this.selection) { this.cancel(cx); cx.stop_propagation(); } })
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(12.5).text_color(t.foreground)
      .when(true, (el) => el.child(div().flex_none().w_full().h(26).px(14).flex().items_center().border_b(1).border_color(t.border)
        .font_family(settings().ui_font_family ?? "Geist").text_size(11.5).text_color(t.dim).child(div().truncate().child(target.path))))
      .child(body)
      .when(Boolean(this.selection), (el) => el.child(this.composer(t, target)));
    if (notice) return frame(div().flex_1().min_h(0).p(16).text_color(t.dim).child(notice));

    const mode = this.hasChanges ? props()?.mode ?? diffMode() : "unified", comments = this.comments();
    const itemsKey = JSON.stringify([this.rawKey.length, this.loadedKey, this.hasChanges, mode, [...this.expanded], comments, this.width]);
    if (itemsKey !== this.itemsKey) {
      this.itemsKey = itemsKey;
      this.items = this.build(mode, comments);
      this.sizes = this.items.map((item) => item.height);
      if (this.revealRow !== null && this.revealRow !== undefined) {
        const row = this.revealRow;
        const index = this.items.findIndex((item) => (item.kind === "line" && item.row >= row) || (item.kind === "pair" && ((item.left ?? -1) >= row || (item.right ?? -1) >= row)));
        this.scroll.scroll_to_item(row === 0 ? 0 : Math.max(0, index), row === 0 ? "top" : "center");
        this.revealRow = null;
      }
    }

    const marked = new Set();
    for (const comment of comments) {
      this.rows.forEach((row, index) => {
        const line = comment.side === "old" ? row.old : row.new;
        if (line === null || line < comment.from || line > comment.to) return;
        if (comment.side === "old" ? row.kind === "add" : row.kind === "del") return;

        marked.add(index);
        marked.add(`${comment.side}-${index}`);
      });
    }

    const items = this.items;
    const longest = mode === "unified" ? this.rows.reduce((length, row) => Math.max(length, show(row.text).length), 0) : 0;
    const contentWidth = mode === "unified" ? NUMBER_WIDTH * 2 + SIGN_WIDTH + longest * 7.6 + 40 : 0;
    const draw = (item) => (item.kind === "line" ? this.line(item, t, marked) : item.kind === "pair" ? this.pair(item, t, marked)
      : item.kind === "fold" ? this.fold(item, t) : item.kind === "file-add" ? this.fileRow(item, t) : this.comment(item, t));
    const list = v_virtual_list("task-diff-rows", items.length, this.sizes, (index) => items[index].key,
      (range) => items.slice(range.start, range.end).map(draw)).size_full().track_scroll(this.scroll).on_item_click((key, cx) => this.clicked(key, cx));

    return frame(div().id("task-diff-area").flex_1().min_h(0).relative()
        .on_mouse_down("left", (event) => {
          const width = event.bounds?.size?.width ?? event.bounds?.width ?? this.width;
          this.press = { isShift: Boolean(event.modifiers?.shift), ratio: event.local_position ? event.local_position.x / width : 1 };
        })
        .child(div().id("task-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(contentWidth).h_full().child(list)))
        .child(Scrollbar.vertical("task-diff-rows").absolute().inset_0()));
  }
}
