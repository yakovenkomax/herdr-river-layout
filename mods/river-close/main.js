// Asks before closing a task or a project: { space, kind?: "task" | "project" }
// (without kind: a space on a linked worktree is a task).
// A project closes its tasks with it. The box deletes the worktrees and branches too.
// Enter closes, Space ticks the box, Esc cancels.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, home, window } from "herdr";

// A space's root: the folder it was made in. Only a space made in the home folder
// follows its first terminal instead.
function place(s, all) {
  if (s.folder && s.folder !== home()) return s.folder;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

const QUIET = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const unix = (path) => path.replace(/\\/g, "/");

async function git(cwd, args, on, timeout) {
  const r = await exec("git", args, { cwd, on, ...(timeout === undefined ? {} : { timeout }) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The repo a folder belongs to: its main checkout, and whether the folder is
// itself a linked worktree. null outside git.
async function repoOf(folder, on) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, linked: main !== top.out };
}

// The submodule repos git keeps for a checkout (nested ones too, checked out
// or not): { name, dir, pinned }. `config` is the args that read its
// .gitmodules; `pinned` is the commit its parent records ("" if none).
async function modules(gitDir, config, on, out = [], parent = "") {
  const keys = await git(gitDir, ["--git-dir", gitDir, "config", ...config, "-z", "--get-regexp", "^submodule\\..*\\.path$"], on);
  if (!keys.ok) return out;
  // -z: "key\nvalue" records ended by NUL, so names and paths may hold spaces.
  for (const record of keys.out.split("\0").filter(Boolean)) {
    const at = record.indexOf("\n");
    const name = record.slice("submodule.".length, at - ".path".length);
    const dir = `${gitDir}/modules/${name}`;
    if (!(await git(gitDir, ["--git-dir", dir, "rev-parse", "--git-dir"], on)).ok) continue;
    const pinned = await git(gitDir, ["--git-dir", gitDir, "rev-parse", `HEAD:${record.slice(at + 1)}`], on);
    out.push({ name: parent + name, dir, pinned: pinned.ok ? pinned.out : "" });
    if ((await git(gitDir, ["--git-dir", dir, "cat-file", "-e", "HEAD:.gitmodules"], on)).ok) await modules(dir, ["--blob", "HEAD:.gitmodules"], on, out, `${parent + name}/`);
  }
  return out;
}

// What deleting a worktree and its branch would lose: uncommitted changes, commits
// on no remote and no other branch, and submodule commits that exist nowhere else
// (not on a remote, and not the commit the parent pins: git fetches that by hash).
async function risks(top, branch, on) {
  const status = await git(top, [...QUIET, "status", "--porcelain"], on);
  if (!status.ok) throw new Error(status.err || "git status failed.");
  const ahead = await git(top, ["rev-list", "--count", "HEAD", "--not", "--remotes", ...(branch ? [`--exclude=${branch}`] : []), "--branches"], on);
  const gitDir = await git(top, ["rev-parse", "--absolute-git-dir"], on);
  if (!gitDir.ok) throw new Error(gitDir.err || "git rev-parse failed.");
  const mods = await modules(gitDir.out, ["--file", `${top}/.gitmodules`], on);
  const submodules = [];
  for (const m of mods) {
    const local = await git(gitDir.out, ["--git-dir", m.dir, "rev-list", "-n1", "--all", "--not", "--remotes", ...(m.pinned ? [m.pinned] : [])], on);
    if (!local.ok) throw new Error(local.err || `Couldn't check submodule ${m.name}.`);
    if (local.out) submodules.push(m.name);
  }
  return { dirty: status.out !== "", unpushed: Number(ahead.out) || 0, submodules, force: status.out !== "" || mods.length > 0 };
}

const atRisk = (r) => r.dirty || r.unpushed > 0 || r.submodules.length > 0;

function losses(r, branch) {
  return [
    ...(r.dirty ? ["Uncommitted changes will be lost."] : []),
    ...(r.unpushed ? [`${plural(r.unpushed, "commit")}${branch ? ` on ${branch}` : ""} ${r.unpushed === 1 ? "isn't" : "aren't"} pushed or merged anywhere and will be lost.`] : []),
    ...(r.submodules.length ? [`Submodule ${r.submodules.join(", ")} has commits that aren't pushed anywhere: they will be lost.`] : []),
  ];
}

// The worktree a space is on: { space, top, branch, risks }.
async function taskOf(space, top, on) {
  const branch = await git(top, ["branch", "--show-current"], on);
  return { space, top, branch: branch.out || null, risks: await risks(top, branch.out || null, on) };
}

// A project's tasks: its spaces on the repo's linked worktrees (the deepest worktree wins).
async function tasksOf(repo, project, on) {
  const list = await git(repo.main, ["worktree", "list", "--porcelain"], on);
  if (!list.ok) return [];
  const tops = list.out.split(/\n\n+/).map((block) => block.split("\n").find((l) => l.startsWith("worktree "))?.slice(9)).filter((path) => path && path !== repo.main);
  const all = panes();
  const out = [];
  for (const s of spaces()) {
    if (s.id === project.id || (s.machine ?? null) !== (on ?? null)) continue;
    const at = place(s, all);
    if (!at) continue;
    const top = tops.filter((path) => unix(at) === path || unix(at).startsWith(`${path}/`)).sort((a, b) => b.length - a.length)[0];
    if (top) out.push(await taskOf(s, top, on));
  }
  return out;
}

export default class Close extends View {
  init(_props, cx) {
    this.task = props()?.kind ? props().kind === "task" : undefined; // undefined: not known yet
    this.remove = false; // delete the worktrees and branches
    this.busy = false;
    this.error = "";
    this.repo = undefined; // undefined: looking, null: not in git
    this.tasks = []; // the task itself, or the project's tasks
    this.name = this.space()?.name ?? "";
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      try { await this.look(); }
      catch (error) { this.repo ??= null; this.task ??= false; this.error = String(error.message ?? error); }
      // Deleting is the usual end of a task, so the box starts ticked unless something would be lost.
      this.remove = this.task && this.tasks.length > 0 && !this.tasks.some((k) => atRisk(k.risks));
      cx.notify();
    });
  }

  space() {
    return spaces().find((s) => s.id === props()?.space);
  }

  async look() {
    const s = this.space();
    const folder = s && place(s, panes());
    const repo = folder ? await repoOf(folder, s.machine) : null;
    this.task ??= Boolean(repo?.linked);
    if (repo && this.task && repo.linked) this.tasks = [await taskOf(s, repo.top, s.machine)];
    if (repo && !this.task && !repo.linked) this.tasks = await tasksOf(repo, s, s.machine);
    this.repo = repo;
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  go(cx) {
    if (this.busy || this.repo === undefined) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try { this.error = await this.work(); }
      catch (error) { this.error = String(error.message ?? error); }
      this.busy = false;
      if (!this.error) this.close();
      cx.notify();
    });
  }

  async work() {
    const s = this.space();
    if (!s) return "";
    if (!this.remove && !this.task) for (const k of this.tasks) run("space.close", { id: k.space.id, confirmed: true });
    if (this.remove) {
      // Only what the dialog showed is consented to: new risks get one more look.
      const before = JSON.stringify(this.tasks.map((k) => losses(k.risks, k.branch)));
      for (const k of this.tasks) k.risks = await risks(k.top, k.branch, s.machine);
      if (JSON.stringify(this.tasks.map((k) => losses(k.risks, k.branch))) !== before && this.tasks.some((k) => atRisk(k.risks))) return "It changed since this opened. Close again deletes it anyway.";
      // The spaces close last, so a task leaves the sidebar when the dialog does. Only
      // Windows needs them gone first: a shell sitting in the folder keeps it busy there.
      const first = window()?.platform === "windows";
      for (const k of this.tasks) {
        if (first) run("space.close", { id: k.space.id, confirmed: true });
        const gone = await git(this.repo.main, ["worktree", "remove", ...(k.risks.force ? ["--force"] : []), k.top], s.machine, 600_000);
        if (!gone.ok) return gone.err || "git worktree remove failed.";
        if (!k.branch) continue;
        const deleted = await git(this.repo.main, ["branch", "-D", k.branch], s.machine);
        if (!deleted.ok) return deleted.err || "git branch -D failed.";
      }
      if (!first) for (const k of this.tasks) run("space.close", { id: k.space.id, confirmed: true });
    }
    if (!this.task || !this.remove) run("space.close", { id: s.id, confirmed: true });
    return "";
  }

  key(e, cx) {
    if (e.key === "escape") this.close();
    else if (e.key === "enter") this.go(cx);
    else if (e.key === "space" && this.tasks.length && !this.busy) this.remove = !this.remove;
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  warnings() {
    if (this.task) return this.tasks.flatMap((k) => losses(k.risks, k.branch));
    const risky = this.tasks.filter((k) => atRisk(k.risks)).map((k) => k.space.name);
    return risky.length ? [`${risky.length === 1 ? "This task has" : "These tasks have"} work that isn't pushed and will be lost: ${risky.join(", ")}.`] : [];
  }

  render() {
    const t = theme();
    const what = this.task === undefined ? "" : this.task ? " task" : " project";
    const closes = this.task || !this.tasks.length ? "" : ` Its ${plural(this.tasks.length, "task")} close with it.`;
    const button = (id, label, primary, act) =>
      div().id(id).flex_none().h(28).px(12).flex().items_center().rounded(6).cursor_pointer().border(1)
        .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.popover).text_color(primary ? t.solid_foreground : t.foreground)
        .when(primary && this.busy, (el) => el.opacity(0.6))
        .hover((s) => s.bg(primary ? t.solid : t.hover))
        .on_click((_e, cx) => act(cx))
        .child(label);
    return v_flex()
      .id("close")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(`Close${what} ${this.name}?`))
      .child(div().text_color(t.muted).child(this.repo === undefined ? "\u2026" : `All tabs will be closed.${closes}`))
      .when(this.tasks.length > 0, (el) =>
        el
          .child(
            h_flex().id("remove").h(24).gap(7).items_center().cursor_pointer().text_color(this.remove ? t.foreground : t.muted)
              .on_click((_e, cx) => { this.remove = !this.remove; cx.notify(); })
              .child(
                div().flex_none().size(14).flex().items_center().justify_center().rounded(3).border(1).border_color(this.remove ? t.accent : t.input).bg(t.background)
                  .when(this.remove, (el) => el.child(div().size(6).rounded(1).bg(t.accent))),
              )
              .child(div().min_w(0).truncate().child(`Also delete the associated ${this.task ? "worktree and branch" : "worktrees and branches"}.`)),
          )
          .children((this.remove ? this.warnings() : []).map((text) => div().pl(21).text_size(12).text_color(t.ansi3).child(text))),
      )
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(button("cancel", "Cancel", false, () => this.close()))
          .child(div().flex_1())
          .when(this.busy, (el) => el.child(div().text_size(11).text_color(t.dim).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
          .child(button("go", `Close${what}`, true, (cx) => this.go(cx))),
      );
  }
}
