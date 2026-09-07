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
  `Keys.Arrange`, `Keys.Render`, `Keys.Editor`, `Keys.Auth`, `Keys.App`.
- Script load order (already wired in `index.html`):
  `state.js → fit.js → flip.js → calendar.js → slips.js → arrange.js → render.js → editor.js → auth.js → app.js`
  `auth.js` must precede `app.js`: app.js hands it the boot decision (§12).
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

**The page count is data, not a constant.** An issue is Front + *N* announcement
pages + Slips + Calendar, where *N* ≥ 1 (`articles.pages.length`, capped at
`Keys.State.MAX_ANNOUNCEMENT_PAGES`). Adding a page renumbers everything after
it.

| Kind | Content | Orientation | Size |
|---|---|---|---|
| `front` | Masthead, Classroom Corner, This Week, Looking Ahead, articles | portrait | 8.5in × 11in |
| `announcements` (×N) | Article sections | portrait | 8.5in × 11in |
| `slips` | Lunch slips / sign-up boxes (2 columns) | portrait | 8.5in × 11in |
| `calendar` | Monthly calendar | **landscape** | 11in × 8.5in |

The `front` and `announcements` sheets have **two layouts**, chosen by
`doc.template` — see §3c. `slips` and `calendar` are shared by both.

### `data-page` vs `data-kind` — do not confuse them

```html
<div class="paper" data-page="5" data-kind="calendar" data-orientation="landscape">
```

- `data-page` is the **ordinal**. It shifts whenever an announcement page is
  added or removed, so nothing may key off a literal value.
- `data-kind` is the **stable identity**. CSS and any logic meaning "the
  calendar" must use it. `paper.css` keys the calendar's page margins off
  `[data-kind="calendar"]`; keying them off `[data-page="4"]` silently broke
  the moment a page was inserted.

`Keys.Render.pages()` is the single source of truth:

```js
Keys.Render.pages()        // [{ n, kind, name, short, orientation, listPath? }]
Keys.Render.count()        // sheet count
Keys.Render.pageAt(n)      // descriptor for a 1-based ordinal
Keys.Render.ordinalOf(kind)// first ordinal of a kind, or 0
Keys.App.totalPages()      // same count, for the pager
```

`slips.js` and `calendar.js` still emit `data-page="3"` / `"4"` on their editor
fields. `Keys.Editor` corrects those in one pass (`syncFieldPages`) from each
section's badge, so those modules never need to know the ordinal.

### Adding and removing announcement pages

```
data-act="page-add"                          // toolbar rail + editor button
data-act="page-del" data-page-index="<i>"    // per-page, editor only
```

- The **preview rail** carries an `+ Add page` shortcut (`.thumb--add`); it is
  *not* a `[data-page]` navigation target and must be excluded from the
  thumbnail click handler.
- Removing a page confirms first if it has content.
- The last announcement page cannot be removed, and its delete button is not
  rendered at all — an issue always has at least one.

## 3a. Legacy save files

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

## 3c. Templates → `Keys.State.template()`

A **template** is the layout of the front and announcement sheets. Two exist:

| id | Name | Front | Announcements | Reference |
|---|---|---|---|---|
| `contemporary` | Contemporary | serif, 1 wide column + ruled rail | 1 full-width column | `reference/keys_may_25.pdf` |
| `modern` | Modern | geometric sans, 3 columns | 2 columns | `reference/Keys_Modern-Page1.png`, `-Page2.png` |

`contemporary` is the default and what every save file predating templates
opens as — that is the layout those issues were authored for.

**The slips and calendar sheets are shared and must stay byte-identical
across templates.** `tools/verify.js` asserts this on `.paper-flow.innerHTML`,
which catches a stray class or attribute as readily as a layout change.

### The rules that make switching safe

1. **One document, two presentations.** `doc.template` selects a layout; it
   never converts, copies or discards content. Switching is a plain
   `Keys.App.structuralChange` — `verify.js` asserts the document is
   byte-identical before and after a round trip.
