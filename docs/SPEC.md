# St. Peter's Keys — Implementation Contract

Authoritative interface spec. **Every module must conform exactly.** Class names,
attribute names and function signatures below are load-bearing — other modules
depend on them by string.

## 0. Ground rules

- **Vanilla JS, classic scripts, no build step, no `type="module"`.** The app must
  work when `index.html` is opened over `file://`. ES modules are blocked by CORS
  on `file://` — do not use `import`/`export`.
- **No external network requests.** No CDN fonts, no CDN libraries. Everything
  ships in-repo.
- Every module attaches itself to the `window.Keys` namespace:
  `Keys.State`, `Keys.Fit`, `Keys.Flip`, `Keys.Calendar`, `Keys.Slips`,
  `Keys.Render`, `Keys.Editor`, `Keys.App`.
- Script load order (already wired in `index.html`):
  `state.js → fit.js → flip.js → calendar.js → slips.js → render.js → editor.js → app.js`
  A module may reference another module's functions **only inside functions that
  run after `DOMContentLoaded`**, never at top level.
- Target: current Chrome/Edge/Safari/Firefox. `document.execCommand` is used for
  rich text (deprecated but still the only practical option for this job).

## 1. Data model

`assets/js/state.js` is the source of truth — **read it before writing code.**
Key API:

```js
Keys.State.doc                  // the live document object
Keys.State.get(path)            // "thisWeek.rows.0.date"  -> value
Keys.State.set(path, value)     // writes, marks dirty
Keys.State.uid(prefix)          // unique id string
Keys.State.defaultDoc()         // pristine seed document
```

Paths are dot-delimited with numeric array indices. All user text is an **HTML
string**.

## 2. Two-way binding contract

This is the core mechanism. There are exactly two kinds of participating element.

**Editor side** (left pane, user types here):

```html
<div class="rt" contenteditable="true" data-path="masthead.title" data-page="1"></div>
```

- `class="rt"` — marks it as a rich-text editor field.
- `data-path` — where the value lives in the document.
- `data-page` — which preview page (1–4) this field affects. Focusing the field
  navigates the preview to that page.
- Single-line variants add `data-single="true"` (Enter is suppressed).
- Plain (non-rich) inputs use `<input class="pt" data-path="...">` or
  `<select class="pt" data-path="...">`; their value is stored as-is.

**Preview side** (right pane, the paper):

```html
<div class="rt-out" data-bind="masthead.title"></div>
```

- `data-bind` must equal the editor field's `data-path`.
- Multiple `[data-bind]` nodes may share one path; all are updated.

**Derived preview regions** — `data-edits`:

```html
<div class="cal-month" data-edits="calendar.month">JUNE 2026</div>
```

Some regions display no single stored value: the calendar's month/year title is
computed from `calendar.month` + `calendar.year`, so it has no `data-bind` and
receives no pushes. It instead carries `data-edits="<path>"`, naming the field
that clicking it should jump to. Rules:

- `data-edits` participates in click-to-edit only; it is never written to.
- It takes priority over `data-bind` on the same element.
- The path must resolve to a real `[data-path]` field, or the click reports
  "not editable" — `tools/verify.js` asserts every `data-bind` **and**
  `data-edits` has an editor counterpart.
- It gets the same pointer cursor and hover wash as a bound region, so it reads
  as clickable.

Use it whenever a region on the paper is generated rather than transcribed.

`Keys.Editor` owns the wiring. On `input` in an `.rt` field it:
1. `Keys.State.set(path, el.innerHTML)`
2. writes that HTML into every `[data-bind="<path>"]`
3. calls `Keys.Fit.refitFor(previewNode)`
4. schedules an autosave

**Never re-render the editor pane while the user is typing** — it destroys the
caret. Editor rebuilds happen only on *structural* change (add/remove a row,
slip, or article; change calendar month). Use:

```js
Keys.App.structuralChange(function () { /* mutate Keys.State.doc */ });
```

which mutates, then re-renders editor + preview, restores focus, and refits.

## 3. Page geometry

