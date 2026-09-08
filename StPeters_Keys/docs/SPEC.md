# St. Peter's Keys — Implementation Contract

Authoritative interface spec. **Every module must conform exactly.** Class names,
attribute names and function signatures below are load-bearing — other modules
depend on them by string.

## 0. Ground rules

- **Vanilla JS, classic scripts, no build step, no `type="module"`.** The app must
  work when `index.html` is opened over `file://`. ES modules are blocked by CORS
  on `file://` — do not use `import`/`export`. This is not a legacy constraint:
  `file://` is one of the app's two supported modes (§12).
- **No third-party network requests.** No CDN fonts, no CDN libraries, no
  telemetry. Everything ships in-repo. The single exception is `auth.js`, which
  talks to **its own origin** — `/api/auth/*` and `/api/users` on the server
  that served the page (§14), and never anywhere else. Nothing may be fetched
  from a host the user did not open.
- Every module attaches itself to the `window.Keys` namespace:
  `Keys.State`, `Keys.Fit`, `Keys.Flip`, `Keys.Calendar`, `Keys.Slips`,
  `Keys.Arrange`, `Keys.Render`, `Keys.Editor`, `Keys.Stash`, `Keys.Auth`,
  `Keys.App`.
  The `server/` tree (§14) is **not** part of this namespace and shares no code
  with it: it is Node, CommonJS, and runs in a different process. The only
  contract between them is `docs/AUTH-API.md`.
- Script load order (already wired in `index.html`):
  `state.js → fit.js → flip.js → calendar.js → slips.js → arrange.js → render.js → editor.js → stash.js → auth.js → app.js`
  `auth.js` must precede `app.js`: app.js hands it the boot decision (§12).
  The order did not change when accounts moved to the server; what `auth.js`
  *does* with that decision changed entirely, so do not assume §12 still says
  what you remember.
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

Sign-in and Settings chrome: `.auth-card` / `-brand` / `-title` / `-lead` /
`-note` / `-field` / `-label` / `-input` / `-error` / `-submit` / `-notice`,
`.set-h` / `-me` / `-me-name` / `-me-role` / `-section` / `-form` / `-label` /
`-users` / `-user` / `-user-name` / `-user-you` / `-user-role` / `-user-note` /
`-msg` (`--ok`, `--err`) / `-notice`, plus `.set-warn` (plain-http),
`.set-offline` (`file://`), and the two body classes `body.is-locked` and
`body.is-relocked` (§12, *Markup*). `.auth-degraded` and `.auth-hint` are in
`app.css` but are **not** used by `index.html` — see `docs/CLASSES.md` before
deleting them.

## 10. Verification

`npm`-free Playwright harness lives at `tools/verify.js` (run by the integrator).
Every module is expected to pass:
- no page overflow with the seeded May 2026 content,
- no content escaping `.paper` bounds on any page,
- calendar grid correctness across a matrix of months/years,
- add/remove slip round-trips,
- save → load round-trip equality,
- page-turn leaves exactly one visible page and no stuck transforms,
- the re-entry gate holds the boot back on the `'boot'` path, re-authenticates
  **in place** on the `'reauth'` path without losing an unsaved issue, and the
  account rules in §12/§14 hold.

The account checks now need a **server** to run against, not just a page:
start one on a spare port with its own `KEYS_DATA` and drive it over
`http://127.0.0.1`, which the server treats as localhost so the plain-http
warning does not fire. Do **not** reintroduce a client-side account store to
make the suite self-contained; the suite exists to test what ships.

## 12. `auth.js` — identity and the re-entry gate  → `Keys.Auth`

### Read this before changing anything here

**Accounts are not in this file and not in this browser.** They live on the
Node server in `server/` (§14), behind the contract in `docs/AUTH-API.md`.
Passwords are hashed there, sessions are held there, and both clocks are
enforced there. `auth.js` never sees a hash, never stores an account, and is
never trusted about the time.

That splits the app into **two modes**, decided once at load from
`location.protocol` and published as `Keys.Auth.mode`:

| Mode | Reached by | Accounts | Gate |
|---|---|---|---|
| `served` | `http:` / `https:` | On the server | Yes — enforced by the server |
| `offline` | `file:` (and anything else) | None | None at all |

**In served mode this IS an access-control boundary**, and must be described as
one. The server will not hand out `index.html`, the application JavaScript, or
any API answer without a valid `keys_sid` cookie. The old notice — "this is not
a security barrier" — is now *false* here, and understating a lock that works
is its own kind of lie: it invites someone to distrust the one thing protecting
the newsletter.

