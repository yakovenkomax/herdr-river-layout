# River

A Herdr app layout for working on one task per worktree: a space, a terminal and an agent per task, a diff view of the agent's uncommitted changes with line comments, and one message that sends the comments back to the agent.

## Structure

The repository is laid out like the Herdr app home (`~/.config/herdr-app`), so the layout and each mod can be copied or split off as they are.

| Path | What it is | Origin |
|---|---|---|
| `layouts/river.json` | the layout | clone of Herdr's `main` |
| `mods/river-changes` | Changes list, file tabs with diff, comments and highlighting | own |
| `mods/river-create-task` | new-task dialog: title, branch, worktree, setup script, agent, terminal | clone of Herdr's `worktree` |
| `mods/river-close` | close-task and close-project dialog: optionally deletes worktrees and branches, warns about unpushed work | from Herdr's `worktree` |
| `mods/river-spaces` | sidebar: projects with their tasks and agents; a new project starts in a picked folder | clone of Herdr's `spaces` |
| `mods/river-space-menu` | the sidebar's right-click menus: new task, rename, icon color, close; new project on the empty area | from Herdr's `menu` |
| `mods/river-tabs` | tab bar | tab bar of herdr-annotator by jakub-tucek, itself from Herdr's `tabs` |
| `mods/river-pane` | pane title bar | clone of Herdr's `pane` |
| `mods/river-chrome` | top bar | clone of Herdr's `workspace-chrome` |
| `mods/river-files` | Project panel (file tree) | Files Plus by linziyanleo, edited |
| `mods/river-find` | Find in Files dialog | Find in Files by napalmpapalam, edited |
| `keys.json` | key bindings to merge into the one in the Herdr app home | own |
| `programs.json` | program looks to merge into the one in the Herdr app home: Claude as an orange asterisk (the icon is in `mods/river-spaces/icons`) | own |

Every mod keeps its icons in `icons/`, third-party code in `vendor/` and the licences of what it borrows in `licenses/`. No mod loads a file from another mod's folder; Herdr does not allow importing code across mod folders.

## How the mods work together

No mod names another mod. They meet through shared-state keys; the first three any file viewer can provide:

| Key | Value | Written by | Read by |
|---|---|---|---|
| `river.viewer` | name of the mod that shows files | the viewer (`river-changes`) | `river-files`, `river-find` |
| `river.views` | `{ [pane id]: { file, on, hasChanges } }`, one entry per open file tab | the viewer | `river-tabs`, `river-pane`, `river-files` |
| `river.diff-mode` | `"unified"` or `"split"` | `river-pane` | the viewer |
| `river.space-colors` | `{ [space id]: theme color name }`, the color of a space's icon; no entry is the default grey (`dim`) | `river-space-menu` | `river-spaces` |
| `river.task-agents` | `{ [machine]: agents }`, the installed agents each machine last reported | `river-create-task` | `river-create-task` |
| `river.task-defaults` | `{ [machine + main checkout]: { agents, terminal } }`, the last new-task choice per project | `river-create-task` | `river-create-task` |

A file is opened with `tab.new { mod: <river.viewer>, props: { role: "file", file, root, on } }`.

Without a viewer, `river-files` opens files in its own preview and `river-find` opens them in `$EDITOR`; the tab bar and pane header show no file icon or view toggle.

A space's root is the folder it was made in (`spaces()[i].folder`): `river-changes`, `river-files` and `river-find` all use it. Only a space made in the home folder follows its terminals instead.

## Tasks

A task is a space on its own git worktree, named by its title; the sidebar lists it under the space of the repository's main checkout, matched by each space's root folder. The `+` on that space's row opens the new-task dialog for it; `cmd-shift-n` opens it for the focused space. Tasks need a git repository; a remote is optional.

- **Branch**: the title in kebab-case unless typed. A branch that exists is checked out; a new one starts from the base.
- **Base branch**: prefilled with the default remote's default branch (`origin/master`), else `init.defaultBranch`, `main` or `master` there or here, else the current branch. A base that begins with a remote's name is fetched first; if the fetch fails, the last fetched commit is used. Anything else is taken as a local branch.
- **Setup command**: if the main checkout has `.river/setup.sh`, it runs in the new worktree in the first tab, with `$RIVER_MAIN` set to the main checkout; agents in the other tabs wait for it. If it fails, the tabs stay on a shell. Without the script, the dialog offers to have an agent write it.
- **Open tabs**: a terminal and any of the installed agents (from `knownAgents()`, so `programs.json` decides how each runs), one tab each, the terminal first. With nothing chosen the space still gets a terminal. The choice is remembered per project.

Checkouts go to `~/.herdr/worktrees/<repo>/<branch>`.

Closing a task (its right-click menu) asks whether to delete its worktree and branch too; the box starts ticked unless that would lose uncommitted changes, commits that are on no remote and no other branch, or unpushed submodule commits, which it lists. Closing a project leaves its folder alone, closes its open tasks with it and can delete their worktrees and branches the same way. The same dialog replaces Herdr's own confirmation when a space's last tab or pane is closed from the tab bar, the pane header or `cmd-w` / `cmd-shift-w` (the `layout:river` section of `keys.json`). A space closed another way (its last program exiting, the command palette) skips it, so a task whose project is closed is listed above the projects until the project is opened again.

Other requirements: `river-changes` colours code with Shiki through Node (`mods/river-changes/shiki`), and `river-find` needs ripgrep.

## Working on it

Herdr does not hot-reload a mod through a symlink, so the live copy stays in the Herdr app home and this repository is synced with it:

```sh
scripts/sync.sh pull      # Herdr app home -> repository, before committing
scripts/sync.sh install   # repository -> Herdr app home
```

`install` also runs `npm install` in `mods/river-changes/shiki`. Merge `keys.json` and `programs.json` by hand.