2. **`template` lives in the document**, not `localStorage`: it changes the
   printed artefact, so it has to travel with the save file (unlike the
   light/dark theme, which does not).
3. **Only the front page's markup forks.** Announcement sheets share one
   markup tree and differ in CSS alone. That is what keeps `arrange.js` and
   click-to-edit working identically on both, with no per-template branches.
4. **Every sheet carries `data-template`**, including the two the template does
   not change, so a selector never has to combine kind and template to decide
   whether it may apply.
5. **The id is validated in `normalizeDoc`.** It reaches CSS selectors and a
   renderer dispatch, so an unknown id from a hand-edited file falls back to
   `contemporary` rather than rendering blank sheets. `setTemplate` returns the
   id actually in effect.

```js
Keys.State.templates()      // [{ id, name, note }] in toolbar order
Keys.State.template()       // active id, always one of the above
Keys.State.setTemplate(id)  // returns the id NOW IN EFFECT (may reject)
Keys.App.chooseTemplate(id) // the UI path: switch + re-render + toast
```

The toolbar dropdown is `#template-select`, filled by `app.js` from
`State.templates()` so the list has one source. `syncTemplateSelect()` runs
after every structural change, because loading a file can bring a different
template with it.

### Which fields each template renders

The editor rail shows **only what the active template prints**, plus a lead
hint naming the template. Everything else stays in the document untouched and
reappears on switching back.

| Field | Contemporary | Modern |
|---|---|---|
| `masthead.tagline` / `.title` / `.date` / `.schoolInfo` | ✓ | ✓ |
| `masthead.sectionHeading`, `classroom.body` / `.signature` | ✓ | ✓ |
| `thisWeek.*`, `lookingAhead.*`, `railOrder`, `articles.*` | ✓ | ✓ |
| `masthead.motto` | ✓ | — |
| `classroom.verse` | ✓ | — |
| `masthead.volume`, `masthead.contactHeading` | — | ✓ |
| `intro.heading` / `.body`, `bible.heading` / `.body` | — | ✓ |
| `footer.site`, `modern.emblem` | — | ✓ |

`masthead.title` and `masthead.sectionHeading` are stored in **title case**.
`text-transform` belongs to the template, not the content: Contemporary prints
them in capitals, Modern as typed. Storing `"ST. PETER'S KEYS"` would make it
impossible for any template to recover mixed case.

### Modern markup (emitted by `render.js` — style against this)

