// The space's right-click menu (Herdr's items plus "Change icon…") and the icon
// dialog. Both are this mod opened as an overlay: props { mode: "menu" | "icon", space }.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, run, props, openOverlay, closeOverlay, theme, keys, exec, shared, setShared } from "herdr";
import { listCandidates, materialize, chooseFile } from "./icons.js";

const MOD = "spaces-icons";
// What people picked, by space id: false for the letter, a path (on the space's machine) for a file.
export const CHOICE = "spaces-icons.choice";
const MAX_SHOWN = 12;
// The tile behind an icon, by space id: "none", a #hex, or a palette name. Default white.
export const TILE = "spaces-icons.tile";
// Herdr's avatar colors (as in its spaces and picker mods), then the extra tile choices.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const TILES = ["none", "#ffffff", "#1f2329", ...Object.keys(MARK)];
const LETTERS = Object.keys(MARK);

function hex(c, t) {
  return c.startsWith("#") ? c : (MARK[c] ?? t[c] ?? "#ffffff");
}

// The tile color to draw behind a space's icon, or null for none.
export function tileOf(id, t) {
  const c = (shared(TILE) ?? {})[id] ?? "#ffffff";
  return c === "none" ? null : hex(c, t);
}

function setIn(key, id, value) {
  setShared(key, { ...(shared(key) ?? {}), [id]: value });
}

export function choiceOf(id) {
  return (shared(CHOICE) ?? {})[id];
}

function setChoice(id, value) {
  const all = { ...(shared(CHOICE) ?? {}) };
  if (value === undefined) delete all[id];
  else all[id] = value;
  setShared(CHOICE, all);
}

export function openMenu(space) {
  openOverlay({ mod: MOD, kind: "popup", width: 210, height: 300, props: { mode: "menu", space } });
}

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((t) => t.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const [top, common] = await Promise.all([
    exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd: folder, on }),
    exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on }),
  ]);
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

function menuItems(id, git) {
  return [
    ["Rename", "space.rename", { id }, "square-pen"],
    ["Change icon…", "icon", { space: id }, "layers"],
    ...(git ? [["New worktree", "worktree", { space: id, action: "new" }, "git-branch"], ["Open worktree", "worktree", { space: id, action: "open" }, "git-branch"]] : []),
    ...(git === "linked" ? [["Remove worktree", "worktree", { space: id, action: "remove" }, "git-branch"]] : []),
    ["Close", "space.close", { id }, "x"],
  ];
}

function shortcut(name, args) {
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export function initOverlay(v, cx) {
  const p = props() ?? {};
  v.mode = p.mode;
  v.spaceId = p.space;
  v.at = 0;
  v.git = null;
  v.found = null;
  v.root = null;
  v.waiting = false;
  v.handle = cx.focus_handle();
  v.handle.focus();
  const s = spaces().find((x) => x.id === v.spaceId);
  if (!s) return;
  const folder = place(s);
  if (v.mode === "menu" && folder) {
    cx.spawn(async (cx) => {
      v.git = await checkout(folder, s.machine).catch(() => null);
      cx.notify();
    });
  }
  if (v.mode === "icon") {
    cx.spawn(async (cx) => {
      try {
        const { root, list } = await listCandidates(folder, s.machine ?? null);
        v.root = root;
        v.found = [];
        v.more = Math.max(0, list.length - MAX_SHOWN);
        for (const c of list.slice(0, MAX_SHOWN)) {
          const rel = await materialize(s.machine ?? null, c.path, c.stamp).catch(() => null);
          if (rel) v.found.push({ rel, path: c.path, name: c.rel });
          cx.notify();
        }
      } catch {
        v.found = [];
      }
      cx.notify();
    });
  }
}

function close() {
  closeOverlay(props()?.overlay);
}

function chooseItem(v, i) {
  const it = menuItems(v.spaceId, v.git)[i];
  if (!it) return;
  close();
  if (it[1] === "icon") openOverlay({ mod: MOD, kind: "dialog", width: 470, height: 470, props: { mode: "icon", space: v.spaceId } });
  else if (it[1] === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
  else run(it[1], it[2]);
}

function renderMenu(v, t) {
  const list = menuItems(v.spaceId, v.git);
  return v_flex()
    .id("spaces-icons-menu")
    .track_focus(v.handle)
    .w_full()
    .min_h(0)
    .p(5)
    .bg(t.popover)
    .text_size(12.8)
    .on_key_down((e, cx) => {
      if (e.key === "down") v.at = (v.at + 1) % list.length;
      else if (e.key === "up") v.at = (v.at + list.length - 1) % list.length;
      else if (e.key === "enter") chooseItem(v, v.at);
      else if (e.key === "escape") close();
      else return;
      cx.notify();
    })
    .children(list.map((it, i) =>
      v_flex()
        .when(i > 0 && it[1] === "space.close", (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex()
          .id(`sim-${i}`)
          .h(31)
          .px(8)
          .gap(9)
          .rounded(7)
          .items_center()
          .text_color(t.foreground)
          .when(i === v.at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => chooseItem(v, i))
          .child(svg(`mods/workspace-chrome/${it[3]}.svg`).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().child(it[0]))
          .child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2]))))));
}

