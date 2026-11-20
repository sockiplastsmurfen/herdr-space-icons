// Space icons: looks for a favicon, app icon or logo in each space's project
// (its git top, else its folder) and keeps a copy under the app home, where
// image() can draw it. Spaces without one keep their letter and color.
//
// Overrides, by space name, in mods/spaces-icons/icons.json:
//   { "my-shop": "web/themes/custom/shop/logo.svg", "dotfiles": false }
// A path is relative to the project (or absolute); false keeps the letter.

import { exec, appHome, readTextFile } from "herdr";

const DIR = "data/spaces-icons";
const MAX_BYTES = 512 * 1024;
// Looked at again this often, so a new or changed favicon shows up.
export const RESCAN = 10 * 60 * 1000;

// Prints the project's root on the first line, then "mtime size path" for each
// candidate in the usual web roots and custom themes. No deep search: bounded,
// and never run in the home folder itself.
const SCAN = `
root=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || root=$1
[ -n "$root" ] && [ "$root" != "$HOME" ] && [ "$root" != / ] || exit 0
cd "$root" 2>/dev/null || exit 0
printf '%s\\n' "$root"
for d in . web public wwwroot docroot html static assets assets/icons assets/images assets/img images img \\
  src/assets src/public app app/public src/app resources/public \\
  web/themes/custom/* wwwroot/themes/custom/* docroot/themes/custom/* \\
  web/themes/custom/*/favicon web/themes/custom/*/images wwwroot/themes/custom/*/favicon \\
  wp-content/themes/* wp-content/themes/*/assets/images wp-content/themes/*/images \\
  web/app/themes/* web/app/themes/*/assets/images public/wp-content/themes/*; do
  [ -d "$d" ] || continue
  for f in "$d"/*; do
    case "\${f##*/}" in
      favicon*.svg|favicon*.png|favicon.ico|icon.svg|icon.png|apple-touch-icon*.png|apple-icon*.png|android-chrome-*.png|logo.svg|logo.png)
        [ -f "$f" ] && [ -s "$f" ] || continue
        s=$(stat -c '%Y %s' "$f" 2>/dev/null || stat -f '%m %z' "$f" 2>/dev/null) || continue
        printf '%s %s\\n' "$s" "\${f#./}" ;;
    esac
  done
done
`;

