# St. Peter's Keys

A web-based newsletter generator for St. Peter's Lutheran School.

Open `index.html` in a browser. There is no build step, no install, and no
network access — it runs straight from disk.

## Signing in

The first time you open it, the app asks you to create the **administrator**
account — there is no built-in account and no default password. After that,
everyone signs in by name and password.

- The **administrator** can add and remove people, from **Settings → People**.
- **Anyone** can change their own password or delete their own account.
- The **last administrator** can't be removed, by themselves or anyone else —
  otherwise nobody would be able to manage accounts again.

Deleting an account never deletes the newsletter. Signing out clears the
session; closing the tab does too.

**You are signed out after 5 minutes of inactivity** and asked to sign in
again. It's five minutes of *not touching anything* — any typing, clicking,
scrolling or mouse movement resets the clock, so it will never interrupt you
mid-article. You get a warning about half a minute before, and your work is
saved automatically first: sign back in and the issue is exactly as you left
it, including edits you hadn't saved to a file.

> ### What this does and doesn't protect
>
> This app is static files opened straight from disk. **There is no server, so
> the sign-in is not a security barrier.** It keeps the newsletter out of the
> way of whoever wanders up to a shared office computer, and records who is
> working on the issue. It cannot stop anyone who has the files: they can open
> the browser's developer tools, edit `assets/js/auth.js`, or read the saved
> `.json` directly.
>
> **So please don't keep anything confidential in the newsletter.**
>
> Passwords themselves are handled properly — hashed with PBKDF2-SHA256, a
> random salt per person and 310,000 iterations — so a password you also use
> elsewhere isn't given away by a glance at browser storage. That is a real
> protection; the login as a whole is not.
>
> Real access control would need a server. See `docs/SPEC.md` §12.

### Putting it on a server

Accounts need a **secure context** — the browser only allows the password
cryptography over `https://`, on `localhost`, or when the file is opened
directly from disk.

**Serving it over plain `http://` on a VM or intranet box switches accounts
off**, because `crypto.subtle` simply isn't there. The app says so on the
first screen and in the browser console rather than quietly opening with no
sign-in. To fix it, do any one of:

- put a certificate on it and serve `https://` (Let's Encrypt, or a self-signed
  certificate for an internal box);
- reach it through an SSH tunnel, so the browser sees `localhost`:
  `ssh -L 8080:localhost:80 user@your-vm`, then open `http://localhost:8080`;
- or just open `index.html` from disk, which is what the app is designed for.

**Not being prompted to create an administrator?** Open the browser console and
run:

```js
Keys.Auth.diagnose()
```

It reports, in one object, whether the page is in a secure context, whether
`crypto.subtle` exists, whether storage works, how many accounts there are, and
a plain-English `summary` of which of those is the reason. The usual answers
are the `http://` problem above, or that accounts already exist on that browser
profile — accounts live in that browser's storage, so each machine and each
profile sets up separately.

To start over — a forgotten administrator password, or a half-finished setup —
run this in the console and reload:

```js
Keys.Auth.resetAllAccounts()
```

It clears every account and **leaves the newsletter untouched**.

## Using it

The window is split in two: the editing rail on the left, the live paper
preview on the right. Everything you type appears on the page immediately.

**The toolbar** across the top holds everything: **Save**, **Load** and **PDF**,
the text formatting controls (bold, italic, underline, font, size, alignment,
bullets), the **template** dropdown, the **settings** gear, the light/dark theme
button, the zoom control, and the page arrows.

The editing rail opens as a collapsed list of the four pages, so you start with
an overview rather than a wall of fields. Click a page's header to open it.
Reloading returns to that collapsed view; your content is kept, the open/closed
state is not. An open section keeps its title pinned to the top of the rail
while you scroll through its fields, so you can always see which page you are
editing.

## Templates

The **template** dropdown in the toolbar picks the page layout:

- **Contemporary** — the long-standing look. Serif type, one wide column with
  a ruled *This Week* / *Looking Ahead* rail down the right, and full-width
  announcement sections.
- **Modern** — sans-serif. The front page runs three columns: an introduction,
  the cross-and-book emblem and *Bible Inspo* on the left, Classroom Corner in
  the middle, and the agendas plus a *Contact Us* block on the right. There is
  a large date band under the masthead, ruled section headings, and a running
  foot with the website and page number. Announcement pages run two columns.