function button(id, label, t, onClick, primary = false) {
  return div()
    .id(id)
    .px(12)
    .py(5)
    .rounded(6)
    .cursor_pointer()
    .text_size(12)
    .text_color(primary ? t.foreground : t.muted)
    .bg(primary ? t.selected : t.raised ?? t.hover)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click(onClick)
    .child(label);
}

function renderIcon(v, t, cx) {
  const s = spaces().find((x) => x.id === v.spaceId);
  if (!s) return div().p(16).child("This space is gone.");
  const chosen = choiceOf(s.id);
  const current = chosen === false ? "Letter" : typeof chosen === "string" ? chosen.split("/").pop() : "Automatic";
  const pick = (value) => { setChoice(s.id, value); close(); };
  const tile = tileOf(s.id, t);
  // The color row follows what the sidebar shows: the tile behind an icon, else the letter's color.
  const showsIcon = chosen !== false && Boolean((shared("space.icons") ?? {})[s.id]);
  const colorNow = showsIcon ? ((shared(TILE) ?? {})[s.id] ?? "#ffffff") : ((shared("space.colors") ?? {})[s.id] ?? "ansi6");
  const swatch = (c, i) => div()
    .id(`sis-${i}`)
    .size(22)
    .rounded(6)
    .cursor_pointer()
    .border_2()
    .border_color(c === colorNow ? t.accent : t.popover)
    .child(c === "none"
      ? h_flex().size_full().rounded(4).border_1().border_color(t.border).items_center().justify_center().child(svg("mods/workspace-chrome/x.svg").size(11).text_color(t.dim))
      : div().size_full().rounded(4).bg(hex(c, t)).when(c === "#ffffff" || c === "#1f2329", (el) => el.border_1().border_color(t.border)))
    .tooltip(c === "none" ? "No tile" : c === "#ffffff" ? "White" : c === "#1f2329" ? "Dark" : "Herdr color")
    .on_click((_e, cx) => { setIn(showsIcon ? TILE : "space.colors", s.id, c); cx.notify(); });
  const colors = h_flex().gap(4).items_center()
    .child(div().w(78).flex_none().text_color(t.dim).child(showsIcon ? "Background" : "Letter color"))
    .children((showsIcon ? TILES : LETTERS).map(swatch));
  const grid = v.found === null
    ? div().text_color(t.dim).child("Looking for icons…")
    : v.found.length === 0
      ? div().text_color(t.dim).child(v.root ? "No icons found in this project." : "This space has no project folder to look in.")
      : h_flex().flex_wrap().gap(8).children(v.found.map((c, i) => v_flex()
          .id(`sic-${i}`)
          .w(96)
          .p(6)
          .gap(5)
          .items_center()
          .rounded(8)
          .border_1()
          .border_color(chosen === c.path ? t.accent : t.popover)
          .cursor_pointer()
          .hover((st) => st.bg(t.hover))
          .tooltip(c.name)
          .on_click(() => pick(c.path))
          .child(h_flex().size(40).rounded(8).overflow_hidden().when(Boolean(tile), (b) => b.bg(tile)).items_center().justify_center().child(image(c.rel).size(tile ? 32 : 40)))
          .child(div().w_full().text_size(10.5).text_color(t.muted).truncate().child(c.name.split("/").pop()))));
  return v_flex()
    .id("spaces-icons-picker")
    .track_focus(v.handle)
    .size_full()
    .min_h(0)
    .p(16)
    .gap(12)
    .bg(t.popover)
    .text_size(12.5)
    .text_color(t.foreground)
    .on_key_down((e) => { if (e.key === "escape") close(); })
    .child(v_flex().gap(3)
      .child(div().text_size(14).font_semibold().child(`Icon for ${s.name}`))
      .child(div().text_color(t.dim).child(`Now: ${current}. Click an icon to use it.`)))
    .child(v_flex().flex_1().min_h(0).id("sic-scroll").overflow_y_scroll().child(grid)
      .when(Boolean(v.more), (el) => el.child(div().pt(8).text_size(11).text_color(t.dim).child(`${v.more} more not shown. Use Choose file… for them.`))))
    .child(colors)
    .child(h_flex().gap(8).items_center()
      .child(button("sib-auto", "Automatic", t, () => pick(undefined), chosen === undefined))
      .child(button("sib-letter", "Letter", t, () => pick(false), chosen === false))
      .when(!s.machine, (el) => el.child(button("sib-file", v.waiting ? "Waiting…" : "Choose file…", t, (_e, cx) => {
        if (v.waiting) return;
        v.waiting = true;
        cx.notify();
        cx.spawn(async (cx) => {
          const path = await chooseFile(v.root ?? place(s), s.name);
          v.waiting = false;
          if (path) pick(path);
          else cx.notify();
        });
      })))
      .child(div().flex_1())
      .child(button("sib-cancel", "Cancel", t, () => close())));
}

export function renderOverlay(v, cx) {
  const t = theme();
  return v.mode === "icon" ? renderIcon(v, t, cx) : renderMenu(v, t);
}