Trim sizes come from the reference PDF (`docs/pg-1..4.png`):

| Page | Content | Orientation | Size |
|---|---|---|---|
| 1 | Masthead, Classroom Corner, This Week, Looking Ahead, articles | portrait | 8.5in × 11in |
| 2 | Full-width article sections | portrait | 8.5in × 11in |
| 3 | Lunch slips / sign-up boxes (2 columns) | portrait | 8.5in × 11in |
| 4 | Monthly calendar | **landscape** | 11in × 8.5in |

Paper markup — **produced by `render.js`, styled by `paper.css`**:

```html
<div class="paper" data-page="1" data-orientation="portrait" data-fit-page>
  <div class="paper-flow">   <!-- the fittable content flow -->
     ...page content...
  </div>
</div>
```

- `.paper` has an exact physical size and `overflow: hidden`. Nothing may ever
  escape it.
- `.paper-flow` is the padded content box (page margins live here).
- Page 4 uses `data-orientation="landscape"`.

### 3b. Page 1 & 2 markup (emitted by `render.js` — fixed, style against this)

```html
<div class="paper" data-page="1" data-orientation="portrait" data-fit-page>
  <div class="paper-flow">

    <div class="nl-tagline rt-out" data-bind="masthead.tagline"></div>

    <div class="nl-top">
      <div class="nl-top-main">
        <div class="nl-title rt-out"    data-bind="masthead.title"></div>
        <div class="nl-motto rt-out"    data-bind="masthead.motto"></div>
        <div class="nl-date rt-out"     data-bind="masthead.date"></div>
        <div class="nl-heading rt-out"  data-bind="masthead.sectionHeading"></div>
        <div class="nl-verse rt-out"    data-bind="classroom.verse"></div>
        <div class="nl-body rt-out"     data-bind="classroom.body"></div>
        <div class="nl-sign rt-out"     data-bind="classroom.signature"></div>
      </div>

      <aside class="nl-rail">
        <div class="nl-schoolinfo rt-out" data-bind="masthead.schoolInfo"></div>

        <section class="nl-box">
          <div class="nl-box-title rt-out" data-bind="thisWeek.heading"></div>
          <div class="nl-box-body fit" data-fit data-fit-max="10" data-fit-min="5">
            <div class="fit-inner">
              <table class="nl-agenda">
                <tbody>
                  <tr>
                    <td class="nl-agenda-date rt-out"  data-bind="thisWeek.rows.0.date"></td>
                    <td class="nl-agenda-event rt-out" data-bind="thisWeek.rows.0.event"></td>
                  </tr>
                  <!-- one <tr> per row -->
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section class="nl-box">
          <div class="nl-box-title rt-out" data-bind="lookingAhead.heading"></div>
          <div class="nl-box-body fit" data-fit data-fit-max="10" data-fit-min="5">
            <div class="fit-inner">
              <table class="nl-agenda"><tbody><!-- rows --></tbody></table>
              <div class="nl-box-note rt-out" data-bind="lookingAhead.note"></div>
            </div>
          </div>
        </section>
      </aside>
    </div>

    <div class="nl-articles">
      <article class="nl-article">
        <div class="nl-article-title rt-out" data-bind="articles.page1.0.title"></div>
        <div class="nl-article-body rt-out"  data-bind="articles.page1.0.body"></div>
      </article>
      <!-- one <article> per entry -->
    </div>

  </div>
</div>
```

Page 2 is the same `.paper` shell containing only
`<div class="nl-articles">` built from `articles.page2`.

Styling notes drawn from `docs/pg-1.png` / `docs/pg-2.png`:

- Body copy: Times New Roman, ~10.5pt, **justified**, generous paragraph spacing,
  no first-line indent.
- `.nl-tagline`: Verdana **bold italic**, centred, uppercase, letter-spaced,
  spans the full content width, wraps to two lines.
- `.nl-title`: very large heavy condensed sans, centred in the main column,
  uppercase, tight letter-spacing. (The original is arched WordArt; a flat
  heavyweight treatment is the intended substitute — do not attempt per-letter
  arching, it breaks rich-text editing.)
