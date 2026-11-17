// Workspace spaces: a project is a lettered icon in its color with its tasks (worktrees)
// under it; a task whose project isn't open is listed above the projects. Grouped by
// machine when more than one is known. A selected space unfolds its branch and agents;
// the others show their agents as status dots. Click to switch, right-click for its
// menu, drag to reorder.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, agents, setAgentOrder, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, pickFolder, nextCommand, home } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// A space's root: the folder it was made in, the base of the tasks listed under it.
// Only a space made in the home folder follows its first terminal instead.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  if (s.folder && s.folder !== home()) return s.folder;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree, on }) => (tree ? 32 : 34) - (on ? SELECTED_TRIM : 0);
const SELECTED_TRIM = 4;
const BRANCH_HEIGHT = 15;
const AGENT_HEIGHT = 30;
// Selecting a space unfolds its branch and agents; heights and opacity animate natively.
const UNFOLD = { duration: 160, easing: "ease-out" };
const FOLDER_GAP = 12;
const RAIL_CELL = 32;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// { [space id]: theme color name }, written by river-space-menu. No entry: the default grey.
const COLORS = "river.space-colors";
const DEFAULT_COLOR = "dim";

function letterIcon(name) {
  const first = [...name.normalize("NFKD")][0]?.toLowerCase() ?? "";
  return /^[a-z]$/.test(first) ? `mods/river-spaces/icons/letters/${first}.svg` : "mods/river-spaces/icons/circle-dot.svg";
}

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

// A task is labelled by its title, the space's name. One nobody named shows its
// branch until titleTasks() has named it so.
function label({ w, g, tree }) {
  return tree && !w.named && g?.branch ? g.branch : w.name;
}