```html
<div class="paper" data-page="1" data-kind="front" data-template="modern"
     data-orientation="portrait" data-fit-page>
  <div class="paper-flow">          <!-- flex COLUMN under Modern -->

    <header class="nl-m-head">
      <!-- grid: minmax(0,1fr) | auto | minmax(0,1fr)
           col 1 empty · col 2 title (centred on the SHEET) · col 3 volume -->
      <div class="nl-m-titlerow">
        <div class="nl-title      rt-out" data-bind="masthead.title">
        <div class="nl-m-volume   rt-out" data-bind="masthead.volume">
      </div>
    </header>
    <div class="nl-m-dateband">
      <div class="nl-date         rt-out" data-bind="masthead.date">
    </div>
    <div class="nl-tagline        rt-out" data-bind="masthead.tagline">

    <div class="nl-m-cols">         <!-- 3-col grid: 28fr 41fr 33fr -->
      <aside class="nl-m-aside">
        <section class="nl-m-block">
          <div class="nl-m-blocktitle nl-m-blocktitle--intro rt-out" data-bind="intro.heading">
          <div class="nl-m-blockbody  rt-out" data-bind="intro.body">
        </section>
        <div class="nl-m-emblem" aria-hidden="true"><svg>…</svg></div>
        <section class="nl-m-block">
          <div class="nl-m-blocktitle nl-m-blocktitle--bare rt-out" data-bind="bible.heading">
          <div class="nl-m-blockbody rt-out" data-bind="bible.body">
        </section>
      </aside>

      <div class="nl-m-main">
        <div class="nl-heading rt-out" data-bind="masthead.sectionHeading">
        <div class="nl-body    rt-out" data-bind="classroom.body">
        <div class="nl-sign    rt-out" data-bind="classroom.signature">
      </div>

      <aside class="nl-rail" data-drop="rail">
        <section class="nl-m-block" data-move="rail" data-move-key="thisWeek" …>
          <div class="nl-m-blocktitle rt-out" data-bind="thisWeek.heading">
          <div class="nl-m-lines">
            <p class="nl-m-line">
              <span class="nl-m-line-date  rt-out" data-bind="thisWeek.rows.0.date">
              <span class="nl-m-line-event rt-out" data-bind="thisWeek.rows.0.event">
            </p>
          </div>
        </section>
        <!-- …lookingAhead, then the contact block (NO data-move) -->
        <section class="nl-m-block nl-m-contact">
          <div class="nl-m-blocktitle rt-out" data-bind="masthead.contactHeading">
          <div class="nl-schoolinfo   rt-out" data-bind="masthead.schoolInfo">
        </section>
      </aside>
    </div>

    <div class="nl-articles" data-drop="article" data-drop-list="articles.page1">…</div>

    <div class="nl-m-foot">        <!-- margin-top:auto pins it to the bottom -->
      <span class="nl-m-foot-site rt-out" data-bind="footer.site">
      <span class="nl-m-foot-num">1</span>     <!-- DERIVED: no data-bind -->
    </div>
  </div>
</div>
```

Load-bearing details, each of which was a bug first:

- **The Modern rail box has no `[data-fit]`.** Tier 1 needs a definite height
  to measure against and the Modern rail has none — the entries just flow.
  Wrapping it in a `.fit` box with auto height is *worse than useless*:
  `clientHeight` would always equal `scrollHeight`, so tier 1 would report
  success while doing nothing. A long rail is tier 2's job.
- **`.paper-flow` is a flex column** so the running foot can sit at the bottom
  with `margin-top: auto`. Its children are `flex: 0 0 auto` deliberately: a
  shrinkable item would absorb an overflow, and tier 2 only shrinks the page
  when it can *see* one.
- **The announcements sheet uses `column-count: 2` with `column-fill: balance`
  and auto height.** With a *definite* height the overflow would spill sideways
  into a third, clipped column; balancing to auto height makes an over-long
  issue grow downwards, which is the direction tier 2 shrinks against.
- **No `white-space: nowrap` anywhere on the sheet.** `.nl-m-volume` had it, to
  keep the reference's short "Volume 1, Issue 1 2026" on one line, and it made
  that the one region no amount of shrinking could fit: a long value became an
  unbreakable line that pushed the whole page off the paper sideways. It is
  `min-width: 0` + `overflow-wrap: anywhere` in a bounded grid track instead.
- **The masthead row is a three-track grid**, not a centred flex row: the title
  belongs in the middle track so it is centred on the *sheet*, with the volume
  anchored right in a track the empty first track mirrors. Flex siblings made
  the title's position depend on how long the volume string happened to be.
  Both side tracks must be `minmax(0, 1fr)` — a plain `1fr` floors at
  min-content and re-breaks the centring. See `docs/CLASSES.md`.
- **`articles.page1` still renders full-width beneath the columns.** The Modern
  reference has no such region because that issue had none; dropping the list
  would silently lose content, and the columns already run the full height when
  it is empty.
- **The emblem is chrome, not content**: `aria-hidden`, no `data-bind`, so
  click-to-edit ignores it. `modern.emblem` turns it off.
- **The page number is derived** from the ordinal and carries no `data-bind` —
  there is nothing to edit.