- `.nl-motto`: bold italic serif, centred. `.nl-date`: bold serif, centred,
  larger. `.nl-heading`: bold italic serif, centred, uppercase.
- `.nl-verse`: centred, serif, slightly smaller than body.
- `.nl-top` is a 2-column grid, main ≈ 63%, rail ≈ 37%, with a gutter.
- `.nl-schoolinfo`: serif ~9pt, left-aligned, sits flush to the top of the rail.
- `.nl-box-title` and `.nl-box-body` are **separately** ruled boxes (1px black
  border) with a small vertical gap between them — matching the reference.
  Titles are bold serif, centred, uppercase.
- `.nl-agenda`: 2-column table; date column narrow, right-padded, `vertical-align: top`.
- `.nl-box-note`: centred bold, spaced away from the rows above.
- `.nl-article-title`: bold serif, centred, uppercase, with clear space above
  and below. `.nl-article-body p` justified.
- `.nl-article-body ul` uses `disc` markers with hanging indent; `.indent` inside
  a `<li>` indents a sub-block without a marker.

## 4. `fit.js` — overflow prevention  → `Keys.Fit`

Hard requirement: **no content may overflow a page, ever.** Two tiers.

### Tier 1 — fixed-height boxes
```html
<div class="fit" data-fit data-fit-max="16" data-fit-min="6" style="height:2.1in">
  <div class="fit-inner"> ...content... </div>
</div>
```
Scale `.fit-inner` `font-size` down (binary search, 0.25px resolution) until
`fit-inner.scrollHeight <= fit.clientHeight` **and**
`fit-inner.scrollWidth <= fit.clientWidth`.

### Tier 2 — whole-page flow
`.paper[data-fit-page]` → scale `.paper-flow` base `font-size` from its CSS
default down to a floor until the flow no longer overflows `.paper`.

### API
```js
Keys.Fit.init()                      // install ResizeObserver / fonts-ready hook
Keys.Fit.refitAll()                  // every [data-fit] + every [data-fit-page]
Keys.Fit.refitPage(pageEl)           // one page and its boxes
Keys.Fit.refitFor(node)              // nearest [data-fit] ancestor, then its page
Keys.Fit.measure(pageEl)             // -> { overflow: bool, px: number }
```

### Rules
- Add class `is-overflowing` to the element that still doesn't fit at min size;
  `paper.css` renders a **screen-only** warning outline for it (invisible in print).
- Must produce correct results for **non-active pages**. All four pages stay in
  layout at all times — inactive pages are hidden with `visibility`, **never**
  `display: none` — so measurement always works. Do not add `display:none`.
- Debounce bursty calls (`requestAnimationFrame` coalescing), but
  `refitAll()` must be synchronous-complete when awaited via
  `Keys.Fit.refitAll()` returning after layout settles.
- Re-fit after `document.fonts.ready`.

## 5. `flip.js` — page navigation  → `Keys.Flip`

### Markup (already in `index.html`)
```html
<div id="stage-viewport">        <!-- scroll/flex container -->
  <div id="stage-sizer">         <!-- JS sets px w/h = scaled page size -->
    <div id="page-stage">        <!-- perspective; holds the .paper elements -->
       <div class="paper" data-page="1">…</div>
       …
    </div>
  </div>
</div>
```

### Zoom / fit-to-view (requirement 1b)
The **entire page must be visible at once with no scrolling** in the default
`fit` mode. Compute
`scale = min(availW / pageW, availH / pageH)` against `#stage-viewport`'s inner
box (minus padding), apply as `transform: scale(k)` with
`transform-origin: top left` on `#page-stage`, and set `#stage-sizer` to
`pageW*k × pageH*k` so centering and scrollbars behave.

Recompute on: window resize, viewport ResizeObserver, orientation change
(page 4 is landscape → the stage must resize), editor pane collapse.

### Page-turn animation (requirement 1c)
A book with its **spine on the left**; pages turn right-to-left going forward.

- `#page-stage { perspective: 2200px; }`
- `.paper { position:absolute; inset:0; transform-origin: left center;
   backface-visibility: hidden; }`
