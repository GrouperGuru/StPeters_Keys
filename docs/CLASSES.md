# Paper class contract

Consolidated from the implemented modules. `paper.css` must style everything
here. Reference renders: `docs/pg-1.png` … `docs/pg-4.png`.

Font stacks used throughout:

```css
--serif:  'Times New Roman', Times, serif;          /* body copy, most boxes */
--sans:   Verdana, Geneva, sans-serif;              /* masthead tagline */
--script: 'Comic Sans MS', 'Chalkboard SE', 'Segoe Print', cursive;  /* calendar */
```

---

## Shell (owned by flip.js + fit.js — hard dependencies)

```css
#page-stage { position: relative; perspective: 2200px; transform-style: preserve-3d; }

.paper { position: absolute; left: 0; top: 0;
         transform-origin: left center; backface-visibility: hidden;
         overflow: hidden; background: #fff; color: #000; }

/* flip.js MEASURES these — they must stay declared in inches on .paper */
.paper[data-orientation="portrait"]  { width: 8.5in; height: 11in; }
.paper[data-orientation="landscape"] { width: 11in;  height: 8.5in; }

.paper.is-hidden { visibility: hidden; pointer-events: none; }  /* NEVER display:none */

.paper-shade { position: absolute; inset: 0; opacity: 0; pointer-events: none; z-index: 5;
  background: linear-gradient(to right, rgba(0,0,0,.40) 0%, rgba(0,0,0,.10) 28%,
              rgba(255,255,255,.18) 64%, rgba(0,0,0,.06) 100%); }

.paper-flow { /* the padded content box — page margins live here */ }
.fit-inner  { display: block; }   /* fit.js sets font-size on this */
```

Screen-only overflow warning (must be invisible in print):

```css
.is-overflowing { outline: 2px dashed #c0392b; outline-offset: -2px; }
```

Focus highlight for the region bound to the field being edited:

```css
.rt-out.is-target { background: rgba(255,235,59,.38); box-shadow: 0 0 0 2px #fbc02d; }
```

Page margins from the reference: roughly `0.5in` on pages 1–3 and `0.35in` on
page 4 (the calendar runs closer to the trim).

---

## Page 1 & 2 — `nl-*`

| class | styling |
|---|---|
| `.nl-tagline` | Verdana **bold italic**, centred, uppercase, letter-spaced, full content width, wraps to 2 lines |
| `.nl-top` | 2-col grid, main ≈63% / rail ≈37%, gutter ~0.22in, `align-items: start` |
| `.nl-top-main` | `min-width: 0` |
| `.nl-title` | very large heavy condensed sans, centred, uppercase, tight tracking (stands in for the arched WordArt) |
| `.nl-motto` | bold italic serif, centred, ~19pt |
| `.nl-date` | bold serif, centred, ~20pt |
| `.nl-heading` | bold italic serif, centred, uppercase, ~15pt |
| `.nl-verse` | serif, centred, ~9.5pt, `line-height:1.3`, space below |
| `.nl-body` | serif ~10.5pt, **justified**, `p { margin: 0 0 .7em }`, no first-line indent |
| `.nl-sign` | serif ~10.5pt, left, space above |
| `.nl-rail` | flex column, gap ~0.14in, `min-width: 0` |
| `.nl-schoolinfo` | serif ~9pt, left, `line-height:1.25`, flush to rail top |
| `.nl-box` | flex column, gap ~0.04in (title and body are **separately** ruled) |
| `.nl-box-title` | `border:1px solid #000`, bold serif ~12pt, centred, uppercase, padding ~3px |
| `.nl-box-body` | `border:1px solid #000`, padding ~5px, `overflow:hidden`; **needs a definite height for tier-1 fit** — set e.g. `height: 2.45in` on the This Week box and `height: 2.25in` on Looking Ahead (tune to the reference) |
| `.nl-agenda` | `width:100%; border-collapse:collapse`; `td { vertical-align: top; padding: 0 0 .45em }` |
| `.nl-agenda-date` | narrow (~0.42in), `white-space:nowrap`, right padding ~6px |
| `.nl-agenda-event` | fills remaining width |
| `.nl-box-note` | centred **bold** serif, margin-top ~0.28in |
| `.nl-articles` | flex column, gap ~0.24in, margin-top ~0.3in |
| `.nl-article` | `break-inside: avoid` |
| `.nl-article-title` | bold serif, centred, uppercase, ~10.5pt, margin ~0 0 .55em |
| `.nl-article-body` | serif ~10.5pt justified; `p { margin: 0 0 .65em }`; `ul { margin:.4em 0; padding-left: 1.5em; list-style: disc }`; `li { margin-bottom:.3em }`; `.indent { margin: .25em 0 .25em 1.4em }` |

