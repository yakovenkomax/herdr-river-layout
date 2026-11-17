// New-task dialog: { space } or { folder, machine } for a repo without a space;
// optional { title, branch, tab, argv }.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, home, focused, knownAgents, readTextFile, shared, setShared, notify } from "herdr";

// A space's root: the folder it was made in. Only a space made in the home folder
// follows its first terminal instead.
function place(s, all = panes()) {
  if (!s) return null;
  if (s.folder && s.folder !== home()) return s.folder;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// Checkouts go to <ROOT>/<repo>/<branch, slashes as dashes>.
const ROOT = (home) => `${home}/.herdr/worktrees`;
// Run in every new checkout before its agent, from the main checkout's copy (committed or not).
const SETUP = ".river/setup.sh";
// { [machine + main checkout]: { agents: [key], terminal } }, the last choice per project.
const DEFAULTS = "river.task-defaults";
// { [machine]: agents }, the last installed agents each machine reported: asking takes seconds.
const AGENTS = "river.task-agents";
// The first tab runs the setup and leaves its exit code in a file; the other tabs wait for it.
// $1: the setup script, $2: the main checkout, $3: that file, the rest: what to run after (nothing: a shell).
const RUN_SETUP = 'RIVER_MAIN="$2" sh "$1"; s=$?; echo "$s" > "$3"; shift 3; if [ "$s" -ne 0 ]; then printf "\\n%s\\n" "Setup failed ($s)."; exec "${SHELL:-sh}"; fi; if [ "$#" -gt 0 ]; then exec "$@"; fi; exec "${SHELL:-sh}"';
// $1: that file, the rest: what to run once the setup is done.
const AFTER_SETUP = 'echo "Waiting for the setup in the first tab..."; while [ ! -e "$1" ]; do sleep 1; done; if [ "$(cat "$1")" != 0 ]; then echo "Setup failed."; exec "${SHELL:-sh}"; fi; shift; exec "$@"';
const SETUP_USES = ["Install dependencies", "Copy .env and other untracked files", "Generate code or build", "Anything else the project needs before work starts"];
const SETUP_TASK = `Set up task creation for this project. Every new task gets a fresh git worktree of this repository, and the script ${SETUP} of this folder (the main checkout) runs in each new worktree before work starts: the worktree is its working directory and $RIVER_MAIN is this folder. Look at what a fresh checkout of this project needs (installing dependencies, generated files, secrets, untracked files such as .env to copy from $RIVER_MAIN), check it with me, then write ${SETUP} as a POSIX sh script that stops at the first error. Don't run it.`;
const SETUP_UPDATE_TASK = `Update this project's task setup script, ${SETUP} in this folder (the main checkout). It runs in each new git worktree of this repository before work starts: the worktree is its working directory and $RIVER_MAIN is this folder. Read it, compare it with what a fresh checkout of this project needs now, ask me what should change, then edit it, keeping it a POSIX sh script that stops at the first error. Don't run it.`;
// Home as ~ (git says C:/Users/x where Windows says C:\Users\x).
const tilde = (path, userHome) => {
  const [p, h] = [path, userHome].map((s) => s.replace(/\\/g, "/"));
  return p.startsWith(h) ? `~${p.slice(h.length)}` : path;
};
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const kebab = (title) => title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const sleep = (cx, ms) => new Promise((done) => cx.timer.after(ms, done));
async function git(cwd, args, on, timeout) {
  const r = await exec("git", args, { cwd, on, ...(timeout === undefined ? {} : { timeout }) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The repo a folder belongs to: its main checkout and name. null outside git.
async function repoOf(folder, on) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, name: main.split("/").pop() };
}

// Where new branches start by default, and the repo's remotes: the default remote's HEAD
// ("origin/master"), else git's configured or usual names there or here, else the current branch.
async function baseOf(repo, on) {
  const remotes = (await git(repo.main, ["remote"], on)).out.split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
  const has = async (ref) => (await git(repo.main, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], on)).ok;
  if (remote) {
    const head = await git(repo.main, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], on);
    if (head.ok && head.out.startsWith(`${remote}/`)) return { remotes, value: head.out };
  }
  const configured = (await git(repo.main, ["config", "init.defaultBranch"], on)).out;
  for (const name of [configured, "main", "master"].filter(Boolean)) {
    if (remote && (await has(`refs/remotes/${remote}/${name}`))) return { remotes, value: `${remote}/${name}` };
    if (await has(`refs/heads/${name}`)) return { remotes, value: name };
  }
  return { remotes, value: (await git(repo.top, ["branch", "--show-current"], on)).out };
}