**In offline mode there is no gate to describe.** There is no server to
authenticate against, and a local prompt would protect nothing from somebody
who already has the files, so `start(boot)` boots immediately. Saying so
plainly is the point; a sign-in box that anyone can delete by editing one file
is the failure mode this project keeps refusing.

What served mode does **not** do is encrypt anything. Over plain `http://` the
password and the newsletter cross the network in the clear, and the newsletter
is not encrypted at rest anywhere. Both notices say exactly that, and Settings
says it again, louder, when the connection is not TLS and the host is not
localhost (`#settings-insecure`).

**The honesty of that copy is a functional requirement, not a disclaimer** —
in both directions. The notice must not claim more than the mode delivers, and
must not claim less. It is filled in by `refreshNotices()` into every
`.auth-notice` and `.set-notice`, from `servedNotice()` or `OFFLINE_NOTICE`, so
there is one sentence per mode and it cannot drift between the two screens.
`servedNotice()` quotes the idle timeout, so it is re-rendered when
`/api/auth/state` reports the server's real `idleMs`. If you restyle these
screens, the notice stays.

### Gone, and not coming back

- **`crypto.subtle` and browser-side PBKDF2.** Hashing is the server's job.
- **The secure-context "degraded mode".** It existed only because
  `crypto.subtle` is unavailable outside a secure context, which meant serving
  the app from a VM over plain `http://` silently switched accounts off. That
  failure is **eliminated, not worked around**: nothing in the browser needs
  `crypto.subtle` any more, so the browser's secure-context rule is no longer
  involved at all. Do not reintroduce a client-side hash to "support" anything.
- **`resetAllAccounts()` and `createFirstAdmin()`** as working calls. Both
  remain on `Keys.Auth` as functions that **throw with an explanation**, which
  is deliberate: each was a documented path someone will type into a console at
  exactly the wrong moment, and a `TypeError: not a function` teaches them
  nothing. Recovery is `node server/reset-accounts.js`; first-run setup is the
  server's `/setup` page, guarded by a one-time token.

### Load order

`auth.js` loads **before** `app.js`. `app.js` does not boot itself; it hands
the decision over:

```js
if (Keys.Auth) Keys.Auth.start(boot);   // Auth calls boot() after sign-in
else boot();                            // a missing lock must never brick it
```

The load order itself gains nothing new — but what `auth.js` does with the boot
decision changed completely, so read `start()` before assuming anything.

In **offline** mode `start()` hides the gate and boots immediately.

In **served** mode the server has already refused to send this page to a
stranger, so by the time the script runs the visitor is in: `start()` fetches
`GET /api/auth/state` for identity and then boots. Two edge cases are still
handled rather than assumed away:

- **The state probe fails.** Boot anyway. The page itself was served, so the
  session was valid moments ago, and one failed request is not a reason to hold
  an issue hostage. A `console.warn` says account management will not work
  until the server answers, and the heartbeat finds out when it returns.
- **The server says we are not signed in.** A back/forward-cache restore, or a
  tab that sat open across a server restart. The app has *not* booted, so the
  gate goes up instead of the editor, and the newsletter is never rendered.

So when the gate is up on the `'boot'` path the newsletter has never been
rendered — `#page-stage .paper` is empty and no newsletter text is in
`document.body.innerText`. `verify.js` must keep asserting that.

### Storage

**None.** `auth.js` writes no `localStorage` key, no `sessionStorage` key and
no cookie. The session is the server's `keys_sid` cookie, which is `HttpOnly`
and therefore not readable from script at all — that is the point of it.

Two things are held in memory for the life of the page, and neither authorises
anything:

- `me` — the user object the server last described, so the toolbar label and
  `isAdmin()` are not network calls. It can be one heartbeat stale; the server
  re-checks every request regardless.
- `lastKnownName` — survives `me` being cleared, purely so the re-auth gate can
  pre-fill the name box and the person only types a password. Reading `me.name`
  there is the bug this exists to prevent: by the time the gate is raised `me`
  is already `null`, and the box came up empty.

### Idle handling — the server owns the clock

**Five minutes of inactivity**, not five minutes of wall clock, plus a 12-hour
absolute ceiling. Both are enforced *server-side* (§14); this file only decides
**when to ask**, and what to do with a 401 — which is the important half.

`IDLE_MS` starts at the documented default and is **replaced** by the real
`idleMs` from `/api/auth/state`, so the number quoted in the notices cannot
drift from the number the server uses.

`pointerdown`, `pointermove`, `keydown`, `wheel`, `scroll`, `focusin` and
`input` all count as activity. To make the timeout absolute instead, stop
calling `noteActivity()` from `watchActivity()` — nothing else changes.

