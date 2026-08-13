/**
 * Inline SVG icons for document templates — `it.icons` in an `.eta`.
 *
 * ## Why inline, and why this is the only shape that works
 *
 * Both render paths set Gotenberg's `failOnResourceLoadingFailed=true`, so one
 * failed subresource fetch fails the whole render. Header and footer partials
 * are stricter still: Chromium renders them in an isolated frame that loads
 * **no** external resources at all. So an icon font, a CDN sprite sheet and an
 * `<img src>` are each unusable — inline SVG is what survives, which is why the
 * CFS logo has always been inline.
 *
 * ## Usage
 *
 * The return value is markup, so emit it **raw** (`<%~ %>`, not `<%= %>`):
 *
 * ```eta
 * <%~ it.icons.svg("truck") %>
 * <%~ it.icons.svg("phone", { size: 12, class: "muted" }) %>
 * ```
 *
 * Every interpolated attribute value is escaped here, because `<%~` bypasses
 * Eta's auto-escaping and `title` is the option most likely to be fed from
 * document data.
 *
 * The catalogue is `@cfs/core/utils/_lucide-icons.data.ts` (generated — see
 * `scripts/generate-lucide-icons.ts`). It is a packed string, split into a `Map`
 * on first use, so importing this module without rendering anything costs one
 * string literal and no index build.
 *
 * Measured 2026-08-13 (341 KB, 1,767 icons): **import 1.8–5.7 ms**, **first
 * `svg()` 0.7 ms** (builds the index), then **~1.7 µs per call** (1,000 calls in
 * 1.74 ms). Against a Gotenberg round trip in the hundreds of milliseconds none
 * of this registers — the packed form is about keeping module *parse* to a
 * single string literal rather than 1,767 object properties, not about the
 * per-render cost, which was never in question.
 */
import { LUCIDE_ICON_ALIASES, LUCIDE_ICON_DATA } from "./_lucide-icons.data.ts";

/** Options for {@link svg}. */
export interface IconOptions {
  /** Rendered width/height. A number is treated as px. Default `16`. */
  size?: number | string;
  /** `stroke-width` at the 24×24 viewBox scale. Default `2`. */
  stroke?: number;
  /** Stroke colour. Default `"currentColor"`, so CSS controls it. */
  color?: string;
  /** Extra class names, appended after `lucide lucide-<name>`. */
  class?: string;
  /**
   * Accessible name. When omitted the icon is marked `aria-hidden="true"` —
   * the right default, since an icon beside a label is decorative and
   * announcing it twice is worse than not announcing it.
   */
  title?: string;
}

// ── Catalogue (lazy) ─────────────────────────────────────────────────

let index: Map<string, string> | undefined;

/** Split the packed catalogue on first use; cached thereafter. */
function catalogue(): Map<string, string> {
  if (index) return index;
  const built = new Map<string, string>();
  for (const line of LUCIDE_ICON_DATA.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) built.set(line.slice(0, tab), line.slice(tab + 1));
  }
  index = built;
  return built;
}

/** Canonical name for `name`, following an alias. `undefined` if unknown. */
function resolve(name: string): string | undefined {
  const icons = catalogue();
  if (icons.has(name)) return name;
  const aliased = LUCIDE_ICON_ALIASES[name];
  return aliased && icons.has(aliased) ? aliased : undefined;
}

/**
 * Up to five catalogue names sharing a word with `name` — enough to turn a
 * near-miss into a fix without dumping 1,767 names into a render error.
 */
function suggest(name: string): string[] {
  const words = name.split("-").filter((w) => w.length > 2);
  if (!words.length) return [];
  const hits: string[] = [];
  for (const candidate of catalogue().keys()) {
    if (words.some((w) => candidate.includes(w))) {
      hits.push(candidate);
      if (hits.length === 5) break;
    }
  }
  return hits;
}

// ── Escaping ─────────────────────────────────────────────────────────

/**
 * Escape a value interpolated into a double-quoted SVG attribute.
 *
 * `svg()`'s output is emitted through `<%~ %>`, which bypasses Eta's
 * auto-escaping — so this is the only escaping between a caller-supplied
 * `title` and the rendered document.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape text content (a `<title>` body), where quotes need no escaping. */
function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Inline SVG markup for a lucide icon. Emit raw: `<%~ it.icons.svg("truck") %>`.
 *
 * Throws on an unknown name, listing near matches. That is deliberate: a
 * silently-blank icon is invisible in a PDF and would ship, whereas a render
 * error is caught by the draft render gate and the golden gate before it can.
 * For a name that comes from document data rather than the template author, gate
 * it with {@link has} first.
 */
