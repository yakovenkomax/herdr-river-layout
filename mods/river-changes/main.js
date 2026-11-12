// Uncommitted changes of the selected worktree: a file list for the sidebar, and with
// props { role: "file", file, on } one file in a tab's pane, read-only, with its uncommitted
// changes shown in place.
// Line comments are kept in shared state and sent to the space's agent from the list.

import { View } from "gpui-kit";
import { props } from "herdr";

import { DiffView } from "./diff.js";
import { Sidebar } from "./sidebar.js";
import { announceViewer } from "./store.js";

export default class TaskChanges extends View {
  init(_props, cx) {
    announceViewer();
    this.part = props()?.role === "file" ? new DiffView() : new Sidebar();
    this.part.init(cx);
  }

  render(cx) {
    return this.part.render(cx);
  }

  async close(cx) {
    this.part.close?.(cx);
  }
}