// Agents are drawn under their space here, as the agents list draws them (mods/agents),
// so the layout needs no agents block.
const clean = (text) => (text ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function tabTitle(tab, lead) {
  const program = lead?.program?.name;
  const live = clean(lead?.title);
  const telling = live && live !== program && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== lead?.program?.key;
  return (tab.name === program || !tab.named) && telling ? live : tab.name;
}

function duration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function agentIcon(program, size, color) {
  if (!program?.icon) return null;
  return program.tint ? svg(program.icon).size(size).flex_none().text_color(color) : image(program.icon).w(size).h(size).flex_none();
}

// The agents list held the rail's way back on macOS, where the traffic lights fill the brand row.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// A new space on this computer starts in a picked folder and is named after it. The folder a
// space was made in stays its own: the Changes list, the Project panel and Find in Files use it.
async function newSpace() {
  const folder = await pickFolder({ prompt: "Open project" });
  if (folder) run("space.new", { folder, name: base(folder), machine: "" });
}

function newTask(w) {
  openOverlay({ mod: "river-create-task", kind: "dialog", width: 600, height: 454, props: { space: w.id } });
}


export default class Spaces extends View {
  init(_props, cx) {
    cx.spawn(async () => {
      for (;;) if ((await nextCommand()) === "new-space") await newSpace();
    });
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.titled = new Set();
    this.pressed = null;
    this.over = null;
    this.hovered = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // Each agent's last state and when it changed (ms), for the time beside it.
    this.agentChanged = JSON.parse(localStorage.getItem("agents.changed") ?? "{}");
    cx.timer.every(30000, (cx) => cx.notify());
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const ps = panes();
    const due = this.due(now, sp, ps);
    if (due.size) this.refreshGit(due, cx);
    this.titleTasks(sp, ps);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // A task nobody named gets its branch as its title, once: the name stays after that.
  titleTasks(sp, ps) {
    for (const s of sp) {
      const g = this.git[where(s, ps)];
      if (s.named || this.titled.has(s.id) || !g?.linked || !g.branch) continue;
      this.titled.add(s.id);
      run("space.rename", { id: s.id, name: g.branch });
    }
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu({ w, tree }) {
    openOverlay({ mod: "river-space-menu", kind: "popup", width: 412, height: 170, frame: "none", props: { kind: tree ? "task" : "project", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    // A task whose project isn't open: listed before the projects of its machine
    // (space.move stays inside a machine's block).
    const orphan = (r) => Boolean(r.g?.linked) && !mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const m of new Set(list.map((r) => r.w.machine ?? null))) {
      const mine = list.filter((r) => (r.w.machine ?? null) === m);
      for (const r of mine) if (orphan(r)) out.push({ ...r, tree: "orphan" });
      for (const r of mine) {
        if (nested(r) || orphan(r)) continue;
        out.push({ ...r, tree: null });
        if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
        placed.add(r.g.repo);
        for (const k of list) if (nested(k) && k.g.repo === r.g.repo) out.push({ ...k, tree: "nested" });
      }
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // Done and idle count as one state: looking at a finished agent turns done into idle.
  trackAgents(list, now) {
    let dirty = false;
    for (const a of list) {
      const state = a.status === "done" ? "idle" : a.status;
      if (this.agentChanged[a.address]?.s === state) continue;
      this.agentChanged[a.address] = { s: state, at: now };
      dirty = true;
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    for (const [address, change] of Object.entries(this.agentChanged)) if (!listed.has(address) && now - change.at > 30 * 86400000) delete this.agentChanged[address];
    localStorage.setItem("agents.changed", JSON.stringify(this.agentChanged));
  }

  agentStatus(t, a) {
    if (a.status === "working") return svg("mods/river-spaces/icons/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? (t.done ?? t.dim) : t.dim + "00");
  }

  statusDot(t, a) {
    if (a.status === "working") return svg("mods/river-spaces/icons/spinner.svg").size(11).flex_none().text_color(t.working).spin(900);
    if (a.status === "idle") return div().size(7).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).flex_none().rounded(4).bg(t[a.status] ?? t.dim);
  }

  agentRow(a, tree, t, context) {
    const picture = agentIcon(a.program, 12, t.foreground);
    const when = this.agentChanged[a.address]?.at ?? 0;
    const isResting = a.status === "idle" && !a.focused;
    return h_flex()
      .id(`space-agent-${a.address}`)
      .pl(tree === "nested" ? 54 : 34)
      .pr(8)
      .h(AGENT_HEIGHT)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(8)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
      .when(Boolean(picture), (el) => el.child(picture))
      .child(div().flex_1().min_w(0).truncate().text_color(isResting ? t.muted : t.foreground).child(context.name(a)))
      .when(Boolean(when), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(context.now - when))))
      .child(this.agentStatus(t, a));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const list = agents(), now = Date.now();
    this.trackAgents(list, now);
    const leads = leadPanes(panes());
    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const name = (a) => {
      const tab = tabs.get(a.tab), many = tabCounts.get(a.tab) > 1;
      const text = tab ? tabTitle(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "");
      return /^\d+$/.test(text) ? a.program?.name || text : text;
    };
    const mineOf = (w) => list.filter((a) => a.space === w.id);
    setAgentOrder(rows.flatMap((r) => mineOf(r.w).map((a) => a.address)));
    // A space and its agents share one selection background. It shows its agents
    // as rows only while selected, as dots on its own row otherwise.
    const first = new Map();
    for (const r of rows) if (!first.has(r.w.machine ?? null)) first.set(r.w.machine ?? null, r.w.id);
    const draw = (r) => {
      if (collapsed) return [this.compact(r, t)];
      const mine = mineOf(r.w);
      const apart = !r.tree && first.get(r.w.machine ?? null) !== r.w.id;
      return [v_flex().flex_none().rounded(8).when(apart, (el) => el.mt(FOLDER_GAP)).when(r.w.active, (el) => el.bg(t.selected))
        .child(this.row(r, t, mine))
        .child(v_flex().id(`space-agents-${r.w.id}`).flex_none().h(r.w.active ? mine.length * AGENT_HEIGHT : 0).transition("height", UNFOLD).overflow_hidden()
          .children(mine.map((a) => this.agentRow(a, r.tree, t, { name, now }))))];
    };
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.flatMap(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const icon = svg(`mods/river-spaces/icons/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); if (m) run("space.new", { machine: m }); else cx.spawn(newSpace); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/river-spaces/icons/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { if (m) run("space.new", { machine: m }); else cx.spawn(newSpace); })
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`Open project on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/river-spaces/icons/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/river-spaces/icons/plus.svg").size(12)).child("Open project there"));
      if (!collapsed && rebuilt) return [head];
      const cell = collapsed ? railCell : (el) => el;
      return [cell(head), ...(folded ? [] : mine.length ? mine.flatMap(draw) : [loading(m) ? loadingRow(m) : cell(empty)])];
    });
  }

  row({ w, i, g, tree }, t, mine) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const color = t[shared(COLORS)?.[w.id]] ?? t[DEFAULT_COLOR];
    const dots = !on && mine.length > 0;
    const branch = g?.branch;
    const base = rowHeight({ tree, on });
    const nested = tree === "nested";
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(base + (on && branch ? BRANCH_HEIGHT : 0))
      .transition("height", UNFOLD)
      .overflow_hidden()
      .flex_none()
      .rounded(8)
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_hover((hovered, cx) => {
        const next = hovered ? w.id : this.hovered === w.id ? null : this.hovered;
        if (next === this.hovered) return;
        this.hovered = next;
        cx.notify();
      })
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.pressedOrphan = tree === "orphan";
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        // Orphan tasks stay above the projects: they only trade places among themselves.
        const over = source && (source.machine ?? null) === (w.machine ?? null) && this.pressedOrphan === (tree === "orphan") ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu({ w, tree }); })
      .child(
        h_flex()
          .id(`space-title-${w.id}`)
          .h(base)
          .transition("height", UNFOLD)
          .flex_none()
          .gap(8)
          .items_center()
          .when(Boolean(tree), el => el.pl(nested ? 26 : 3).child(svg("mods/river-spaces/icons/diamond.svg").size(12).flex_none().when(!nested, (icon) => icon.mr(3)).text_color(color)))
          .when(!tree, el => el.child(svg(letterIcon(w.name)).size(18).flex_none().text_color(color)))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(label({ w, g, tree })))
          .when(tree === "orphan", (el) => el.child(div().flex_none().max_w(110).truncate().text_size(11.5).text_color(t.dim).child(g.name)))
          .when(!tree, (el) => el.child(
            div().id(`space-task-${w.id}`).size(20).when(this.hovered !== w.id, (b) => b.invisible()).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim)
              .tooltip("New task")
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { cx.stop_propagation(); newTask(w); })
              .child(svg("mods/river-spaces/icons/plus.svg").size(12)),
          ))
          // Each dot sits in a box as wide as an agent row's status, so the two line up.
          .when(dots, (el) => el.child(h_flex().flex_none().gap(2).items_center().children(mine.map((a) => h_flex().w(14).flex_none().justify_center().child(this.statusDot(t, a)))))),
      )
      .when(Boolean(branch), (el) => el.child(
        div().id(`space-branch-${w.id}`).absolute().left(8 + (nested ? 46 : 26)).right(8).top(base - 8 + SELECTED_TRIM / 2).truncate().text_size(11.5).text_color(t.dim)
          .opacity(on ? 1 : 0).transition("opacity", UNFOLD).child(branch),
      ));
  }

  compact({ w, i }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pt(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .on_mouse_down("right", () => openOverlay({ mod: "river-space-menu", kind: "popup", width: 412, height: 170, frame: "none", props: { kind: "empty" } }))
        .children(this.grouped(t, collapsed)))
      .when(collapsed, (el) => el.child(h_flex().h(28).flex_none().items_center().justify_center()
        .child(div().id("collapse").text_size(13).text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_click(toggleSidebar).child("»"))));
  }
}