Pages 1 and 2 share `.nl-articles`; page 2 contains only that block.

---

## Page 3 — `slip-*`

Layout: 2 equal columns, ~0.28in gutter, `align-items: start`.

| class | styling |
|---|---|
| `.slip-cols` | 2-col grid, equal, gutter ~0.28in, `align-items:start` |
| `.slip-col` | flex column, row gap ~0.22in |
| `.slip` | `border: 1.5px solid #000`, padding ~0.16in 0.18in, white, `border-radius: 0`, `break-inside: avoid` |
| `.slip--lunch`, `.slip--custom`, `.slip--afterschool` | hooks only |
| `.slip--starburst` | **no border, no padding** (the SVG is the outline) |
| `.slip--unknown` | screen-only dashed red outline (must not print) |
| `.slip-unknown` | small italic centred grey notice |
| `.slip-fit` | plain block. Apply `overflow:hidden` **only** via `.slip-fit[data-fit]` — an unconditional `overflow:hidden` clips the auto-height boxes |
| `.slip-heading` | serif **bold**, centred, ~11pt, `line-height:1.25` |
| `.slip-sub` | inline span inside a heading, **normal weight** |
| `.slip-namerow` | flex row, `align-items:baseline`, gap ~6px, margin ~0.16in 0 |
| `.slip-namerow-label` | serif, non-bold, `white-space:nowrap` |
| `.slip-rule` | `display:inline-block; border-bottom:1px solid #000; height:1em; vertical-align:baseline` — never underscore glyphs |
| `.slip-rule--grow` | `flex:1 1 auto; min-width:1.2in` |
| `.slip-rule--sm` | `width:.55in; flex:0 0 auto` |
| `.slip-rule--md` | `width:.85in; flex:0 0 auto` |
| `.slip-fields` | flex column, row gap ~0.13in |
| `.slip-field` | flex row, `align-items:baseline`, gap 8px |
| `.slip-field--blank-before` | rule then label |
| `.slip-field--blank-after` | label then rule; push the rule right (`margin-left:auto`) |
| `.slip-field--text` | plain full-width line, no rule |
| `.slip-field--inline` | `justify-content:space-between; flex-wrap:wrap; row-gap:6px` |
| `.slip-inline-item` | inline-flex, `align-items:baseline`, gap 6px, `white-space:nowrap` |
| `.slip-inline-text` | serif label piece |
| `.slip-label` | serif ~10pt, `flex:0 1 auto` |
| `.slip-total` | flex row, `justify-content:space-between; align-items:baseline`, margin-top ~0.2in |
| `.slip-total-label` | serif, **non-bold** |
| `.slip-footer` | centred **bold** serif, `line-height:1.25`, margin-top ~0.16in |
| `.slip-body` | serif ~10pt; `p { margin:.4em 0 }`; pass `u`/`i` through |
| `.slip-table` | `border-collapse:collapse`; `td{vertical-align:top;padding:0 8px 2px 0}`; first col `white-space:nowrap` |
| `.slip-days`, `.slip-table`, `.slip-center`, `.slip-sub` | **legacy** — these arrive as *user content* inside a `custom` box's body, not from slips.js. Scope them under `.paper` so they cannot reach the editor's contenteditable fields. The After School box now uses the generated `.slip-as-*` grid instead. |
| `.slip-center` | `text-align:center` |
| `.slip-as-rates` | centred rate block, `line-height:1.2` |
| `.slip-as-notes` | left-aligned note line |
| `.slip-as-terms` | 2-col rate/policy table, `border-collapse:collapse`, `td{vertical-align:top}` |
| `.slip-as-term` | narrow label column (~1.05in), right-padded |
| `.slip-as-termval` | detail column, takes the remainder |
| `.slip-as-student` | one Name line + hours grid, `break-inside:avoid` |
| `.slip-as-days` | the hours grid. **`table-layout:fixed` is load-bearing** — it makes every weekday column equal width regardless of heading text, which is what keeps the rules and XXX markers aligned |
| `.slip-as-rowlabel` | narrow leading cell holding `Hrs.`, `white-space:nowrap` |
| `.slip-as-dayname` | weekday heading, centred, `white-space:nowrap` |
| `.slip-as-dayrow` | the hours row |
| `.slip-as-daycell` | a weekday cell, `vertical-align:bottom` |
| `.slip-as-daycell--xxx` | the XXX marker, `vertical-align:baseline` |
| `.slip-rule--xs` | the short hours blank; `width:100%` so it fills its table cell |
| `.slip-burst` | `position:relative; aspect-ratio: 1.25/1; display:grid; place-items:center` |
| `.slip-burst-svg` | `position:absolute; inset:0; width:100%; height:100%` |
| `.slip-burst-star` | `fill:#fff; stroke:#000; stroke-width:2; vector-effect:non-scaling-stroke` |
| `.slip-burst-text` | `position:relative; z-index:1`, centred **bold** serif, `max-width:56%`, `line-height:1.2` |