// Width / height of a cached image (svg: its viewBox or size), or null if unknown.
async function aspect(rel) {
  const out = `${appHome()}/${rel}`;
  if (rel.endsWith(".svg")) {
    const text = (await readTextFile(out)) ?? "";
    const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? "";
    const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
    const w = vb ? vb[1] : /\bwidth\s*=\s*["']([\d.]+)/i.exec(tag)?.[1];
    const h = vb ? vb[2] : /\bheight\s*=\s*["']([\d.]+)/i.exec(tag)?.[1];
    return w && h && Number(h) > 0 ? Number(w) / Number(h) : null;
  }
  const r = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", out]).catch(() => ({ stdout: "" }));
  const w = /pixelWidth: (\d+)/.exec(r.stdout)?.[1], h = /pixelHeight: (\d+)/.exec(r.stdout)?.[1];
  return w && h && Number(h) > 0 ? Number(w) / Number(h) : null;
}
// A wide logo is unreadable at 18 px: the letter says more.
const squarish = (ratio) => ratio === null || (ratio >= 0.67 && ratio <= 1.5);

// Square, larger and made for small sizes first; a theme's logo last (often wide).
function score(path) {
  const name = path.split("/").pop().toLowerCase();
  let s;
  if (name === "favicon.svg" || name === "icon.svg") s = 100;
  else if (name.startsWith("apple-touch-icon") || name.startsWith("apple-icon")) s = 90;
  else if (name.startsWith("android-chrome-")) s = 88;
  else if (/^favicon.*\.svg$/.test(name)) s = 86;
  else if (/^favicon-(96|128|192|256)/.test(name)) s = 85;
  else if (name === "icon.png") s = 82;
  else if (/^favicon-32/.test(name)) s = 80;
  else if (name === "favicon.png") s = 78;
  else if (name === "favicon.ico") s = 70;
  else if (/^favicon/.test(name)) s = 60;
  else if (name === "logo.svg") s = 40;
  else if (name === "logo.png") s = 35;
  else return -1;
  // The site's own web root beats a theme's copy; deeper is less likely the site's.
  if (/\/themes\//.test(path)) s -= 5;
  return s - path.split("/").length * 0.1;
}

function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

let overrides = null;
let overridesAt = 0;
async function readOverrides() {
  if (overrides && Date.now() - overridesAt < 5000) return overrides;
  overridesAt = Date.now();
  try {
    const text = await readTextFile(`${appHome()}/mods/spaces-icons/icons.json`);
    overrides = text ? JSON.parse(text) : {};
  } catch {
    overrides = {};
  }
  return overrides;
}

// A copy of `path` (on machine `on`) under the app home, as a path image() takes,
// or null if it couldn't be made. .ico becomes .png (sips, macOS only).
export async function materialize(on, path, stamp) {
  const ext = path.toLowerCase().split(".").pop();
  const outExt = ext === "ico" ? "png" : ext;
  const rel = `${DIR}/${hash(`${on ?? ""}|${path}|${stamp}`)}.${outExt}`;
  const out = `${appHome()}/${rel}`;
  if ((await exec("test", ["-s", out])).code === 0) return rel;
  await exec("mkdir", ["-p", `${appHome()}/${DIR}`]);
  const tmp = `${out}.tmp.${ext}`;
  let r;
  if (!on) {
    r = await exec("cp", [path, tmp]);
  } else {
    // Another machine: its bytes come back as base64 and are decoded here.
    const b = await exec("base64", [path], { on });
    if (b.code !== 0) return null;
    r = await exec("sh", ["-c", 'printf %s "$1" | base64 -d > "$2"', "sh", b.stdout.replace(/\s+/g, ""), tmp]);
  }
  if (r.code !== 0) return null;
  if (ext === "ico") {
    // sips is macOS's; elsewhere an .ico is skipped and the next candidate tried.
    r = await exec("sips", ["-s", "format", "png", tmp, "--out", out]).catch(() => ({ code: 1 }));
    await exec("rm", ["-f", tmp]);
  } else {
    r = await exec("mv", [tmp, out]);
  }
  return r.code === 0 ? rel : null;
}

// The project's root and its candidates, best first: { root, list: [{ path, rel, stamp }] }.
// Wide ones included: a person choosing may want them.
export async function listCandidates(folder, on) {
  if (!folder) return { root: null, list: [] };
  const r = await exec("sh", ["-c", SCAN, "sh", folder], { on, timeout: 15000 });
  if (r.code !== 0 || !r.stdout) return { root: null, list: [] };
  const [root, ...lines] = r.stdout.split("\n").filter(Boolean);
  const list = lines
    .map((l) => {
      const m = /^(\d+) (\d+) (.+)$/.exec(l);
      return m && { stamp: `${m[1]} ${m[2]}`, size: Number(m[2]), rel: m[3], path: `${root}/${m[3]}` };
    })
    .filter((c) => c && c.size <= MAX_BYTES && score(c.rel) >= 0)
    .sort((a, b) => score(b.rel) - score(a.rel));
  return { root, list };
}

async function stampOf(on, path) {
  const st = await exec("sh", ["-c", "stat -c '%Y %s' \"$1\" 2>/dev/null || stat -f '%m %z' \"$1\"", "sh", path], { on });
  return st.code === 0 ? st.stdout.trim() : null;
}

// A chosen file (an absolute path on machine `on`) as a path image() takes, or null.
export async function useFile(on, path) {
  const stamp = await stampOf(on, path);
  return stamp ? materialize(on, path, stamp) : null;
}

// The icon for a space at `folder` on machine `on`: a path under the app home,
// or null for the letter and color. `choice`: what the person picked in the
// space's menu (false: the letter, a path: that file), else icons.json, else the best found.
export async function findIcon(name, folder, on, choice) {
  if (choice === false) return null;
  if (typeof choice === "string" && choice) {
    const rel = await useFile(on, choice);
    if (rel) return rel;
  }
  if (!folder) return null;
  const o = (await readOverrides())[name];
  if (o === false) return null;
  const { root, list } = await listCandidates(folder, on);
  if (!root) return null;
  if (typeof o === "string" && o) {
    const rel = await useFile(on, o.startsWith("/") ? o : `${root}/${o}`);
    if (rel) return rel;
  }
  for (const c of list.slice(0, 4)) {
    const rel = await materialize(on, c.path, c.stamp);
    if (rel && squarish(await aspect(rel))) return rel;
  }
  return null;
}

// The system's file dialog for an image, on this Mac, starting in `folder`.
// Resolves with the chosen path, or null (cancelled, or not macOS).
const CHOOSE = `on run argv
  activate
  set f to choose file with prompt "Choose an icon for " & item 2 of argv of type {"public.image", "public.svg-image", "com.microsoft.ico"} default location (POSIX file (item 1 of argv))
  return POSIX path of f
end run`;
export async function chooseFile(folder, name) {
  const r = await exec("osascript", ["-e", CHOOSE, folder || "/", name], { timeout: 600000 }).catch(() => null);
  return r && r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