**Heartbeat economics.** The old build ticked every 5 seconds against
`sessionStorage`, which was free; every tick is now an HTTP request. So:

- the timer runs every `HEARTBEAT_MS` (30s) and usually decides to do nothing;
- `POST /api/auth/touch` is sent at most once a minute (`TOUCH_MIN_MS`), and
  only when there has been real activity since the last one;
- a `mousemove` may move the local clock at most once a second
  (`ACTIVITY_THROTTLE_MS`).

**"Am I still signed in?" is asked with `GET /api/auth/state`, never with
`touch`.** This is the single most breakable rule in the file. `state` does not
refresh `lastSeen`; `touch` does. Probing with `touch` would renew the very
session being asked about, and the five-minute timeout would never fire for a
tab that is merely open — the feature would silently do nothing while appearing
to work. `visibilitychange`, window `focus`, `online`, the past-budget
heartbeat and the first activity after a long gap all go through
`verifyStillSignedIn()`, which probes state. Only genuine authenticated work
extends a session.

A backgrounded tab has its timers throttled to a crawl, or stopped outright if
the machine slept, so returning to the tab is a forced (unthrottled) probe.

A toast warns `IDLE_WARN_MS` (30s) before the budget runs out.

### On expiry: re-authenticate in place — this is the point of the file

The session is gone and the editor is holding an issue that may never have been
on disk. **Do not reload, and do not navigate to `/login`** — either would take
the tab, and the server would bounce the reload to the sign-in page anyway.
`onDropped()` instead raises the in-page `#auth-gate` with `kind: 'reauth'` and
signs the same person back in via `POST /api/auth/signin`, after which the
overlay is dismissed and *nothing else changes*: no reload, no navigation, no
re-render, and the caret goes back where it was.

Order inside `raiseGate('reauth')` is load-bearing:

1. **Autosave first.** Everything after this only moves pixels, but if one of
   those steps threw, the issue would be behind a gate and not on disk.
   `State.dirty` is deliberately left set — no navigation is happening, so the
   `beforeunload` guard should keep protecting.
2. **Close Settings.** A `<dialog>` opened with `showModal()` lives in the
   browser's *top layer*, above every `z-index` there is, and `inert` on `#app`
   does nothing about it because it is outside `#app`. An open Settings dialog
   would otherwise sit on top of the gate, fully interactive.
3. **Capture focus before setting `inert`.** The moment `#app` goes inert the
   browser blurs whatever was focused inside it and `activeElement` becomes
   `<body>`.

`body.is-relocked`, not `body.is-locked` — see **Markup** below. The gate says **why** in its
own words, from the server's `code` — `IDLE`, `EXPIRED`, `NO_SESSION`, or no
code at all when we found out by probing state. Saying "you were idle for five
minutes" after a server restart is a small lie that costs a support
conversation, because the person knows perfectly well they were typing. Every
variant ends with the same reassurance that the issue is safe.

`reloadCleanly()` survives for the paths that genuinely do reload — the Sign
out button and self-deletion. It autosaves, clears `State.dirty` so
`beforeunload` cannot block the reload, and reloads; the server sends that
reload to `/login`, which is the only way to be certain no rendered newsletter
is left on screen.

### The lapsed-session test is the CODE, never the status

Every Settings action that hits the network goes through `afterServer(res)`,
which raises the re-auth gate for `IDLE`, `EXPIRED` and `NO_SESSION` **only**.

This bit once, and will again: `POST /api/auth/password` answers **401
`BAD_CREDENTIALS`** when you mistype your *current* password — the session is
perfectly fine. An earlier version read the 401 alone, threw the sign-in gate
over the whole app, and told the user nothing about the typo.

### Password storage

**On the server** — `server/accounts.js`, §14, `docs/AUTH-API.md` §5.
PBKDF2-HMAC-SHA256, a fresh 16-byte salt per user, **310,000 iterations**,
32-byte output, compared with `crypto.timingSafeEqual`. Identical parameters to
the browser version that preceded it, so nothing got weaker by moving.

The browser no longer hashes anything, which **eliminates** the worst failure
this app ever had: `crypto.subtle` requires a secure context, so serving the
site from a VM over plain `http://` used to switch accounts off entirely, and
the gate had to stand down loudly and explain itself. That whole apparatus —
the degraded-mode notice, the `Continue without signing in` button, the
`verify.js` init script that removed `isSecureContext` — is gone, because the
condition it handled can no longer occur. The browser's secure-context rule is
not involved in this app at all any more. It is not something to reinstate.

