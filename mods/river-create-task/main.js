// Task dialog: { space, action: "new" | "open" | "remove" } or
// { folder, machine } for a repo without a space; optional { title, branch, tab, argv }.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, home, focused, knownAgents, readTextFile, shared, setShared, notify } from "herdr";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, all = panes()) {
  if (!s) return null;
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
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

// Every checkout of a repo (`git worktree list`), the main one first, then
// the most recently committed: { path, branch, main, at }.
async function checkouts(repo, on) {
  const list = await git(repo.main, ["worktree", "list", "--porcelain"], on);
  if (!list.ok) return [];
  const refs = await git(repo.main, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], on);
  const when = new Map(refs.out.split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
  const out = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, branch, main: out.length === 0, at: branch ? (when.get(branch) ?? 0) : 0 });
  }
  return out.sort((a, b) => b.main - a.main || b.at - a.at);
}

// The space showing a checkout: its first terminal is in it (the deepest checkout wins).
function spaceOf(path, all, on, spaceList, paneList) {
  const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
  return spaceList.find((s) => (s.machine ?? null) === (on ?? null) && (() => {
    const at = place(s, paneList)?.replace(/\\/g, "/");
    if (!at || !inside(at, path)) return false;
    return !all.some((c) => c.path !== path && c.path.length > path.length && inside(at, c.path));
  })());
}

