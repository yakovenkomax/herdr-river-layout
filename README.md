# River

A Herdr app layout for working on one task per worktree: a space, a terminal and an agent per task, a diff view of the agent's uncommitted changes with line comments, and one message that sends the comments back to the agent.

## Structure

The repository is laid out like the Herdr app home (`~/.config/herdr-app`), so the layout and each mod can be copied or split off as they are.

| Path | What it is | Origin |
|---|---|---|
| `layouts/river.json` | the layout | clone of Herdr's `main` |
| `mods/river-changes` | Changes list, file tabs with diff, comments and highlighting | own |
| `mods/river-create-task` | new-task dialog: worktree, setup command, agent | clone of Herdr's `worktree` |
| `mods/river-spaces` | sidebar: spaces with their agents | clone of Herdr's `spaces` |
| `mods/river-tabs` | tab bar | tab bar of herdr-annotator by jakub-tucek, itself from Herdr's `tabs` |
| `mods/river-pane` | pane title bar | clone of Herdr's `pane` |
| `mods/river-chrome` | top bar | clone of Herdr's `workspace-chrome` |
| `mods/river-files` | Project panel (file tree) | Files Plus by linziyanleo, edited |
| `mods/river-find` | Find in Files dialog | Find in Files by napalmpapalam, edited |
| `keys.json` | key bindings to merge into the one in the Herdr app home | own |

Every mod keeps its icons in `icons/`, third-party code in `vendor/` and the licences of what it borrows in `licenses/`. No mod loads a file from another mod's folder; Herdr does not allow importing code across mod folders.

## How the mods work together

No mod names another mod. They meet through three shared-state keys, which any file viewer can provide:

| Key | Value | Written by | Read by |
|---|---|---|---|
| `river.viewer` | name of the mod that shows files | the viewer (`river-changes`) | `river-files`, `river-find` |
| `river.views` | `{ [pane id]: { file, on, hasChanges } }`, one entry per open file tab | the viewer | `river-tabs`, `river-pane`, `river-files` |
| `river.diff-mode` | `"unified"` or `"split"` | `river-pane` | the viewer |

A file is opened with `tab.new { mod: <river.viewer>, props: { role: "file", file, root, on } }`.

Without a viewer, `river-files` opens files in its own preview and `river-find` opens them in `$EDITOR`; the tab bar and pane header show no file icon or view toggle.

Other requirements: `river-changes` colours code with Shiki through Node (`mods/river-changes/shiki`), and `river-find` needs ripgrep.

## Working on it

Herdr does not hot-reload a mod through a symlink, so the live copy stays in the Herdr app home and this repository is synced with it:

```sh
scripts/sync.sh pull      # Herdr app home -> repository, before committing
scripts/sync.sh install   # repository -> Herdr app home
```

`install` also runs `npm install` in `mods/river-changes/shiki`. Merge `keys.json` by hand.