`paper.css` §03 is written *without* a template qualifier and is therefore the
Contemporary baseline; §03b re-points what Modern changes. Anything in §03 that
Modern must not inherit has to be overridden in §03b rather than made
conditional in §03 — that keeps Contemporary's cascade exactly as it was before
templates existed. Every §03b selector is qualified by **both**
`data-template="modern"` and a `data-kind` of front or announcements, so the
shared sheets cannot be reached from there.

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

## 11. `arrange.js` — move sections around the preview  → `Keys.Arrange`

**Reorder, not free positioning.** Dragging to arbitrary x/y would guarantee
overlap and spill on a fixed sheet, which is precisely what must not happen. A
drag moves a block to a new SLOT in the page flow, so blocks reflow around each
other and overlap is impossible by construction.

### Markup contract (emitted by `render.js` / `slips.js`)

```html
<!-- draggable block -->
<article class="nl-article" data-move="article"
         data-move-key="articles.page1:0" data-move-label="FIELD DAY">
<div class="slip" data-move="slip" data-move-key="<slipId>" data-move-label="…">
<section class="nl-box" data-move="rail" data-move-key="thisWeek" …>

<!-- drop container -->
<div class="nl-articles" data-drop="article" data-drop-list="articles.page1">
<div class="slip-col"   data-drop="slip"    data-drop-col="left">
<aside class="nl-rail"  data-drop="rail">
```

A block may only be dropped into a container of the same `kind`. `data-move-key`
identifies it *within that kind*: a `list:index` pair for articles, the slip id
for slips, the state key for rail boxes.

### Slot indices are EXCLUSION coordinates

`slotAt()` returns an index among the container's blocks **with the dragged one
already removed**. Consequences that are easy to get wrong:

- the slot that reproduces the current arrangement is exactly `fromIndex`;
- after `splice`-ing the block out, the index needs **no** shift correction.

Both `applyArticle` and `applyRail` originally used inclusive-index arithmetic
here and silently refused legitimate moves.

### The overflow guard

Every drop is provisional. `commit(mutate)` snapshots the document, applies,
re-renders, refits, and rolls back if the layout got worse — where "worse" is
any of:

- a page that now overflows and did not before;
- more boxes pinned at their shrink-to-fit minimum;
- a page newly pushed below `MIN_COMFORTABLE_SCALE` (0.8).

That last one matters: the fit engine will happily scale a page to 0.5 to make
anything "fit", so testing overflow alone would let a drop crush a whole page
to unreadable type and report success.

### Cross-page moves

Only one sheet is visible at a time, so a block cannot be dragged onto a page
that is off screen. Dragging an announcement over a **page thumbnail** moves it
to that page's list; the thumbnail lights up (`.thumb.is-drop-target`) and the
preview follows the block after the drop.

### Chrome, not paper

The handle (`#arrange-handle`) and drop indicator (`#arrange-indicator`) live in
`#arrange-layer` inside `#preview-pane` — **never inside `.paper`**. Anything
injected into `.paper-flow` would be measured by the fit engine and would have
to be stripped for print. `print.css` therefore needs no rules for them.

### API

```js
Keys.Arrange.init()                 // idempotent; delegates from #page-stage
Keys.Arrange.refresh()              // after a re-render: drop stale handles
Keys.Arrange.slotAt(x, y, kind, draggedEl)
Keys.Arrange.apply(blockEl, target) // target: { container, index }
Keys.Arrange.commit(mutate, toast)  // guarded; -> true if the move stuck
Keys.Arrange.overflowSignature()
Keys.Arrange.debugState()
```

The handle is a real `<button>`: arrow keys move a block one slot, and
left/right send it to the other container (column, or page). Dragging is never
the only way to move something.

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

<!-- Save and PDF both ask for a file name first. -->
<dialog id="name-dialog" class="dlg" aria-labelledby="name-dialog-title">
  <form id="name-dialog-form" class="dlg-form">
    <h2 class="dlg-title" id="name-dialog-title">Save newsletter</h2>
    <p class="dlg-note" id="name-dialog-note"></p>
    <label class="dlg-label" for="name-dialog-input">File name</label>
    <div class="dlg-inputwrap">
      <input type="text" id="name-dialog-input" class="dlg-input">
      <span class="dlg-ext" id="name-dialog-ext" aria-hidden="true">.json</span>
    </div>
    <div class="dlg-actions">
      <button type="button" class="tb-btn" data-dlg="cancel">Cancel</button>
      <button type="submit" class="tb-btn tb-btn--primary" id="name-dialog-ok">Save</button>
    </div>
  </form>
