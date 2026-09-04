# St. Peter's Keys

A web-based newsletter generator for St. Peter's Lutheran School.

Open `index.html` in a browser. There is no build step, no install, and no
network access — it runs straight from disk.

## Using it

The window is split in two: the editing rail on the left, the live paper
preview on the right. Everything you type appears on the page immediately.

**The toolbar** across the top holds everything: **Save**, **Load** and **PDF**,
the text formatting controls (bold, italic, underline, font, size, alignment,
bullets), the light/dark theme button, the zoom control, and the page arrows.

The editing rail opens as a collapsed list of the four pages, so you start with
an overview rather than a wall of fields. Click a page's header to open it.
Reloading returns to that collapsed view; your content is kept, the open/closed
state is not.

**Light and dark theme** follow your operating system until you press the theme
button, after which your choice is remembered and wins on every visit. The
newsletter itself is always white with black ink in both themes — it is paper,
and it has to print.

| Action | Shortcut |
|---|---|
| Save to a file | `Ctrl`/`Cmd` + `S` |
| Print or export a PDF | `Ctrl`/`Cmd` + `P` |
| Bold / italic / underline | `Ctrl`/`Cmd` + `B` / `I` / `U` |
| Previous / next page | `Alt` + `←` / `→` |

Two things are remembered between visits, separately from the newsletter
itself: your theme choice, and a working copy of the current issue.

The two panes are linked both ways:

- **Click anything on the preview** to jump straight to the field that feeds
  it. The editor opens the right section, scrolls to the field, focuses it with
  the cursor at the end, and flashes it so you can see where you landed.
  Whole blocks are clickable, not just the text — clicking the empty lower half
  of a calendar day still selects that day, and clicking the calendar's
  **month and year heading** opens the month/year dropdowns. Selecting text on
  the page to copy it does *not* jump, so you can still lift text out of the
  preview.
- **Clicking into a field** turns the preview to that page and highlights the
  region it feeds.

The numbered badges beside each section heading, and the thumbnails under the
preview, also jump between pages.

Work is kept in your browser automatically, so closing the tab by accident
won't lose the issue. **Save** writes a `.json` file you can keep, e-mail, or
reload later with **Load**. Older save files from the previous version of this
tool still load.

## The four pages

1. **Front page** — masthead, Classroom Corner article, and the *This Week* and
   *Looking Ahead* boxes, followed by full-width announcement sections.
2. **Announcements** — more full-width sections. Add, remove and reorder them
   freely.
3. **Lunch slips and forms** — the tear-off boxes. Add or remove whole boxes
   with **+ Lunch Slip**, **+ After School Sign Up**, **+ Custom Box** and
   **+ Starburst**; the input fields follow whatever boxes exist.

   *Lunch slips* let you add and remove individual order lines, each set to
   "blank then label", "label then blank", a plain line, or inline choices.

   *After School Sign Up* builds its own ruled lines and weekday columns. For
   each day you choose **blank line** (to write hours on) or **XXX** for a day
   with no after-school care, such as a holiday or a half day — so you never
   type underscores or nudge spaces around to line the columns up. You can also
   add or remove rate/policy lines and set how many sign-up lines to print.

   *Custom Box* remains for anything the structured boxes don't cover.
4. **Monthly calendar** — pick the month and year from the dropdowns and the
   grid rebuilds itself, always running Sunday through Saturday with the right
   number of week rows. Events are stored per calendar date, so switching months
   and back never loses anything.

Text is shrunk automatically to stay inside its box, so nothing ever runs off
the edge of a printed page. If a box is pushed to its smallest size it gets a
dashed outline on screen as a warning — that outline never prints.

Page 4 prints landscape while pages 1–3 print portrait; the PDF export handles
this for you.

## Layout reference

`docs/pg-1.png` … `docs/pg-4.png` are renders of the May 2026 issue
(`reference/keys_may_25.pdf`), which the layout is modelled on.

## Project layout

```
index.html              markup shell and script/style loading
assets/css/app.css      application chrome (toolbar, rail, canvas)
assets/css/paper.css    the newsletter itself — must match the reference
assets/css/print.css    print/PDF overrides, incl. mixed page orientation
assets/js/state.js      document schema, defaults, save/load, autosave
assets/js/fit.js        shrink-to-fit engine (overflow prevention)
assets/js/flip.js       page-turn animation, zoom and fit-to-view
assets/js/calendar.js   page 4
assets/js/slips.js      page 3
assets/js/render.js     builds the preview pages
assets/js/editor.js     builds the editing rail
assets/js/app.js        bootstrap and event wiring
docs/SPEC.md            module contract — read before changing anything
docs/CLASSES.md         CSS class contract for the paper
tools/verify.js         automated browser checks
```

`docs/SPEC.md` is the contract between these modules. The interfaces and class
names in it are load-bearing — several modules depend on them by string.

## Running the checks

`tools/verify.js` drives a real browser to confirm nothing overflows a page,
the calendar grid is correct, boxes add and remove cleanly, page turns settle,
and saves round-trip. It needs Playwright, which the app itself does not:

```sh
mkdir -p /tmp/keys-verify && cd /tmp/keys-verify
npm init -y && npm i playwright

cd /path/to/StPeters_Keys
KEYS_PLAYWRIGHT=/tmp/keys-verify/node_modules node tools/verify.js
node tools/verify.js --shots --pdf   # also write screenshots and a PDF to tools/out/
```