export function svg(name: string, options: IconOptions = {}): string {
  const canonical = resolve(name);
  if (!canonical) {
    const near = suggest(name);
    throw new Error(
      `Unknown icon "${name}".` +
        (near.length ? ` Did you mean: ${near.join(", ")}?` : "") +
        ` See https://lucide.dev/icons for the full set.`,
    );
  }

  const size = options.size ?? 16;
  const attrs = [
    `xmlns="http://www.w3.org/2000/svg"`,
    `width="${escapeAttr(String(size))}"`,
    `height="${escapeAttr(String(size))}"`,
    `viewBox="0 0 24 24"`,
    `fill="none"`,
    `stroke="${escapeAttr(options.color ?? "currentColor")}"`,
    `stroke-width="${escapeAttr(String(options.stroke ?? 2))}"`,
    `stroke-linecap="round"`,
    `stroke-linejoin="round"`,
    `class="${escapeAttr(`lucide lucide-${canonical}${options.class ? ` ${options.class}` : ""}`)}"`,
  ];

  // A named icon is exposed to assistive tech; an unnamed one is decorative.
  attrs.push(
    options.title ? `role="img"` : `aria-hidden="true"`,
    options.title ? `aria-label="${escapeAttr(options.title)}"` : `focusable="false"`,
  );

  const title = options.title ? `<title>${escapeText(options.title)}</title>` : "";
  return `<svg ${attrs.join(" ")}>${title}${catalogue().get(canonical)}</svg>`;
}

/**
 * Whether `name` is a known icon (following aliases).
 *
 * For data-driven names, where {@link svg} would throw — e.g. an icon chosen by
 * a document field: `<% if (it.icons.has(n)) { %><%~ it.icons.svg(n) %><% } %>`.
 */
export function has(name: string): boolean {
  return resolve(name) !== undefined;
}

/**
 * The CFS logo, inline.
 *
 * Injected into every render as the scalar `it.logo` — templates keep calling
 * it that way, and this is not reachable as `it.icons.*` (the template-helper
 * generator catalogues functions, not constants). It lives here so the render
 * pipeline and the `templates` repo's local preview harness read **one**
 * string: they previously held separate copies, and the preview's copy had a
 * single path where the real logo has five (measured 2026-08-13), so local
 * preview had been rendering a visibly different logo from production with
 * nothing to catch it.
 */