</dialog>

<div id="toasts" aria-live="polite"></div>
</body>
```

**The file-name dialog** (`Keys.App.askFilename`). Every id above is
load-bearing — `app.js` retitles the dialog and swaps the extension and the
confirm label for each action, so the markup is written once and reused.

- `askFilename({ title, note, ext, okLabel, suggestion })` resolves with the
  cleaned name, or **`null` if the user cancelled**. Callers must treat `null`
  as "do nothing" — never as "use the default".
- The suggestion is the input's **placeholder**, not its value: the field opens
  empty so typing needs no clearing, and submitting empty accepts the
  suggestion.
- `Keys.App.suggestedName()` → `"SP_Keys-" + <the page-1 date>`, e.g.
  `SP_Keys-May26_2026`. `masthead.date` is free rich text, so it is parsed for
  a month/day/year triple, then falls back to the whole line with punctuation
  folded to `_`, then to today's date.
- `Keys.App.cleanFilename(typed, fallback)` strips control characters and path
  separators, folds the Windows-reserved set to `-`, refuses a leading dot, and
  caps the length. Anything falsy becomes `fallback`.
- **PDF naming is advisory.** There is no API for setting a PDF file name — the
  browser's own "Save as PDF" dialog seeds it from `document.title`. `app.js`
  parks the chosen name there for the duration of the print and restores it on
  `afterprint` (with a window-`focus` backstop). It must **not** be restored
  immediately after `print()` returns: browsers disagree on whether `print()`
  blocks, so that would be a race the feature loses silently.
- No `<dialog>` support falls back to `window.prompt()`.

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

**Open sections pin their header.** `.ed-section.is-open > .ed-head` is
`position: sticky`, so the title stays in view while its body scrolls past.
Two constraints follow, and both are easy to break by accident:

- `.ed-section` must **not** be `overflow: hidden`. That would make each
  section its own scrollport, and a sticky header inside a non-scrolling
  scrollport never sticks at all — silently. The rounded corners it used to
  clip are declared on `.ed-head` and `.ed-body` instead.
- Sticky offsets are measured from the scroller's **padding** box, so
  `top: 0` would pin one `--rail-pad-top` below the visible edge and leave a
  gap for content to scroll through. `#editor-scroll` owns that variable and
  the header cancels it with `top: calc(-1 * var(--rail-pad-top))`.

Every `.ed-head` background must stay a **fully opaque** token — fields scroll
underneath it. Fields carry `scroll-margin-top` so a jump-to-field
(`Editor.focusPath`) cannot park one behind the pinned header.

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
- page-turn leaves exactly one visible page and no stuck transforms,
- the sign-in gate holds the boot back, and the account rules in §12 hold.

## 12. `auth.js` — accounts and the sign-in gate  → `Keys.Auth`

### Read this before changing anything here

**This is not an access-control boundary, and must never be described as one.**
The app is static files opened from disk with no server behind it. Anyone
holding the files can set the session key in devtools, edit `auth.js` to skip
the check, or read the newsletter straight out of the saved `.json`. What the
gate genuinely provides is that the newsletter is not on screen for whoever
wanders up to a shared office computer, plus a record of who is working on the
issue.

That honesty is a **functional requirement**, not a disclaimer. `verify.js`
asserts that the wording appears both on the gate and in Settings, because a
lock that overstates itself is worse than no lock: someone will put
confidential information behind it. If you restyle these screens, the notice
stays.

The one part that *is* done properly is password storage — see below.