- **Forward (next):** reveal the incoming page beneath, then animate the
  outgoing page `rotateY(0deg) → rotateY(-180deg)`. Raise its `z-index` for the
  duration and drop it when done.
- **Backward (prev):** place the incoming page on top at `rotateY(-180deg)` and
  animate to `rotateY(0deg)`.
- Add a gradient shading overlay (`.paper-shade`) whose opacity ramps up mid-turn
  and back down, so the turning leaf reads as a physical page. Also apply a soft
  drop shadow that tracks the turn.
- Duration ~620ms, easing `cubic-bezier(.36,.06,.2,1)`.
- Multi-page jumps (e.g. page 1 → 4, triggered by focusing a field) animate
  **once** in the correct direction — do not chain three flips.
- Honour `@media (prefers-reduced-motion: reduce)`: switch instantly, no transform.
- Animation must never leave a page stuck: guard with a
  `transitionend` **plus** a timeout fallback, and make a mid-flight `go()` call
  cancel and settle the previous turn cleanly.

### API
```js
Keys.Flip.init({ onChange: fn })  // fn(pageIndex, totalPages)
Keys.Flip.go(n, { animate: true })// 1-based page index
Keys.Flip.next(); Keys.Flip.prev()
Keys.Flip.current()               // -> 1-based index
Keys.Flip.setZoom('fit' | number) // number: 1 = 100%
Keys.Flip.getZoom()               // -> { mode: 'fit'|'manual', scale: number }
Keys.Flip.zoomIn(); Keys.Flip.zoomOut()
Keys.Flip.relayout()              // recompute sizes (call after page 4 resize)
```
`onChange` is how `app.js` updates the pager label and thumbnail rail.

## 6. `calendar.js` — page 4  → `Keys.Calendar`

Reference: `docs/pg-4.png`. Landscape. Header row: logo mark, month/year title in
a heavy-ruled box, school name + website, contact block at right. Then a 7-column
grid, **Sunday leftmost → Saturday rightmost**, with a ruled header row of day
names.

```js
Keys.Calendar.MONTHS                       // ['January', … 'December']
Keys.Calendar.DAY_NAMES                    // ['Sunday', … 'Saturday']
Keys.Calendar.monthMatrix(year, month)     // month is 0-indexed
//   -> array of weeks; each week is 7 cells:
//      { iso: 'YYYY-MM-DD'|null, day: number|null, inMonth: boolean }
//   Leading/trailing cells outside the month are { iso:null, day:null, inMonth:false }.
//   Emit ONLY the weeks needed (4, 5 or 6) — never a fixed 6.
Keys.Calendar.previewHTML(cal)             // -> innerHTML for page 4's .paper-flow
Keys.Calendar.editorHTML(cal)              // -> innerHTML for the editor's page-4 section
```

- Day event cells bind to `calendar.days.<iso>`:
  `<div class="cal-events rt-out" data-bind="calendar.days.2026-06-05"></div>`
- The editor section must include **month and year `<select>` dropdowns**
  (`class="pt" data-path="calendar.month"` / `calendar.year`; month values
  `0`–`11`, year range currentYear−2 … currentYear+5) plus one rich-text field
  per in-month day, labelled with the weekday and date.
- Changing month/year is a **structural change** → `Keys.App.structuralChange`.
  Because day data is keyed by absolute ISO date, switching months and back must
  preserve events. Do not key by day-of-month.
- Correctness: must be right for leap years (Feb 2028), months starting on
  Saturday, and 31-day months starting on Friday (→ 6 week rows).
  **Build dates with `new Date(year, month, day)` (local time) and format the ISO
  string manually — never `toISOString()`, which shifts by timezone.**
- Cells must not overflow: each `.cal-cell` gets Tier-1 fit treatment.

## 7. `slips.js` — page 3  → `Keys.Slips`

Reference: `docs/pg-3.png`. Two columns of bordered boxes. The user must be able
to **add and remove whole boxes**, and the editor fields must change to match
(requirement 2b).

