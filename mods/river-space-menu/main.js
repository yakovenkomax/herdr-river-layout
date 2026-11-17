// The sidebar's right-click menus, opened as a frameless popup with props
// { kind: "project" | "task" | "empty", target: { id } }.
// The popup is wider than the menu: the colors open beside it, in the same popup.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, focused, shared, setShared } from "herdr";

// { [space id]: theme color name }, read by river-spaces. No entry: the default, SWATCHES[0].
const COLORS = "river.space-colors";
const SWATCHES = ["dim", "ansi1", "ansi2", "ansi3", "ansi4", "ansi5", "ansi6"];
const ROW = 31;
const icon = (name) => `mods/river-space-menu/icons/${name}.svg`;

function items(p) {
  if (p?.kind === "empty") return [{ label: "Open project", icon: "plus", act: () => run("river-spaces.new-space") }];
  const id = p?.target?.id ?? focused()?.space;
  const task = p?.kind === "task";
  return [
    ...(!task ? [{ label: "New task", icon: "plus", act: () => openOverlay({ mod: "river-create-task", kind: "dialog", width: 600, height: 454, props: { space: id } }) }] : []),
    { label: "Rename", icon: "square-pen", act: () => run("space.rename", { id }) },
    { label: "Icon color", icon: "palette", colors: true },
    { label: `Close ${task ? "task" : "project"}`, icon: "x", line: true, act: () => openOverlay({ mod: "river-close", kind: "dialog", width: 460, height: 280, props: { space: id, kind: task ? "task" : "project" } }) },
  ];
}

export default class SpaceMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.open = false;
    this.swatch = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  space() {
    return props()?.target?.id ?? focused()?.space;
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  choose(i) {
    const it = items(props())[i];
    if (!it) return;
    if (it.colors) {
      this.open = true;
      this.swatch = Math.max(0, SWATCHES.indexOf(this.color()));
      return;
    }
    this.close();
    it.act();
  }

  color() {
    return shared(COLORS)?.[this.space()] ?? SWATCHES[0];
  }

  paint(name) {
    const all = { ...shared(COLORS) };
    if (name === SWATCHES[0]) delete all[this.space()];
    else all[this.space()] = name;
    setShared(COLORS, all);
    this.close();
  }

  key(e, cx) {
    const list = items(props());
    if (this.open && (e.key === "left" || e.key === "right")) this.swatch = (this.swatch + (e.key === "right" ? 1 : SWATCHES.length - 1)) % SWATCHES.length;
    else if (this.open && e.key === "enter") this.paint(SWATCHES[this.swatch]);
    else if (this.open && e.key === "escape") this.open = false;
    else if (e.key === "down" || e.key === "up") {
      this.at = (this.at + (e.key === "down" ? 1 : list.length - 1)) % list.length;
      this.open = false;
    } else if (e.key === "enter" || (e.key === "right" && list[this.at]?.colors)) this.choose(this.at);
    else if (e.key === "escape") this.close();
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  card(t) {
    return v_flex().flex_none().p(5).rounded(10).border(1).border_color(t.border).bg(t.popover).shadow_lg();
  }

  swatches(t) {
    const current = this.color();
    return this.card(t).child(
      h_flex().h(ROW).px(4).gap(4).items_center().children(
        SWATCHES.map((name, i) =>
          div()
            .id(`swatch-${name}`)
            .size(22)
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .border(1.5)
            .border_color(name === current ? t.foreground : t.popover)
            .when(i === this.swatch, (el) => el.bg(t.selected))
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_hover((hovered, cx) => { if (hovered && this.swatch !== i) { this.swatch = i; cx.notify(); } })
            .on_click(() => this.paint(name))
            .child(div().size(14).rounded_full().bg(t[name])),
        ),
      ),
    );
  }

  render() {
    const t = theme();
    const list = items(props());
    const colorsAt = list.findIndex((it) => it.colors);
    return h_flex()
      .id("space-menu")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .items_start()
      .gap(4)
      .text_size(12.8)
      .child(
        this.card(t).w(200).children(
          list.map((it, i) =>
            v_flex()
              .when(Boolean(it.line), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
              .child(
                h_flex()
                  .id(`mi-${i}`)
                  .h(ROW)
                  .px(8)
                  .gap(9)
                  .rounded(7)
                  .items_center()
                  .text_color(t.foreground)
                  .when(i === this.at, (el) => el.bg(t.selected))
                  .hover((s) => s.bg(t.hover))
                  .on_hover((hovered, cx) => {
                    if (!hovered) return;
                    this.at = i;
                    this.open = Boolean(it.colors);
                    cx.notify();
                  })
                  .on_click((_e, cx) => { this.choose(i); cx.notify(); })
                  .child(svg(icon(it.icon)).size(14).flex_none().text_color(t.muted))
                  .child(div().flex_1().child(it.label))
                  .when(Boolean(it.colors), (el) => el.child(svg(icon("chevron-right")).size(12).flex_none().text_color(t.dim))),
              ),
          ),
        ),
      )
      .when(this.open && colorsAt >= 0, (el) => el.child(div().pt(colorsAt * ROW).child(this.swatches(t))));
  }
}