Real access control needs a server: sessions over HTTPS, hashing and role
checks server-side, and the newsletter itself stored server-side (otherwise
there is nothing to protect). That is a different project, not a change here.

### Load order

`auth.js` loads **before** `app.js`. `app.js` does not boot itself; it hands
the decision over:

```js
if (Keys.Auth) Keys.Auth.start(boot);   // Auth calls boot() after sign-in
else boot();                            // a missing lock must never brick it
```

So while the gate is up the newsletter is not merely hidden — it has never been
rendered. `verify.js` asserts `#page-stage .paper` count is 0 and that no
newsletter text appears in `document.body.innerText`.

### Storage

| Key | Where | Contents |
|---|---|---|
| `stpeters.keys.accounts.v1` | `localStorage` | `{ version, users: [...] }` |
| `stpeters.keys.session.v1` | `sessionStorage` | `{ userId, startedAt }` |

A user record is `{ id, name, role, salt, hash, iterations, createdAt }`.
`role` is `'admin'` or `'user'`.

The session lives in **`sessionStorage`**, so it dies with the tab, and carries
`{ userId, startedAt, lastSeen }` — never credentials. It has a 12-hour
absolute ceiling on top of the idle timeout below.

### Idle timeout

**Five minutes of inactivity**, not five minutes of wall clock. A hard cap
would throw an author out mid-article, which is useless and the fastest way to
get the feature switched off. `pointerdown`, `pointermove`, `keydown`, `wheel`,
`scroll`, `focusin` and `input` all reset it. To make it absolute instead, stop
calling `noteActivity()` from `watchActivity()` — nothing else changes.

- **`lastSeen` on the session is the only clock.** Not an in-memory timer: the
  timeout then survives a reload and is still enforced when a background tab's
  timers have been throttled. The write is throttled to one every
  `TOUCH_THROTTLE_MS`, so the stored value can lag real activity by up to five
  seconds — conservative against a five-minute budget, which is the right
  direction to be wrong in. The throttle is measured against the **stored**
  value, so there is no second clock that can drift out of step with it.
- Enforced in **two** places: the `IDLE_TICK_MS` timer, and `readSession()` on
  every load. A tab that was asleep is signed out on the way back in.
- `visibilitychange` and window `focus` re-check immediately, because a hidden
  tab's timers are throttled to roughly once a minute.
- A toast warns `IDLE_WARN_MS` before, so it does not come out of nowhere.
- On expiry: **autosave, clear `State.dirty`, then reload.** Clearing `dirty`
  is load-bearing — `beforeunload` puts up the browser's "leave site?" prompt
  whenever it is set, which would *block the reload* and leave the tab signed
  in with the newsletter on screen, exactly what the timeout exists to prevent.
  Nothing is lost: autosave writes the whole document and boot restores it.
  `reloadCleanly()` does this, and manual sign-out and account deletion use it
  for the same reason.
- The gate then shows **why**, once, from a one-shot `REASON_KEY`. Being
  dropped to a sign-in screen with no explanation reads as a fault.

### Password storage