`MIN_PASSWORD` (8) and `MAX_NAME` (40) are duplicated here as *pre*-validation
only. They must never be **more permissive** than the server, or the UI
promises something the server then refuses, and they carry the **same `code`**
the server would have sent (`WEAK_PASSWORD`, `BAD_NAME`) — a caller branching
on `code` must not have to care whether the rejection travelled to the server
or was caught locally. That difference is exactly what makes a UI behave one
way on a fast network and another on a slow one.

### Rules

Enforced **on the server**, which is what makes them enforcement rather than
decoration. The UI hides what you may not do; the server is what refuses:

- The **first** account is created at `/setup` with a one-time token and is
  always an administrator. There is **no built-in account and no default
  password**.
- Only an administrator may add a user or remove **someone else**
  (`403 NOT_ADMIN`).
- Anyone may remove **themselves**, which destroys their session and clears the
  cookie.
- **The last administrator can never be removed** (`409 LAST_ADMIN`), by either
  route. Without that guard a parish is left with accounts and nobody able to
  manage them, and the only way out is shell access. The UI renders **no**
  remove button in that case rather than a disabled one.
- Changing your own password requires the current one, so someone who walks up
  to an unlocked screen cannot lock the real user out. It rotates the salt and
  invalidates that user's **other** sessions, keeping the one that made the
  change.
- Names are unique case-insensitively, 1–40 characters from
  `[A-Za-z0-9 ._-]`, stored as typed; passwords are ≥ 8 characters.

Two client-side rules exist on top, and are about *not building* rather than
*hiding*:

- **A non-administrator must never have the roster built**, not merely hidden.
  An earlier version left the whole people list — remove button per person and
  all — sitting in the DOM of anyone who opened Settings. The server 403s
  `GET /api/users` for them now; that is a reason not to ask, not a reason to
  relax here. `#settings-user-list` is emptied and the section is not shown.
- A `403 NOT_ADMIN` on the roster means our cached role is **stale** — someone
  was demoted since the page loaded. Believe the server, drop the section, and
  re-read identity.

### API

**Everything that touches an account now crosses a network.** `users()`,
`signOut()`, `removeUser()`, `hasAccounts()`, `diagnose()` and `checkIdle()`
used to return synchronously and now return Promises. This is the one change
most likely to break a caller silently, because `if (Auth.hasAccounts())` is
still perfectly valid JavaScript and is now always true.

```js
Keys.Auth.mode                                // SYNC 'served' | 'offline'
Keys.Auth.currentUser()                       // SYNC {name,role,createdAt,lastSignInAt} | null
Keys.Auth.isAdmin()                           // SYNC bool — a UI hint; the server enforces
Keys.Auth.idleFor()                           // SYNC ms since THIS TAB saw activity
Keys.Auth.IDLE_MS                             // the server's budget, adopted from /api/auth/state
Keys.Auth.MIN_PASSWORD                        // 8 — must match the server

Keys.Auth.start(boot)                         // app.js hands boot over
Keys.Auth.hasAccounts()                       // Promise<bool>  (offline: always false)
Keys.Auth.users()                             // Promise<{users:[…]}|{error,code}>  admin only
Keys.Auth.signIn(name, pw)                    // Promise<{user}|{error,code,retryAfterMs}>
Keys.Auth.signOut()                           // Promise<{signedOut:true}|{error,code}>
Keys.Auth.addUser(name, pw, role)             // Promise<{user}|{error,code}>  admin only
Keys.Auth.removeUser(name)                    // Promise<{removed,self}|{error,code}>  BY NAME
Keys.Auth.changePassword(current, next)       // Promise<{changed:true}|{error,code}>
Keys.Auth.openSettings() / closeSettings()

Keys.Auth.checkIdle()                         // Promise<'active'|'warning'|'expired'
                                              //         |'no session'|'unknown'|'offline'>
Keys.Auth.diagnose()                          // Promise<{…, summary}>

Keys.Auth.resetAllAccounts()                  // THROWS — see below
Keys.Auth.createFirstAdmin()                  // THROWS — see below
```

Points that are easy to get wrong:

- **`removeUser` is keyed by NAME, not by a local id.** Server accounts have no
  id; the route is `DELETE /api/users/:name`.
- **In offline mode every network-backed call resolves `{ error, code:
  'OFFLINE' }`** rather than issuing a doomed fetch that will never be answered.
- **`signOut()` does not clear the screen.** A rendered newsletter is still on
  display when it resolves. Clearing is the caller's job — the Sign out button
  follows it with `reloadCleanly()`, which the server bounces to `/login`, and
  that is the only way to be certain nothing is left visible.