### Slip types
```js
// type: 'lunch'  — the standard order slip
{ id, type:'lunch', column:'left'|'right',
  heading: html,            // centred bold, multi-line
  nameRow: boolean,         // renders  Name ______________  Gr ____
  fields: [ { kind, label } ],
  total: boolean, totalLabel: html,
  footer: html }            // centred bold footer lines

// field kinds:
//   'blank-before' ->  _______ <label>
//   'blank-after'  ->  <label> _______
//   'text'         ->  <label>                (plain line, e.g. "Choose Toppings:")
//   'inline'       ->  ____ A    ____ B    ____ C
//                      label is pipe-delimited: "Ketchup | Mustard | Relish"

// type: 'afterschool' — the weekly After School Sign Up box.
//
// A first-class type, NOT a free-text box. The ruled lines, the weekday
// columns and the XXX markers are GENERATED from this data, so the author
// never types underscores or pads with spaces to align the columns.
{ id, type:'afterschool', column,
  heading: html,            // centred bold, multi-line
  rates: html,              // centred rate block
  notes: html,              // left-aligned note line
  terms: [ { label, value } ],   // 2-column rate/policy table, repeatable
  dayLabels: ['Mon','Tues','Wed','Thurs','Fri'],
  days:      ['blank','blank','blank','blank','xxx'],  // one per column
  students: 2,              // "Name ___ + hours grid" blocks to print
  total: boolean, totalLabel: html,
  footer: html }

// Day states — the only two values. 'blank' prints a rule to write hours on;
// 'xxx' prints XXX for a day with no after-school care (holiday / half day).
// Closure is a property of the WEEK, so every sign-up line shows the same
// pattern; `days` is shared by all of them.
Keys.Slips.DAY_STATES        // ['blank','xxx']
Keys.Slips.DAY_STATE_LABELS  // { blank: 'Blank line', xxx: 'XXX (closed)' }

// type: 'custom' — bordered box, free-form. Retained for anything the
// structured types do not cover.
{ id, type:'custom', column, heading: html, body: html }

// type: 'starburst' — the burst callout
{ id, type:'starburst', column, text: html }
```

`Keys.Slips.blank(type)` returns a new slip with a fresh `Keys.State.uid('slip')`
and sensible placeholder content.

```js
Keys.Slips.previewHTML(slips)   // -> innerHTML for page 3's .paper-flow
Keys.Slips.editorHTML(slips)    // -> innerHTML for the editor's page-3 section
```

- `previewHTML` groups by `column` preserving array order, emitting
  `<div class="slip-col">` for left and right.
- Each box: `<div class="slip slip--lunch" data-slip-id="…">`, and gets
  Tier-1 fit treatment so long headings/option lists can't overflow.
- Starburst: pure CSS/SVG star (no image asset) with centred bold text.
- Editor section per slip: a card with a header showing the type, controls to
  **move up / move down / switch column / duplicate / delete**, then the
  type-appropriate fields. `lunch` slips additionally allow
  **add / remove individual option lines** with a `kind` selector;
  `afterschool` slips allow **add / remove rate lines**, a **per-day state
  dropdown** for each weekday, and a **stepper for the number of sign-up
  lines**.
- A toolbar above the list offers **+ Lunch Slip**,
  **+ After School Sign Up**, **+ Custom Box**, **+ Starburst**
  (`Keys.Slips.TYPE_ORDER`).
- Delete must confirm before destroying content.
- All mutations go through `Keys.App.structuralChange`.

Editor actions (`data-act`) — `app.js` implements every one of these:

```
slip-add     data-type="lunch|afterschool|custom|starburst"
slip-del     data-id            (confirm first)
slip-up      data-id
slip-down    data-id
slip-dup     data-id
slip-col     data-id  data-value="left|right"
field-add    data-id                              (lunch)
field-del    data-id  data-index="<j>"            (lunch)
term-add     data-id                              (afterschool)
term-del     data-id  data-index="<j>"            (afterschool)
student-add  data-id                              (afterschool)
student-del  data-id                              (afterschool)
```