export const CFS_LOGO_SVG: string =
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 44 160 80" fill="currentColor" role="img" aria-label="Chicago Film Supplies logo"><path d="m 46.8,104.95007 c -0.2,1.4 0.7,2.5 2.1,2.5 h 47.5 c 1.4,0 2.7,-1.1 3,-2.5 l 0.3,-1.6 H 47.2 l -0.3,1.6 z"/><path d="m 36.7,106.85007 c -0.6,3.4 -3.9,6.2 -7.3,6.2 -3.4,0 -5.8,-2.8 -5.1,-6.2 0.2,-1 0.6,-2 1.2,-2.9 h -6.9 c -0.4,0.9 -0.7,1.9 -0.8,2.9 -1.2,7.1 3.5,12.8 10.5,12.8 7,0 13.8,-5.7 15,-12.8 0.2,-1 0.2,-2 0.2,-2.9 h -6.9 c 0.3,0.9 0.4,1.8 0.2,2.9 z"/><path d="m 121.1,106.75007 c -0.6,3.4 -3.9,6.2 -7.3,6.2 -3.4,0 -5.8,-2.8 -5.1,-6.2 0.2,-1 0.6,-2 1.2,-2.8 H 103 c -0.4,0.9 -0.6,1.8 -0.8,2.8 -1.2,7.1 3.5,12.8 10.5,12.8 7,0 13.8,-5.7 15,-12.8 0.2,-1 0.2,-1.9 0.2,-2.8 H 121 c 0.3,0.8 0.3,1.8 0.2,2.8 z"/><path d="m 154.9,73.550069 -9.4,-20.1 c -2.2,-5.2 -8.1,-5.1 -16,-5.1 v 0 H 28.9 c -9.8,0 -10.9,2.9 -12.8,7.2 l -6.5,16.1 c -1.1,0.3 -2,1.3 -2.2,2.4 l -4.2,23.5 v 0 c -1.4,0 -2.7,1.1 -3,2.500001 v 0 0.4 c -0.2,1.4 0.7,2.5 2.1,2.5 h 0.1 v 0.4 c 0,1.2 0.1,4.1 3.3,4.1 h 6.4 c 1.4,0 2.7,-1.1 3,-2.5 l 0.6,-3.4 h 116.1 l -0.6,3.4 c -0.2,1.4 0.7,2.5 2.1,2.5 H 147 c 3,0 5.1,-1.7 6.4,-4.5 v 0 c 1.4,0 2.7,-1.1 3,-2.5 v -0.4 c 0.3,-1.100001 -0.3,-2.100001 -1.2,-2.400001 1.4,-5.3 4.7,-17.2 4.7,-17.2 0,-0.2 0.1,-0.5 0.1,-0.7 0.5,-3.4 -1.7,-6.1 -5.1,-6.2 z m -114.1,15.1 -6.4,-1.8 -2.8,6.6 -0.4,-6.6 -7.2,1.7 6.3,-4.8 -4.6,-4.9 6.6,2 2.6,-6.8 0.5,6.8 7,-1.9 -6.1,4.8 4.4,4.9 z m 21.8,0 -6.4,-1.8 -2.8,6.6 -0.4,-6.6 -7.2,1.7 6.3,-4.8 -4.6,-4.9 6.6,2 2.6,-6.8 0.5,6.8 7,-1.9 -6.1,4.8 4.4,4.9 z m 21.7,0 -6.4,-1.8 -2.8,6.6 -0.4,-6.6 -7.2,1.7 6.3,-4.8 -4.6,-4.9 6.6,2 2.6,-6.8 0.5,6.8 7,-1.9 -6.1,4.8 4.4,4.9 z m 21.7,0 -6.4,-1.8 -2.8,6.6 -0.4,-6.6 -7.2,1.7 6.3,-4.8 -4.6,-4.9 6.6,2 2.6,-6.8 0.5,6.8 7,-1.9 -6.1,4.8 4.4,4.9 z m 3.4,-19.8 H 28.7 c -1.8,0 -3.1,-1.2 -3.5,-3.1 l -0.6,-3.4 c 0,-0.5 0.2,-1 0.7,-1.1 v 0 c 0.5,-0.2 1,0 1.1,0.5 l 0.6,3.4 c 0,0.5 0.5,2 2.1,2 h 80.7 c 0.5,0 0.8,0.4 0.7,0.9 -0.1,0.5 -0.6,0.9 -1.1,0.9 z m 9.6,7.9 h -2.8 c -0.4,0.4 -0.9,0.6 -1.4,0.6 -1,0 -1.7,-0.8 -1.5,-1.8 v 0 c 0.2,-1 1.1,-1.8 2.1,-1.8 1,0 1,0.2 1.3,0.6 h 2.8 c 0.7,0 1.1,0.5 1,1.2 -0.1,0.7 -0.7,1.2 -1.4,1.2 z m 26.5,-7.9 h -28.4 c -1.3,0 -2.1,-1.1 -1.9,-2.5 l 1.9,-10.7 c 0.2,-1.4 1.5,-2.5 2.8,-2.5 h 18.2 c 1.4,0 3.1,1.1 3.7,2.5 l 5,10.7 c 0.7,1.4 0,2.5 -1.3,2.5 z"/><path d="m 129.1,54.350069 h -9.5 c -0.5,0 -1.1,0.5 -1.2,1.2 l -0.7,4.1 c 0.2,0.4 0.3,0.7 0.3,1.4 0,1.1 0.1,1.6 -0.3,1.7 -0.3,0.1 -0.5,0 -0.6,0.2 l -0.6,3.3 c -0.1,0.7 0.2,1.2 0.8,1.2 h 7.2 c -0.3,-0.6 -0.6,-1 -0.6,-1.1 -0.9,-2.4 1.4,-1.7 3.7,-2.4 1.5,-0.5 0.9,-1.2 0.8,-1.8 0,-0.5 0.5,-0.5 0.4,-1.4 0,-0.2 1.2,-0.1 0.8,-1 -0.3,-0.6 -0.9,-1.5 -1,-1.8 -0.1,-0.4 -0.1,-0.9 0.5,-1 0.9,-0.3 2.5,-0.3 2.5,-0.9 0,-0.8 -2.3,0.3 -2.5,-1.8 z"/></svg>`;