- **`checkIdle()` always makes the request**, with no throttle, because that is
  what makes it useful as a test hook: a check that answers `'active'` from a
  variable has verified nothing. The automatic paths use the throttled
  internals instead.
- `currentUser()` and `isAdmin()` answer from the last thing the server said.
  Nothing is authorised on their strength.

`diagnose()` answers "why am I / am I not seeing a gate?" with the **server's**
view rather than a guess: mode, protocol, host, whether the connection is
encrypted, whether the server is reachable, whether any accounts exist, who is
signed in, and a plain-English `summary` naming the reason. With no accounts
yet it names `/setup` and the setup token — which is the direct answer to "I
cloned it onto a VM and was never prompted to create an administrator".

`resetAllAccounts()` and `createFirstAdmin()` **throw**, with a message naming
the replacement. They are kept as loud failures rather than deleted because
both were documented paths and a bare `TypeError` teaches nobody anything. A
browser cannot wipe a server's accounts, and pretending otherwise would be the
sort of comfortable lie this app is built to avoid.

### Markup

`#auth-gate` (outside `#app`, covers it, marked `inert`) and
`#settings-dialog` (a native `<dialog>`, reusing the `.dlg` pattern from the
file-name prompt). The gear is `[data-act="settings"]`, in the same toolbar
group as and immediately beside `[data-act="theme"]` — `verify.js` asserts that
adjacency.

**Two lock classes on `<body>`, and the difference is not cosmetic:**

| Class | When | `#app` |
|---|---|---|
| `is-locked` | `kind: 'boot'` — nothing has been rendered | `display: none` |
| `is-relocked` | `kind: 'reauth'` — an issue is open behind the gate | **stays laid out** |

`display: none` on the re-auth path would throw away scroll positions, collapse
the editor and make signing back in feel like a reload — the one thing that
path exists to avoid. The gate's own background is opaque, so the newsletter is
covered either way.

Removed from `index.html` when accounts moved to the server, and not to be
restored: `#auth-degraded` (the secure-context notice), `#auth-confirm-field` /
`#auth-confirm` (the gate no longer creates the first account — `/setup` does)
and `#auth-hint`. See `docs/CLASSES.md` for the trap in the CSS this left
behind.