export default class Worktree extends View {
  init(_props, cx) {
    this.on = this.space()?.machine;
    this.userHome = this.on ? null : home();
    this.form(cx);
    this.busy = false;
    this.error = "";
    this.repo = undefined; // undefined: looking, null: not in git
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      try {
        if (this.on) {
          let result;
          try { result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on }); } catch {}
          if (!result || result.code !== 0 || !result.stdout.trim()) result = await exec("powershell.exe", ["-NoProfile", "-Command", "[Console]::Write($HOME)"], { on: this.on });
          if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not find the remote home folder.");
          this.userHome = result.stdout.trim().replace(/\\/g, "/");
        }
        this.folder = props()?.folder || place(this.space()) || this.userHome;
        // The repo is set last: Enter does nothing until the form's defaults are read.
        const repo = await repoOf(this.folder, this.on);
        if (repo) await this.project(repo);
        this.repo = repo;
        cx.notify();
        if (repo) cx.spawn(async (cx) => { await this.installed(); cx.notify(); });
        if (props().branch) await this.work(cx);
      } catch (error) { this.repo = null; this.error = String(error); cx.notify(); }
    });
  }

  // The new-task fields: the branch follows the title until it is typed over.
  form(cx) {
    const p = props() ?? {};
    this.title = p.title ?? p.branch ?? "";
    this.branchTyped = Boolean(p.branch);
    this.agents = null; // null: not known yet
    this.picks = new Set(); // agent keys
    this.terminal = false;
    this.setup = false; // the project has a setup script
    this.runSetup = true;
    this.field = "title";
    this.fields = {
      title: InputState.new({ value: this.title, placeholder: "" }),
      branch: InputState.new({ value: p.branch ?? kebab(this.title), placeholder: "" }),
      base: InputState.new({ value: "", placeholder: "" }),
    };
    for (const [name, input] of Object.entries(this.fields)) {
      input.on("change", (_e, cx) => {
        this.error = "";
        this.errorAt = null;
        if (name === "title") {
          this.title = input.value();
          if (!this.branchTyped) this.fields.branch.set_value(kebab(this.title));
        } else if (name === "branch") {
          const typed = input.value();
          this.branchTyped = typed !== kebab(this.title);
        }
        cx.notify();
      });
      input.on("submit", (_e, cx) => this.go(cx));
      input.on("focus", (_e, cx) => { this.field = name; cx.notify(); });
      input.on("blur", (_e, cx) => { if (this.field === name) this.field = null; cx.notify(); });
    }
    this.fields.title.focus();
    cx.timer.after(600, () => this.fields[this.field ?? "title"].focus());
  }

  // What the project brings to the form: its default base, its setup script and the
  // choice made for it last time, among the agents its machine had when last asked.
  async project(repo) {
    this.base = await baseOf(repo, this.on);
    if (!this.fields.base.value()) this.fields.base.set_value(this.base.value);
    let script = null;
    try { script = await readTextFile(`${repo.main}/${SETUP}`, { on: this.on }); } catch {}
    this.setup = script !== null;
    this.key = JSON.stringify([this.on ?? null, repo.main]);
    this.agents = shared(AGENTS)?.[this.on ?? ""] ?? null;
    this.choose();
  }

  choose() {
    if (this.picked) return;
    const last = shared(DEFAULTS)?.[this.key];
    const known = this.agents ?? [];
    this.picks = new Set(last ? (last.agents ?? []).filter((key) => known.some((a) => a.key === key)) : known.slice(0, 1).map((a) => a.key));
    this.terminal = Boolean(last?.terminal);
  }

  async installed() {
    try {
      this.agents = (await knownAgents({ on: this.on })).filter((a) => a.installed);
      setShared(AGENTS, { ...shared(AGENTS), [this.on ?? ""]: this.agents });
      this.choose();
    } catch { this.agents ??= []; this.noAgents = true; }
  }

  chosen() {
    return (this.agents ?? []).filter((a) => this.picks.has(a.key));
  }

  space() {
    const p = props() ?? {};
    if (p.folder && !p.space) return { folder: p.folder, machine: p.machine ?? null, name: "" };
    return spaces().find((s) => s.id === (p.space ?? focused()?.space));
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(cx) {
    if (this.busy || !this.repo) return;
    cx.spawn(async (cx) => this.work(cx));
  }

  async work(cx) {
    if (this.busy || !this.repo) return;
    this.busy = true;
    this.error = "";
    this.errorAt = null;
    cx.notify();
    try { this.error = await this.create(cx); }
    catch (error) { this.error = String(error); }
    this.busy = false;
    if (!this.error) this.close();
    cx.notify();
  }

  // An error that belongs under one of the form's fields.
  fail(field, text) {
    this.errorAt = field;
    return text;
  }

  async create(cx) {
    const title = this.title.trim();
    if (!title) return this.fail("title", "Give the task a title.");
    const branch = this.fields.branch.value().trim() || kebab(title);
    if (!branch) return this.fail("branch", "Type a branch name: the title has no letters or digits to make one from.");
    if (!(await git(this.repo.main, ["check-ref-format", "--branch", branch], this.on)).ok) return this.fail("branch", `"${branch}" is not a valid branch name.`);
    const path = `${ROOT(this.userHome)}/${this.repo.name}/${slug(branch)}`;
    const has = async (ref) => (await git(this.repo.main, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], this.on)).ok;
    let add = ["worktree", "add", path, branch];
    if (!(await has(`refs/heads/${branch}`))) {
      const base = this.fields.base.value().trim() || this.base.value;
      if (!base) return this.fail("base", "Type a base branch: this repository has no default one.");
      // "origin/master" is the remote's branch only while a remote is called origin.
      const remote = this.base.remotes.find((name) => base.startsWith(`${name}/`));
      let start = base;
      if (remote) {
        const fetched = await git(this.repo.main, ["fetch", remote, base.slice(remote.length + 1)], this.on, 600_000);
        if (!(await has(`refs/remotes/${base}`))) return this.fail("base", fetched.err || `There is no ${base}.`);
        if (!fetched.ok) notify({ title: `Couldn't fetch ${base}`, body: "The task starts from the last fetched commit.", level: "warning" });
      } else if (!(await has(base))) return this.fail("base", `There is no branch ${base} to start from.`);
      add = ["worktree", "add", "--no-track", "-b", branch, path, start];
    }
    const r = await git(this.repo.top, add, this.on, 600_000);
    if (!r.ok) return r.err || "git worktree add failed.";
    const p = props();
    const chosen = this.chosen();
    // Nothing chosen is still a terminal: a space has at least one.
    let tabs = p.argv ? [{ name: p.tab, argv: p.argv }] : [...(this.terminal || chosen.length === 0 ? [{ name: p.tab }] : []), ...chosen.map((a) => ({ name: a.name, argv: a.run }))];
    if (this.setup && this.runSetup) {
      const dir = await git(path, ["rev-parse", "--absolute-git-dir"], this.on);
      if (!dir.ok) return dir.err || "git rev-parse failed.";
      const done = `${dir.out}/river-setup`;
      tabs = tabs.map((t, i) => ({ ...t, argv: i === 0 ? ["sh", "-c", RUN_SETUP, "river-setup", `${this.repo.main}/${SETUP}`, this.repo.main, done, ...(t.argv ?? [])] : ["sh", "-c", AFTER_SETUP, "river-setup", done, ...t.argv] }));
    }
    const before = new Set(spaces().map((s) => s.id));
    const [first, ...rest] = tabs;
    run("space.new", { name: title, folder: path, machine: this.on, ...(first.name ? { tab: first.name } : {}), ...(first.argv ? { argv: first.argv } : {}) });
    setShared(DEFAULTS, { ...shared(DEFAULTS), [this.key]: { agents: [...this.picks], terminal: this.terminal } });
    if (rest.length > 0) await this.open(cx, before, path, rest);
    return "";
  }

  // The other tabs of the space just made; its first tab stays the shown one.
  async open(cx, before, folder, tabs) {
    for (let i = 0; i < 40; i++) {
      const s = spaces().find((s) => !before.has(s.id));
      if (s?.tabs?.length) {
        for (const t of tabs) run("tab.new", { space: s.id, folder, name: t.name, argv: t.argv });
        run("tab.select", { id: s.tabs[0].id });
        return;
      }
      await sleep(cx, 100);
    }
    notify({ title: "Only the first tab opened", body: "The new space didn't show up in time for the others.", level: "warning" });
  }

  // An agent tab in the main checkout that writes the setup script with the person.
  configure() {
    const agent = this.chosen()[0] ?? this.agents?.[0];
    if (!agent || !this.repo) return;
    const s = spaces().find((s) => s.id === (props()?.space ?? focused()?.space));
    this.close();
    run("tab.new", { name: "Task setup", ...(s ? { space: s.id } : {}), folder: this.repo.main, argv: agent.run, task: this.setup ? SETUP_UPDATE_TASK : SETUP_TASK });
  }

  key(e, cx) {
    if (e.key === "escape") return this.close();
    if (e.key === "tab") {
      const names = Object.keys(this.fields);
      const at = names.indexOf(this.field);
      this.fields[names[(at + (e.modifiers?.shift ? names.length - 1 : 1)) % names.length]].focus();
      cx.stop_propagation();
    }
  }

  render() {
    const t = theme();
    const r = this.repo;
    const folder = this.folder ? tilde(this.folder, this.userHome ?? "") : "This folder";
    const field = (name, label) =>
      v_flex()
        .gap(4)
        .child(div().text_size(11).text_color(t.dim).child(label))
        .child(Input.new(this.fields[name]).h(32).px(10).items_center().rounded(6).border(1).border_color(at === name ? t.blocked : this.field === name ? t.accent : t.input).bg(t.background).text_color(t.foreground));
    const mark = (on, round) =>
      div().flex_none().size(14).flex().items_center().justify_center().border(1).border_color(on ? t.accent : t.input).bg(t.background).when(round, (el) => el.rounded_full()).when(!round, (el) => el.rounded(3))
        .when(on, (el) => el.child(div().size(6).bg(t.accent).when(round, (el) => el.rounded_full()).when(!round, (el) => el.rounded(1))));
    const choice = (id, on, round, label, pick) =>
      h_flex().id(id).flex_none().h(24).px(6).gap(7).items_center().rounded(5).text_color(!pick ? t.dim : on ? t.foreground : t.muted)
        .when(Boolean(pick), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { pick(); this.picked = true; cx.notify(); }))
        .when(!pick, (el) => el.opacity(0.6))
        .child(mark(on, round))
        .child(label);
    const button = (id, label, primary, act) =>
      div().id(id).flex_none().h(28).px(12).flex().items_center().rounded(6).cursor_pointer().border(1)
        .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.popover).text_color(primary ? t.solid_foreground : t.foreground)
        .when(primary && this.busy, (el) => el.opacity(0.6))
        .hover((s) => s.bg(primary ? t.solid : t.hover))
        .on_click((_e, cx) => act(cx))
        .child(label);
    const at = this.error ? this.errorAt : null;
    const writer = this.chosen()[0] ?? this.agents?.[0];
    const problem = (right) => div().text_size(12).text_color(t.blocked).when(Boolean(right), (el) => el.text_right()).child(this.error);
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(`New task${r ? ` in ${r.name}` : ""}`))
      .when(r === undefined && !this.error, (el) => el.child(div().text_color(t.muted).child("\u2026")))
      .when(r === null, (el) => el.child(div().text_color(t.ansi3).child(`Tasks are based on Git worktrees, so they only work in folders with Git. ${folder} is not in a Git repository.`)))
      .when(Boolean(r), (el) =>
        el
          .child(field("title", "Title"))
          .when(at === "title", (el) => el.child(problem()))
          .child(h_flex().gap(10).items_start().child(field("branch", "Branch").flex_1().min_w(0)).child(field("base", "Base branch").w(170)))
          .when(at === "branch" || at === "base", (el) => el.child(problem(at === "base")))
          .child(
            v_flex()
              .gap(2)
              .child(div().text_size(11).text_color(t.dim).child("Setup command"))
              .child(
                h_flex()
                  .items_center()
                  .child(choice("setup", this.setup && this.runSetup, false, `Run ${SETUP}`, this.setup ? () => { this.runSetup = !this.runSetup; } : null))
                  .child(div().flex_1())
                  .when(Boolean(writer), (el) =>
                    el.child(div().id("setup-configure").px(6).text_size(12).cursor_pointer().text_color(t.accent).hover((s) => s.text_color(t.foreground)).on_click(() => this.configure()).child(`${this.setup ? "Update" : "Write"} it with ${writer?.name}`)),
                  ),
              )
              .child(
                v_flex()
                  .px(6)
                  .gap(1)
                  .text_size(11)
                  .text_color(t.dim)
                  .child(div().child("A task starts in a fresh worktree: only committed files, nothing installed. Use the setup script to:"))
                  .children(SETUP_USES.map((use) => h_flex().gap(5).items_start().child(div().flex_none().child("\u2022")).child(div().child(use)))),
              ),
          )
          .child(
            v_flex()
              .gap(2)
              .child(div().text_size(11).text_color(t.dim).child("Open tabs"))
              .child(
                h_flex()
                  .flex_wrap()
                  .gap(2)
                  .child(choice("terminal", this.terminal, false, "Terminal", () => { this.terminal = !this.terminal; }))
                  .children((this.agents ?? []).map((a) => choice(`agent-${a.key}`, this.picks.has(a.key), false, a.name, () => { if (!this.picks.delete(a.key)) this.picks.add(a.key); })))
                  .when(this.agents === null, (el) => el.child(div().px(6).text_size(11).text_color(t.dim).child("looking for agents\u2026"))),
              )
              .when(Boolean(this.noAgents), (el) => el.child(div().px(6).text_size(11).text_color(t.dim).child("Couldn't list this machine's agents."))),
          )
      )
      .when(Boolean(this.error) && !at, (el) => el.child(problem()))
      .child(div().flex_1())
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(button("cancel", r ? "Cancel" : "Close", false, () => this.close()))
          .child(div().flex_1())
          .when(this.busy, (el) => el.child(div().text_size(11).text_color(t.dim).frames(["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"], 90)))
          .when(Boolean(r), (el) => el.child(button("create", "Create", true, (cx) => this.go(cx)))),
      );
  }
}