**The lunch slips and calendar pages are the same in both** — only the front
and announcement pages change.

Switching is safe and reversible: it is one document with two presentations, so
nothing is converted, copied or thrown away. Each template needs a few fields
the other doesn't (Modern has the introduction, *Bible Inspo* and volume line;
Contemporary has the motto and the Classroom Corner verse), and the editing
rail shows only the ones the current template prints. The rest are still in
your newsletter and come straight back when you switch. The choice is saved
with the file, so a newsletter always reopens in the layout it was built for.
Files saved before templates existed open as Contemporary.

Because Modern divides the front page into three narrower columns, it holds
less text at full size than Contemporary does. A very full issue will be shrunk
to fit rather than spill — see the note about auto-shrinking below.

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

Three things are remembered between visits, separately from the newsletter
itself: your theme choice, the accounts, and a working copy of the current
issue. Your sign-in is remembered only until you close the tab.

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
- **Drag sections around the preview.** Hover a section and a grip appears at
  its top-left corner; drag it to a new position and a blue line shows where it
  will land. Announcements, lunch-slip boxes and the *This Week* / *Looking
  Ahead* boxes can all be moved. Drag an announcement onto a **page thumbnail**
  to send it to that page. The grip is a button, so you can also just focus it
  and use the arrow keys.

  Sections move between slots rather than to free positions, so they can never
  overlap. And every move is checked: if it would push a page past what will
  fit, or shrink the text too far to read, the move is undone and you are told
  why.

The numbered badges beside each section heading, and the thumbnails under the
preview, also jump between pages.

Work is kept in your browser automatically, so closing the tab by accident
won't lose the issue. **Save** writes a `.json` file you can keep, e-mail, or
reload later with **Load**. Older save files from the previous version of this
tool still load.

**Save** and **PDF** both ask for a file name first, and suggest one built from
the date on page 1 — `SP_Keys-May26_2026` for the 26 May 2026 issue. The
suggestion is greyed-out placeholder text, so you can press `Enter` to take it
or just start typing to replace it. For a PDF the name is what the browser's
own print dialog will suggest once you choose **Save as PDF** as the
destination; you can still change it there.

## The pages

1. **Front page** — masthead, Classroom Corner article, and the *This Week* and
   *Looking Ahead* boxes, followed by full-width announcement sections. Modern
   adds an introduction block, the emblem and *Bible Inspo* down the left.
2. **Announcements** — more sections, full width under Contemporary and two
   columns under Modern. Add, remove and reorder them freely.

   Long issues can run to **as many announcement pages as you need**. Use
   **+ Add page** at the end of the thumbnail strip under the preview, or the
   button at the bottom of the Announcements section in the editor. New pages
   are inserted after the existing announcements, and the Lunch Slips and
   Calendar pages renumber themselves. Each page has its own group of sections
   in the editor, with an ✕ to remove it; the issue always keeps at least one.
3. **Lunch slips and forms** — the same under both templates. The tear-off
   boxes. Add or remove whole boxes
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
4. **Monthly calendar** — also the same under both templates. Pick the month
   and year from the dropdowns and the grid rebuilds itself, always running
   Sunday through Saturday with the right number of week rows. Events are
   stored per calendar date, so switching months and back never loses anything.

Text is shrunk automatically to stay inside its box, so nothing ever runs off
the edge of a printed page. If a box is pushed to its smallest size it gets a
dashed outline on screen as a warning — that outline never prints.

Page 4 prints landscape while pages 1–3 print portrait; the PDF export handles
this for you.

## Layout reference

`docs/pg-1.png` … `docs/pg-4.png` are renders of the May 2026 issue
(`reference/keys_may_25.pdf`), which the **Contemporary** layout is modelled on.

The **Modern** layout is modelled on `reference/Keys_Modern-Page1.png` (front)
and `reference/Keys_Modern-Page2.png` (announcements).

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
assets/js/arrange.js    drag-to-reorder sections, with the overflow guard
assets/js/render.js     builds the preview pages
assets/js/editor.js     builds the editing rail
assets/js/auth.js       accounts, the sign-in gate, the Settings panel
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