---

## Page 4 — `cal-*`

**Load-bearing for the fit engine:** `.cal-week { flex:1; min-height:0 }` and
`.cal-cell { overflow:hidden; min-height:0 }`. Without a definite cell height,
every calendar cell measures auto and the fit pass silently does nothing.

| class | styling |
|---|---|
| `.cal-sheet` | `display:flex; flex-direction:column; height:100%` |
| `.cal-head` | grid `auto 1fr auto`, `align-items:center`, gap ~0.10in, margin-bottom ~0.12in |
| `.cal-logo` | ~0.85in square, `display:flex; align-items:center`, thin 1px light-grey frame |
| `.cal-logo-svg` | `width:100%; height:auto; display:block` |
| `.cal-titlebox` | `border:3px solid #000`, padding ~0.06in, flex row, `align-items:center`, gap ~.18in, `overflow:hidden` |
| `.cal-month` | large light sans (Arial family), ~34–40pt, uppercase, slight tracking, `white-space:nowrap` |
| `.cal-ident` | flex column, centred, `flex:1`, `min-width:0` |
| `.cal-schoolname` | script stack, bold, ~11pt, centred |
| `.cal-website` | script stack, bold, ~11pt, centred |
| `.cal-contact` | serif ~6.5pt, left, `line-height:1.25`, top-aligned, `max-width:2.1in` |
| `.cal-grid` | `flex:1; display:flex; flex-direction:column; border:1px solid #000; border-bottom:none; min-height:0` |
| `.cal-dayrow` | `display:grid; grid-template-columns:repeat(7,1fr); border-bottom:1px solid #000; flex:0 0 auto` |
| `.cal-dayname` | serif ~12pt, centred, padding ~0.04in 0 (reference shows no vertical rules through the header) |
| `.cal-week` | `display:grid; grid-template-columns:repeat(7,1fr); flex:1 1 0; min-height:0; border-bottom:1px solid #000` |
| `.cal-cell` | `position:relative; overflow:hidden; min-height:0; padding:.03in .04in; border-right:1px solid #000` (`:last-child` none); `text-align:center` |
| `.cal-cell--blank` | empty ruled cell, no extra chrome |
| `.cal-daynum` | script stack, **bold**, ~2.6em, `line-height:1`, centred, margin-bottom ~.02in |
| `.cal-events` | script stack, ~1em, `line-height:1.15`, centred, `word-wrap:break-word` |

Optional per-density tuning: `.cal-grid[data-weeks="6"] .cal-daynum { font-size: 2.2em }`,
`.cal-grid[data-weeks="4"] .cal-daynum { font-size: 3em }`.

---

## print.css requirements

`flip.js` sets inline styles, so print rules **must** use `!important`:

```css
@page { size: letter portrait; margin: 0; }
@page landscape { size: letter landscape; margin: 0; }
.paper[data-orientation="landscape"] { page: landscape; }

#page-stage { transform:none !important; width:auto !important; height:auto !important;
              perspective:none !important; }
#stage-sizer, #stage-viewport { width:auto !important; height:auto !important;
              overflow:visible !important; padding:0 !important; }
.paper { position:static !important; visibility:visible !important;
         transform:none !important; box-shadow:none !important;
         break-after: page; }
.paper-shade { display:none !important; }
.is-overflowing { outline:none !important; }
.rt-out.is-target { background:none !important; box-shadow:none !important; }
```

Plus: hide `#toolbar`, `#editor-pane`, `#rail-resizer`, `#thumb-rail`, `#toasts`;
reset `#app`/`#workspace` to plain block flow; last page must not emit a trailing
blank sheet (`.paper:last-child { break-after: auto }`).