Every mutation helper returns `true` only if something actually changed, and
`app.js` re-renders only then — so the UI never shows a completed action for a
no-op (a confirmed delete that did nothing, in particular).

Per-day state is driven by the generic `.pt` select binding
(`data-path="slips.<i>.days.<d>"`), not a `data-act`.

## 8. CSS files

### `assets/css/app.css` — application shell (screen only)
Owns the editor UI: design tokens, app frame, top toolbar, editor rail,
accordion sections, form controls, pager, thumbnail rail, toasts, buttons.
**Must not** style `.paper` or anything inside it.

### `assets/css/paper.css` — the newsletter itself
Owns `.paper` and all descendants; must visually match `docs/pg-1..4.png`.
Times New Roman body, justified paragraphs, ruled boxes, etc.
**Must not** style app chrome.

### `assets/css/print.css` — print/PDF export
Loaded with `media="print"`. Hides all app chrome, unscales the stage, emits one
physical sheet per page, and handles the mixed portrait/landscape requirement via
named pages:

```css
@page { size: letter portrait; margin: 0; }
@page landscape { size: letter landscape; margin: 0; }
.paper[data-orientation="landscape"] { page: landscape; }
```

## 9. Design direction (requirement 1d)

Calm, professional, dense-but-legible desktop tool. Not a toy.

- Light editor rail on the left, deep neutral canvas for the preview.
- Brand accent: `#003366` (school navy) with a lighter tint for interactive states.
- 8px spacing scale. `border-radius` 6–10px on chrome, 0 on paper.
- A **single sticky toolbar** at the top spanning the app: Save · Load · PDF on
  the left, then a divider, then the text-formatting controls (bold, italic,
  underline, font, size, alignment, lists), then zoom + page controls on the
  right. This satisfies requirement 1a — Save/Load/PDF live *in* the floating
  formatting bar, not in a separate row.
- Editor rail sections are collapsible accordions grouped by page, each with a
  page-number badge; clicking the badge navigates the preview.
- Focused editor field highlights its bound region on the paper (keep the
  existing highlight affordance, refined).
- Keyboard: `⌘/Ctrl+S` save, `⌘/Ctrl+P` PDF, `⌘/Ctrl+B/I/U` formatting,
  `Alt+←/→` page nav.
- Full keyboard focus visibility (`:focus-visible`), AA contrast, `prefers-reduced-motion`
  and `prefers-color-scheme: dark` respected for the **chrome only** (paper stays white).

### 9b. App chrome markup (emitted by `index.html` + `editor.js` — fixed)