async function git(cwd, args, on, timeout) {
  const r = await exec("git", args, { cwd, on, ...(timeout === undefined ? {} : { timeout }) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The submodule repos git keeps for a checkout (nested ones too, checked out
// or not): { name, dir, pinned }. `config` is the args that read its
// .gitmodules; `pinned` is the commit its parent records ("" if none).
async function modules(gitDir, config, on, out = [], parent = "") {
  const keys = await git(gitDir, ["--git-dir", gitDir, "config", ...config, "-z", "--get-regexp", "^submodule\\..*\\.path$"], on);
  if (!keys.ok) return out; // no .gitmodules, or no submodules in it
  // -z: "key\nvalue" records ended by NUL, so names and paths may hold spaces.
  for (const record of keys.out.split("\0").filter(Boolean)) {
    const at = record.indexOf("\n");
    const name = record.slice("submodule.".length, at - ".path".length);
    const dir = `${gitDir}/modules/${name}`;
    if (!(await git(gitDir, ["--git-dir", dir, "rev-parse", "--git-dir"], on)).ok) continue; // never checked out
    const pinned = await git(gitDir, ["--git-dir", gitDir, "rev-parse", `HEAD:${record.slice(at + 1)}`], on);
    // Names are only unique within their parent: nested ones carry its name.
    out.push({ name: parent + name, dir, pinned: pinned.ok ? pinned.out : "" });
    if ((await git(gitDir, ["--git-dir", dir, "cat-file", "-e", "HEAD:.gitmodules"], on)).ok) await modules(dir, ["--blob", "HEAD:.gitmodules"], on, out, `${parent + name}/`);
  }
  return out;
}

// The worktree's submodules, and the names of those with commits that exist
// nowhere else: not on a remote, and not the commit the parent pins (git
// fetches that by hash, so it is often on no remote branch here).
async function submodules(top, on) {
  const gitDir = await git(top, ["rev-parse", "--absolute-git-dir"], on);
  if (!gitDir.ok) throw new Error(gitDir.err || "git rev-parse failed.");
  const mods = await modules(gitDir.out, ["--file", `${top}/.gitmodules`], on);
  const unpushed = [];
  for (const m of mods) {
    const local = await git(gitDir.out, ["--git-dir", m.dir, "rev-list", "-n1", "--all", "--not", "--remotes", ...(m.pinned ? [m.pinned] : [])], on);
    if (!local.ok) throw new Error(local.err || `Couldn't check submodule ${m.name}.`);
    if (local.out) unpushed.push(m.name);
  }
  return { mods, unpushed };
}

// The repo a folder belongs to: its main checkout and name, and whether
// the folder is itself a linked worktree. null outside git.
async function repoOf(folder, on) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, name: main.split("/").pop(), linked: main !== top.out };
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
    this.opening = props()?.action === "open";
    this.creating = !this.opening && props()?.action !== "remove";
    this.text = props()?.branch ?? "";
    this.list = undefined; // open: the checkouts, once read
    this.at = 0;
    this.input = InputState.new({ value: this.text, placeholder: this.opening ? "filter worktrees" : "branch name" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    if (this.creating) this.form(cx);
    else if (this.opening) {
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
    }
    this.busy = false;
    this.error = "";
    this.repo = undefined; // undefined: looking, null: not in git
    this.dirty = false;
    this.unpushed = [];
    this.handle = cx.focus_handle();
    if (props()?.action === "remove") this.handle.focus();
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
        // The repo is set last: Enter does nothing until the warnings it consents to are known.
        const repo = await repoOf(this.folder, this.on);
        if (repo && props().action === "remove") {
          this.dirty = (await git(repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on)).out !== "";
          this.unpushed = (await submodules(repo.top, this.on)).unpushed;
        }
        if (repo && this.opening) this.list = await checkouts(repo, this.on);
        if (repo && this.creating) await this.project(repo);
        this.repo = repo;
        cx.notify();
        if (repo && this.creating) cx.spawn(async (cx) => { await this.installed(); cx.notify(); });
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
    return spaces().find((s) => s.id === (p.space ?? focused()?.space)) ?? (p.folder ? { folder: p.folder, machine: p.machine ?? null, name: "" } : undefined);
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
    try { this.error = props().action === "remove" ? await this.remove() : await this.create(cx); }
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

  shown() {
    const f = this.text.trim().toLowerCase();
    return (this.list ?? []).filter((c) => !f || `${c.branch ?? ""} ${c.path}`.toLowerCase().includes(f));
  }

  open(c) {
    if (!c) return;
    this.close();
    const s = spaceOf(c.path, this.list, this.on, spaces(), panes());
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: c.path, machine: this.on });
  }

  async remove() {
    const s = this.space();
    const status = await git(this.repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on);
    if (!status.ok) return status.err || "git status failed.";
    // git refuses a worktree with submodules unless forced, because their
    // history goes with it. The popup already showed what's at risk; only
    // risk that appeared since it opened gets one more warning.
    const { mods, unpushed } = await submodules(this.repo.top, this.on);
    const changed = (status.out && !this.dirty) || unpushed.some((name) => !this.unpushed.includes(name));
    this.dirty ||= status.out !== "";
    this.unpushed = [...new Set([...this.unpushed, ...unpushed])];
    if (changed) return "It changed since this opened. Enter again removes it anyway.";
    // Terminals first: a shell sitting in the folder keeps it busy on Windows.
    run("space.close", { id: s.id, confirmed: true });
    const force = this.dirty || mods.length > 0;
    const r = await git(this.repo.main, ["worktree", "remove", ...(force ? ["--force"] : []), this.repo.top], this.on, 600_000);
    return r.ok ? "" : r.err || "git worktree remove failed.";
  }

  key(e, cx) {
    if (e.key === "escape") return this.close();
    if (this.opening) {
      const n = this.shown().length;
      if (e.key === "enter") this.open(this.shown()[this.at]);
      else if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    if (e.key === "enter" && props()?.action === "remove") return this.go(cx);
    if (e.key === "tab" && this.creating) {
      const names = Object.keys(this.fields);
      const at = names.indexOf(this.field);
      this.fields[names[(at + (e.modifiers?.shift ? names.length - 1 : 1)) % names.length]].focus();
      cx.stop_propagation();
    }
  }

  renderNew(t) {
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
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(`Tasks need a git repository: each one works on its own branch in its own worktree. ${folder} is not in one.`)))
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

  renderOpen(t) {
    const r = this.repo;
    const rows = this.shown();
    const all = this.list ?? [];
    const spaceList = spaces();
    const paneList = panes();
    const row = (c, i) => {
      const on = i === this.at;
      const there = spaceOf(c.path, all, this.on, spaceList, paneList);
      return v_flex()
        .id(`wt-${i}`)
        .flex_none()
        .h(44)
        .px(10)
        .justify_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => this.open(c))
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.branch ?? "detached"))
            .when(c.main, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("main checkout")))
            .when(Boolean(there), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("open")))
            .when(!there && c.at > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(c.at)))),
        )
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(tilde(c.path, this.userHome ?? "")));
    };
    const count = rows.length === all.length ? `${all.length} checkouts` : `${rows.length}/${all.length} checkouts`;
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().child(div().flex_1().font_semibold().text_color(t.foreground).child(`Open worktree${r ? ` of ${r.name}` : ""}`)).child(div().text_size(11).text_color(t.dim).child(r ? count : "")))
      .when(r === undefined || (r && this.list === undefined), (el) => el.child(div().text_color(t.muted).child("\u2026")))
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${this.folder ? tilde(this.folder, this.userHome ?? "") : "This folder"} is not in a git repository.`)))
      .when(Boolean(r && this.list), (el) =>
        el
          .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
          .child(
            div()
              .relative()
              .flex_1()
              .min_h(0)
              .child(
                v_flex()
                  .id("wt-list")
                  .size_full()
                  .overflow_y_scroll()
                  .children(rows.map(row))
                  .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child("No matching worktrees."))),
              )
              .child(Scrollbar.vertical("wt-list").absolute().inset_0()),
          ),
      )
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("\u2191\u2193 choose \u00b7 \u21b5 open \u00b7 esc close"));
  }

  render(cx) {
    const t = theme();
    if (this.opening) return this.renderOpen(t);
    if (this.creating) return this.renderNew(t);
    const s = this.space();
    const r = this.repo;
    const title = `Remove worktree ${s?.name ?? ""}?`;
    const detail =
      r === undefined
        ? "\u2026"
        : r === null
          ? `${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a git repository.`
          : !r.linked
            ? "This is the repository's main checkout, not a worktree."
            : `Closes the space and deletes ${tilde(r.top, this.userHome)}. The branch stays.`;
    const blocked = !r || !r.linked;
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(title))
      .child(div().text_color(t.muted).child(detail))
      .when(this.dirty, (el) => el.child(div().text_color(t.blocked).child("It has uncommitted changes: they will be lost.")))
      .when(this.unpushed.length > 0, (el) => el.child(div().text_color(t.blocked).child(`Submodule ${this.unpushed.join(", ")} has commits that aren't pushed anywhere: they will be lost.`)))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(
        h_flex()
          .justify_end()
          .text_size(11)
          .text_color(t.dim)
          .gap(6)
          .when(this.busy, (el) => el.child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
          .child(this.busy ? "working…" : blocked ? "esc close" : "↵ remove · esc cancel"),
      );
  }
}