PBKDF2-SHA256, a fresh 16-byte random salt per user, **310,000 iterations**
(OWASP's floor for this KDF), 32-byte output, all base64. ~45 ms per
derivation: imperceptible on sign-in, but it multiplies the cost of an offline
dictionary attack on the stored hash by 310,000.

- `crypto.subtle` needs a **secure context**. `file://`, `https://` and
  `localhost` are; plain `http://` on any other host is not — so **serving the
  site from a VM over http:// switches accounts off entirely.** Where it is
  missing the gate **stands down** rather than fall back to a weaker hash: a
  dishonest hash is worse than no hash, and bricking the office's newsletter
  over a convenience lock is worse than both.

  It must stand down **loudly**. The first version un-hid a notice that lived
  inside the gate and then hid the gate, so the explanation was never visible
  and a misconfigured deployment was indistinguishable from a broken feature.
  Now the gate stays up carrying the explanation, a `Continue without signing
  in` button, and a `console.warn` — a server admin is usually looking at
  devtools, not at the screen. `verify.js` reproduces the condition by removing
  `isSecureContext` and `crypto.subtle` in an init script; a local HTTP server
  cannot reproduce it, because every `127.0.0.0/8` address counts as localhost.
- Sign-in derives a hash **even when the name is unknown**, against a random
  salt, so a wrong name and a wrong password cost the same and return the same
  message. Neither can be used to work out who has an account.
- Comparison is constant-time.
- Changing a password rotates the salt.

### Rules

Enforced in `Keys.Auth`, not in the UI — the UI hides what you may not do, but
the model is what refuses:

- The **first** account created is always an administrator. There is **no
  built-in account and no default password**; a documented default is a real
  hole even in a lock this modest.
- Only an administrator may `addUser` or remove **someone else**.
- Anyone may remove **themselves**, which also signs them out.
- **The last administrator can never be removed**, by either route. Without
  that guard an issue could be left with accounts but nobody able to manage
  them, and the only way out would be clearing browser storage — which throws
  the newsletter away with it. The UI renders **no** remove button in that
  case rather than a disabled one.
- Changing your own password requires the current one, so someone who walks up
  to an unlocked screen cannot lock the real user out.
- Names are unique case-insensitively; passwords are ≥ 8 characters.
- A corrupt or hand-edited account store is **discarded, not trusted**: records
  without usable hash material are dropped, and if that leaves none the gate
  falls back to first-run setup. Failing towards "ask for a new password" is
  the safe direction; failing towards "let anyone in" is not.

### API

```js
Keys.Auth.hasAccounts()                      // bool
Keys.Auth.users()                            // [{id,name,role,createdAt}] — never salt/hash
Keys.Auth.currentUser()                      // {id,name,role} | null
Keys.Auth.isAdmin()                          // bool
Keys.Auth.createFirstAdmin(name, pw)         // Promise<{user}|{error}>
Keys.Auth.signIn(name, pw)                   // Promise<{user}|{error}>
Keys.Auth.signOut()
Keys.Auth.addUser(name, pw, role)            // Promise<{user}|{error}>  admin only
Keys.Auth.removeUser(id)                     // {removed,self}|{error}
Keys.Auth.changePassword(current, next)      // Promise<{changed}|{error}>
Keys.Auth.openSettings() / closeSettings()
Keys.Auth.start(boot)                         // app.js hands boot over

Keys.Auth.checkIdle()                         // 'active'|'warning'|'expired'|'no session'
Keys.Auth.idleFor()                           // ms since last activity
Keys.Auth.IDLE_MS                             // 5 * 60 * 1000

Keys.Auth.diagnose()                          // why the gate is/isn't showing
Keys.Auth.resetAllAccounts()                  // documented recovery path
```

`diagnose()` answers "it never asked me to create an administrator" without
guessing: secure context, `crypto.subtle`, storage, account count, session, and
a plain-English `summary` naming which of those is the reason.

`resetAllAccounts()` is the way out of a forgotten administrator password. It
is **not** a hole — anyone who can call it can already clear the same key from
the browser's storage panel — and it does not touch the newsletter.

Every operation re-reads the store and re-checks the caller's role. Not because
that stops anyone — nothing here can — but so the rules live in one place and
the UI cannot drift away from them.

### Markup

`#auth-gate` (outside `#app`, covers it, `body.is-locked` hides `#app` and it
is marked `inert`), and `#settings-dialog` (a native `<dialog>`, reusing the
`.dlg` pattern from the file-name prompt). The gear is
`[data-act="settings"]`, in the same toolbar group as and immediately beside
`[data-act="theme"]` — `verify.js` asserts that adjacency.

### There is deliberately no test bypass

`tools/verify.js` signs in by driving the real form. Do not add a query
parameter, global, or build flag that skips the gate: it would be a genuine
hole in shipped code, and it would stop the sign-in path being exercised on
every run.