```html
<body>
<div id="app">

  <header id="toolbar" role="toolbar" aria-label="Newsletter tools">
    <div class="tb-group tb-brand">
      <span class="tb-logo" aria-hidden="true"><svg>…</svg></span>
      <span class="tb-title">St. Peter&rsquo;s Keys</span>
    </div>

    <div class="tb-sep"></div>

    <!-- requirement 1a: Save / Load / PDF live IN the toolbar -->
    <div class="tb-group">
      <button class="tb-btn tb-btn--primary" data-act="save">Save</button>
      <button class="tb-btn" data-act="load">Load</button>
      <button class="tb-btn" data-act="pdf">PDF</button>
      <input type="file" id="load-input" accept=".json" hidden>
    </div>

    <div class="tb-sep"></div>

    <div class="tb-group" id="format-group">
      <button class="tb-btn tb-btn--icon" data-fmt="bold"><b>B</b></button>
      <button class="tb-btn tb-btn--icon" data-fmt="italic"><i>I</i></button>
      <button class="tb-btn tb-btn--icon" data-fmt="underline"><u>U</u></button>
      <select class="tb-select" data-fmt="fontName">…</select>
      <select class="tb-select" data-fmt="fontSize">…</select>
      <button class="tb-btn tb-btn--icon" data-fmt="justifyLeft">…</button>
      <button class="tb-btn tb-btn--icon" data-fmt="justifyCenter">…</button>
      <button class="tb-btn tb-btn--icon" data-fmt="justifyRight">…</button>
      <button class="tb-btn tb-btn--icon" data-fmt="justifyFull">…</button>
      <button class="tb-btn tb-btn--icon" data-fmt="insertUnorderedList">…</button>
      <button class="tb-btn tb-btn--icon" data-fmt="removeFormat">…</button>
    </div>

    <div class="tb-spacer"></div>

    <div class="tb-group" id="zoom-group">
      <button class="tb-btn tb-btn--icon" data-act="zoom-out">&minus;</button>
      <button class="tb-btn tb-btn--quiet" data-act="zoom-fit"><span id="zoom-label">Fit</span></button>
      <button class="tb-btn tb-btn--icon" data-act="zoom-in">+</button>
    </div>

    <div class="tb-sep"></div>

    <div class="tb-group" id="pager">
      <button class="tb-btn tb-btn--icon" data-act="prev">&larr;</button>
      <span class="tb-pageinfo" id="page-indicator">1 / 4</span>
      <button class="tb-btn tb-btn--icon" data-act="next">&rarr;</button>
    </div>
  </header>

  <main id="workspace">
    <aside id="editor-pane"><div id="editor-scroll"><!-- sections --></div></aside>
    <div id="rail-resizer" role="separator" aria-orientation="vertical" tabindex="0"></div>
    <section id="preview-pane">
      <div id="stage-viewport">
        <div id="stage-sizer">
          <div id="page-stage"><!-- .paper × 4 --></div>
        </div>
      </div>
      <nav id="thumb-rail" aria-label="Pages"><!-- .thumb × 4 --></nav>
    </section>
  </main>

</div>
<div id="toasts" aria-live="polite"></div>
</body>
```

Editor section / field markup (emitted by `editor.js`, and by
`Keys.Slips.editorHTML` / `Keys.Calendar.editorHTML`):

```html
<section class="ed-section is-open" data-section="page1">
  <button class="ed-head" aria-expanded="true">
    <span class="ed-badge" data-page="1">1</span>
    <span class="ed-head-title">Front Page</span>
    <span class="ed-chev" aria-hidden="true"></span>
  </button>
  <div class="ed-body">

    <div class="ed-field">
      <label class="ed-label">Newsletter Title</label>
      <div class="rt rt--single" contenteditable="true"
           data-path="masthead.title" data-page="1" data-single="true"></div>
      <p class="ed-hint">Appears at the top of page 1.</p>
    </div>

    <!-- repeatable rows -->
    <div class="ed-list">
      <div class="ed-row">
        <div class="ed-row-head">
          <span class="ed-row-title">Row 1</span>
          <div class="ed-row-tools">
            <button class="ed-btn ed-btn--icon" data-act="…">↑</button>
            <button class="ed-btn ed-btn--icon ed-btn--danger" data-act="…">✕</button>
          </div>
        </div>
        <div class="ed-cols">…fields…</div>
      </div>
    </div>
    <button class="ed-add" data-act="…">+ Add row</button>

    <!-- slips.js emits cards in this shape -->
    <div class="ed-card" data-slip-id="…">
      <div class="ed-card-head">…</div>
      <div class="ed-card-body">…</div>
    </div>

  </div>
</section>
```

Other chrome classes: `.pt` (plain `<input>`/`<select>`), `.ed-check`
(checkbox + label row), `.ed-inline` (horizontal control cluster),
`.ed-btn` / `--icon` / `--danger` / `--ghost`, `.ed-toolbar` (the
add-a-box toolbar in the slips section), `.thumb` / `.thumb.is-active` /
`.thumb-num`, `.toast` / `.toast--ok` / `.toast--err`,
`.rt.is-focused`, `.ed-section.is-open`, `body.is-collapsed-rail`.

## 10. Verification

`npm`-free Playwright harness lives at `tools/verify.js` (run by the integrator).
Every module is expected to pass:
- no page overflow with the seeded May 2026 content,
- no content escaping `.paper` bounds on any page,
- calendar grid correctness across a matrix of months/years,
- add/remove slip round-trips,
- save → load round-trip equality,
- page-turn leaves exactly one visible page and no stuck transforms.