Added: `#settings-insecure` (`.set-warn`, the plain-http warning),
`#settings-offline` (`.set-offline`, the file:// note), `#settings-signout`,
`#settings-password-section`, `#settings-account-section` and
`#settings-me-h` — whose text is "Signed in" served and "Accounts" offline,
because "Signed in" is a heading that would be lying where nobody is signed in
and nobody can be.

`.auth-notice` and `.set-notice` are **empty in the markup on purpose** and
filled by `refreshNotices()`. The truthful sentence differs by mode, so
hard-coding one in `index.html` guarantees that one of the two modes ships a
lie.

### There is deliberately no test bypass

`tools/verify.js` signs in by driving the real form. Do not add a query
parameter, global, or build flag that skips the gate: it would be a genuine
hole in shipped code — the server-side gate is a real boundary now, so a bypass
is a real vulnerability, not an embarrassment — and it would stop the sign-in
path being exercised on every run.

## 13. `stash.js` — the save-for-later drawer  → `Keys.Stash`

A cabinet drawer down the right edge of `#preview-pane`. The handle is always
visible; clicking it slides the drawer out over the canvas.

### Why the stash is NOT part of the document

It would be the obvious place, and it would be wrong. The point of stashing a
lunch slip is to use it again in a **later issue**, so the drawer has to outlive
the document it was filled from. Kept in `doc`, every Load would overwrite the
library with whatever that file contained, and starting next week's issue would
empty it. So it lives in its own `localStorage` key — per browser, like the
theme, not per newsletter. (Accounts used to be the other example here; they
are on the server now — §12, §14.)

The trade-off is real and is stated in the UI: e-mailing someone the `.json`
does not send them the saved boxes. `verify.js` asserts both halves — that
`State.toJSON()` contains no stash, and that `State.replace()` leaves it alone.

### Storage

`stpeters.keys.stash.v1` → `{ version, seeded, items: [...] }`, each item:

```js
{ id, name, kind, savedAt, payload }
```

- `kind` exists so this can hold more than lunch slips later. **`slip` is the
  only implemented kind**; anything else is refused by `add()` rather than
  half-stored, and dropped on read. Adding a kind means teaching `describe()`,
  `suggestName()` and `restore()` about it — nothing else cares.
- `seeded` records that first-run seeding has happened, so **emptying the
  drawer does not refill it** behind the user's back.
- On the very first read the drawer is seeded from `doc.slips`, so it opens
  with something in it and the feature explains itself.
- Items with no usable `payload`, or an unknown `kind`, are discarded on read.
  A drawer that throws on open would take the preview pane down with it.
- Capped at `MAX_ITEMS`, with an explanation rather than silent loss.

### Behaviour

- **Stashing copies, it never moves.** The box stays on the page. Both entry
  points — the `slip-stash` button on the editor card and the drag onto the
  drawer — funnel through `Stash.stashSlip(id)`, so they cannot drift apart.
- **Restoring copies too**, and assigns a **fresh slip id**: the stashed box may
  still be on the page, and two boxes sharing an id makes every delete and
  reorder ambiguous.
- Names come from `suggestName()`, which takes the **first line** of the
  heading. `textContent` alone runs a multi-line heading together into
  `THIS THURSDAY, 5/28FOR LUNCHHOTDOG…`.
- The drawer's naming prompt is `Keys.App.askName` — the same dialog as the
  file-name prompts, with `label`, `ext: ''` and a `clean` function passed in.
  One dialog, one focus/settle/escape implementation.

### Drag-and-drop (arrange.js)

`stashTargetAt()` in `arrange.js` hit-tests **the drawer and its handle
separately**. The handle hangs off the drawer's left edge, *outside* its box,
and a closed drawer is translated fully off the right of the pane — so its own
rect is off-screen and the only part the user can aim at is the one part that
hit-testing the parent misses.

A drop on the drawer deliberately **bypasses `commit()`**: nothing on the page
changes, so there is no layout to guard, and running the overflow check would
let a full page refuse a save that cannot overflow anything.

### Markup and CSS

`#stash` is `position: absolute` inside `#preview-pane`, which is
`position: relative; overflow: hidden` — so the closed drawer is genuinely
clipped away rather than merely hidden. The **whole aside slides**, handle
included; the handle is offset left by its own width, so what remains on screen
when the aside is pushed off the right edge is exactly the handle.

- `.stash-list` is the scrolling region: `flex: 1 1 auto; min-height: 0`.
  Without `min-height: 0` the list grows and pushes the drawer past the pane.
- `.stash-item` is a **two-row grid**. Side by side, three buttons left about
  150px of a 288px drawer for the name, so every label came out as
  `THIS THURSDAY, …` — which defeats the point of naming them.
- The closed panel carries `inert`, or its buttons stay in the tab order and
  focus disappears off the edge of the pane.

### API

```js
Keys.Stash.items()                    // [{id,name,kind,savedAt}] — no payloads
Keys.Stash.count()
Keys.Stash.add(name, kind, payload)   // {item}|{error}  — copies the payload
Keys.Stash.remove(id) / rename(id, name)
Keys.Stash.restore(id)                // {restored}|{error} — copies back
Keys.Stash.clear()
Keys.Stash.stashSlip(slipId)          // prompt for a name, then add
Keys.Stash.open() / close() / toggle() / isOpen()
Keys.Stash.suggestName(slip)
```

## 14. `server/` — the account server

Node, CommonJS, **zero dependencies**. Not part of `window.Keys`, not loaded by
`index.html`, and sharing no code with the browser side. The only contract
between the two halves is `docs/AUTH-API.md`, which is authoritative: **if
something there is wrong, fix that file first and then both sides.**
`server/README.md` is the operator's guide — running it, `systemd`, TLS,
backups, recovery — and is not repeated here.

```
server/server.js          listener, routing, security headers, static
                          allowlist, the JSON API, graceful shutdown
server/accounts.js        password hashing, validation, accounts.json,
                          the last-administrator rule, the setup token
server/sessions.js        in-memory sessions and both expiry clocks
server/ratelimit.js       the sign-in backoff
server/login.html         served at /login
server/setup.html         served at /setup
server/reset-accounts.js  CLI: the way back in
server/data/              created on first run, mode 0600, gitignored
```

**No `package.json`, no `node_modules`, no lockfile, and there must never be
one.** Only `node:http`, `node:https`, `node:crypto`, `node:fs`, `node:path`
and `node:url`. A parish runs this unattended for years, and every package
added is something somebody has to patch long after they stopped thinking about
it.

### The static handler is an ALLOWLIST

The tempting shape is "serve the repository, but refuse `docs/`, `tools/`,
`server/` and dotfiles". That shape is wrong in a way that only shows up later:
a denylist has to enumerate every *future* mistake, and the day somebody drops
`backup.sql`, `notes-with-the-wifi-password.txt` or a `.env` into the project
root, it is served and nobody finds out until it is indexed.

Exactly four things are reachable, and everything else is a 404 by default:

| Route | Unauthenticated | Authenticated |
|---|---|---|
| `GET /` | `302 /setup` if no accounts exist, else `302 /login` | `200 index.html` |
| `GET /login` | the sign-in page | `302 /` |
| `GET /setup` | the first-run page, or `302 /login` if accounts exist | `302 /` |
| `GET /assets/css/app.css` | `200` — allowlisted | `200` |
| `GET /assets/**` (anything else) | `401` | `200` |
| anything else | `404` | `404` |

- **`/assets/css/app.css` is the one unauthenticated asset**, written as an
  exact path so it can never widen into a prefix by accident. The sign-in and
  setup pages are styled by it, so it must be readable before sign-in; it gives
  away the colour of the buttons and nothing else. Everything else under
  `assets/` needs a session, which is why the application JavaScript is not
  readable by a stranger.
- **Extensions are an allowlist too** (`MIME`). An unknown extension is a 404,
  so an accidentally committed `assets/notes.md` or `assets/keys.pem` is not
  served and nothing is ever sent with a guessed `Content-Type`.
- **Three independent traversal layers, all needed.** `parsePath()` decodes
  **exactly once** and then checks segment by segment — a second decode is how
  `%252e%252e` becomes `..` — and rejects `.`/`..`, dotfiles, NUL bytes and
  backslashes. `resolveAsset()` then does a lexical containment check, and then
  a `realpath` check. The segment check stops `..`; the lexical check stops a
  path resolving outside the root; only the `realpath` check stops a **symlink
  inside `assets/`** pointing at `/etc/shadow`.
- Assets are sent `private, no-cache`, so no shared proxy keeps a copy and the
  browser revalidates — which means the authentication check above runs every
  time rather than once.
- `docs/`, `reference/`, `tools/`, `server/` and dotfiles are **never** served.

### CSRF: one rule, applied before routing

Every non-`GET` request must satisfy **all** of:

1. `Content-Type: application/json`,
2. `Origin` (or `Referer` when `Origin` is absent) matching the request's own
   `Host` — and, under TLS, an `https:` origin, because an `http:` one on the
   same host means something stripped the transport,
3. the `keys_sid` cookie being `SameSite=Strict` (browser-enforced).

Failing any of them is `403 { code: "CSRF" }`. The check runs **before any
routing**, so a new endpoint added later cannot quietly miss it.

- **Both headers absent is a refusal, not a pass.** Browsers send `Origin` on
  every non-`GET`; a caller that sends neither is a script, and a script can
  send the header. "Allow when unsure" is how CSRF checks come to be worth
  nothing.
- **The content-type rule applies to `DELETE`, which has no body.** So
  `DELETE /api/users/:name` must still carry `Content-Type: application/json`
  or it is refused — the one place this is easy to get wrong, and the client
  sends it unconditionally. It is kept rather than exempted because "all
  non-GET requests carry this header" is a rule a reader can check at a glance,
  whereas "all except `DELETE`, because that one leans on the `Origin` leg
  alone" is the kind of carve-out that quietly grows.
- **There is no `OPTIONS` handler and no `Access-Control-Allow-*` header
  anywhere, and that is the mechanism, not an omission.** A cross-origin
  `fetch()` sending `Content-Type: application/json` needs a successful
  preflight; the preflight falls into this same check, gets a `403` with no
  CORS headers, and the real request is never sent.

### Sessions: two clocks, both server-side

- Cookie `keys_sid`: 32 random bytes, base64url, `HttpOnly; SameSite=Strict;
  Path=/`, and `Secure` **only** under real TLS. No `Max-Age` and no `Expires`,
  so it is a session cookie and closing the browser ends it too.
- **The server stores `sha256(token)`, never the token.** A heap dump or a
  stray log line then yields nothing usable.
- **Idle**: `KEYS_IDLE_MS` (default 5 minutes) since the last *authenticated*
  request. **Absolute**: 12 hours since sign-in, not configurable. In memory,
  so a restart signs everyone out — acceptable, and slightly safer than
  persisting them. That is a sign-in prompt, not lost work: the newsletter
  autosaves continuously.
- Expiry is reported as a **distinct code** — `IDLE`, `EXPIRED`,
  `NO_SESSION` — because the gate says why, and "you were idle for five
  minutes" after a server restart is a small lie that costs a support call.
- **`GET /api/auth/state` must never refresh `lastSeen`, and this is
  load-bearing.** It is the client's only read-only "am I still signed in?"
  probe (§12). If it refreshed the idle clock, every probe would become a
  keepalive and the timeout would never fire for a tab that is merely open —
  the feature would silently do nothing. Only `touch` and genuine authenticated
  work extend a session.
- Changing a password rotates the salt and destroys that user's **other**
  sessions, keeping the one that made the change.

### Accounts

PBKDF2-HMAC-SHA256, **310,000** iterations, 32-byte key, per-user 16-byte
random salt, compared with `crypto.timingSafeEqual`. Sign-in does the same
amount of work for an unknown name as for a wrong password, and returns the
same `401 BAD_CREDENTIALS`, so neither reveals who has an account.

- Stored in `KEYS_DATA/accounts.json`, mode `0600`, and **written atomically**:
  temp file in the same directory, `fsync`, then `rename`. This is
  load-bearing. A crash halfway through a plain `writeFile` leaves a truncated
  file, which on the next start is an accounts file with no administrator and
  no setup token to make one — a permanently locked-out parish. Do not simplify
  it.
- **A corrupt `accounts.json` makes the server refuse to start**, loudly.
  Treating an unreadable file as "no accounts exist" would silently turn a
  damaged file into an open `/setup` for whoever found it first.
- Rate limiting is per `(IP, lowercased name)`: 5 free attempts, then a
  doubling delay from 1s capped at 5 minutes, decaying after 15 minutes of
  quiet, cleared by a successful sign-in. `X-Forwarded-For` is believed **only**
  when `KEYS_TRUST_PROXY` is set — without that guard anyone can send a
  different value on every request and get a fresh budget each time, which is a
  rate limiter that looks like protection and is not.

### First run: the setup token

With no accounts, the server generates a one-time token, prints it in a banner
at **every** start in that state, and writes it to `KEYS_DATA/setup-token.txt`
at mode `0600` for an admin who has lost the console. `GET /` sends a fresh box
to `/setup` rather than to a sign-in form for an account nobody has yet. The
token is consumed on success, after which `/setup` answers `403 SETUP_DONE`
forever.

It exists so that the administrator account cannot be claimed by whoever
reaches the box first on a shared network — without it, "deploy the app" and
"hand the parish newsletter to a stranger" are the same act. It is also the
direct answer to *"I cloned it onto a VM and was never prompted to create an
administrator"*: the prompt is now unmissable, in the console and at `/setup`.

**The setup token is the only secret this process ever prints.** No password,
no session token, no hash appears in any log line — and printing the token *is*
its job, useless the moment the first account exists.

Recovery is `node server/reset-accounts.js` (`--yes` to skip the
confirmation). It lists the accounts, requires the operator to type `DELETE`,
removes `accounts.json` and issues a fresh token. It knows about two files in
`KEYS_DATA` and nothing else, so it **never touches newsletter content**; it
destroys accounts rather than revealing them; and it needs shell access, which
is a strictly higher bar than knowing a password.

### Configuration

Environment variables only — `docs/AUTH-API.md` §7 is the authoritative table.
`KEYS_PORT`, `KEYS_HOST`, `KEYS_DATA`, `KEYS_IDLE_MS`, `KEYS_TLS_CERT` +
`KEYS_TLS_KEY` (both or neither), `KEYS_TRUST_PROXY`.

Two things are deliberately not configurable: the 12-hour absolute session
ceiling and the 310,000 PBKDF2 iterations. Both are floors, not preferences.

### Traps worth knowing before you change anything here

- **`Secure` on the session cookie must track real TLS.** A `Secure` cookie
  arriving over plain `http` is stored and then never sent back: sign-in
  appears to succeed, the redirect to `/` lands, the server sees no cookie and
  bounces to `/login`. From outside that is an endless loop with no error
  anywhere, and every instinct says the password is wrong. Do not "harden" it
  by making it unconditional.
- **`'unsafe-inline'` in the Content-Security-Policy is not laziness.** The
  shrink-to-fit machinery writes inline styles (§4), `state.js` re-applies a
  sanitised `style` attribute to pasted markup, and `index.html` runs an inline
  theme bootstrap before the stylesheets. Tightening `style-src` produces no
  error anybody notices — it quietly stops the text fitting the page, which is
  the one thing this application exists to do.
- **`Strict-Transport-Security` is sent only under TLS.** Pinning a parish box
  to HTTPS before it has a certificate makes it unreachable, and the fix then
  lives inside the browser rather than on the server.
- **Plain HTTP is a real limitation and is stated as one.** The server warns at
  every start, reports `"secure": false` from `/api/auth/state`, and the app
  raises `#settings-insecure` when that is false and the host is not localhost.
  The sign-in is a genuine access-control boundary; it is not confidentiality,
  and the newsletter is not encrypted at rest anywhere.
