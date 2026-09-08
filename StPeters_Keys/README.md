# St. Peter's Keys

A web-based newsletter generator for St. Peter's Lutheran School.

There is no build step and there are no packages to install — no `npm install`,
no `node_modules`, no lockfile. Node.js itself is the only thing any of this
needs, and the desktop launcher will install that for you if it's missing.

There are **three ways to run it**, and they behave differently on purpose:

| | How you start it | Accounts | Who can reach it |
|---|---|---|---|
| **Desktop** | double-click `desktop/StPeters-Keys.command` (Mac) or `.bat` (Windows) | none | this computer only |
| **Shared server** | `node server/server.js` | yes, on the server | anyone you give an address and a password to |
| **Straight from disk** | open `index.html` in a browser | none | anyone with the files |

- **Desktop** is for one person on their own machine. It starts a small server
  on `127.0.0.1`, so nothing else on the network can see it, and there is
  nothing to sign in to. See [`desktop/README.md`](desktop/README.md).
- **Shared server** is for a school office, a VM, or anybody who is not you.
  The sign-in is a real lock: nothing reaches a browser without a valid
  session.
- **Straight from disk** needs nothing at all, not even Node — but the browser
  is stricter about local files, and Safari in particular can refuse to keep
  the automatic backup. Prefer **Desktop** if you have the choice.

Everything else — the editor, the templates, the drawer, the PDF export — is
identical in all three.

## The desktop version

Double-click the launcher for your system:

| | |
|---|---|
| **macOS** | `desktop/StPeters-Keys.command` |
| **Windows** | `desktop/StPeters-Keys.bat` |

A small console window opens and the newsletter appears in your usual browser.
Leave that window alone while you work; closing it stops the newsletter.

It needs **Node.js 20 or newer**, and that is the only thing it needs. If it
isn't already on the machine the launcher explains what Node is, asks whether
to install it, and — if you say yes — installs it for you: Homebrew or the
official installer on a Mac, `winget` or the official installer on Windows.
Say no and it falls back to opening `index.html` directly, so you can still
work; it tells you what you give up by doing that.

There are **no accounts, no sign-in and no timeout** in this version. What
makes that safe is one rule in the server: with `KEYS_LOCAL=1` it listens on
`127.0.0.1` and **refuses to start** on any other address. No environment
variable relaxes that. Switching authentication off while listening on the
network would hand the newsletter, and a working editor for it, to every
machine on the wifi — and from the machine that started it, it would look
exactly like a working desktop app.

[`desktop/README.md`](desktop/README.md) covers this for a non-technical
reader, including what the security warnings on first launch mean.

## The shared server

Node 20 or later, nothing to install:

```sh
node server/start.js        # start it
node server/stop.js         # stop it
```

`node server/server.js` still works and is what actually runs; the two scripts
above just wrap it with the bits you want when starting it by hand:

- **`start.js`** repeats the first-run **setup token** as the *last* thing on
  screen, after the startup lines and the TLS warning — which is otherwise
  exactly where it scrolls out of view. It prints every address the server can
  be reached at rather than only `localhost`, so browsing from another machine
  doesn't involve guesswork. And it refuses to start a second copy on a port
  that already answers instead of leaving an `EADDRINUSE` trace to interpret.
  On every run after the first there is no token to catch, so it just starts
  the server. `--background` detaches it and logs to a file.
- **`stop.js`** stops every copy of **this** project's server, including ones
  started by hand without `start.js`. `--dry-run` lists them and stops nothing.

On **Alpine** (including an LXC container), `apk add nodejs` is all the setup
there is — Node 20 or newer ships from Alpine 3.19. Both scripts work there
unchanged and need neither `ps` nor `lsof`: on Linux they read `/proc`
directly, because BusyBox's `ps` doesn't accept the flags the alternative would
have required. Alpine uses **OpenRC rather than systemd**, so see the OpenRC
service file in [`server/README.md`](server/README.md) — and note that
`stop.js` has to be run *inside* the container, since PIDs differ from the
host's.

There are also two shell wrappers that bring the app and its **nginx** proxy up
and down together:

```sh
./server/alpine-start.sh     # start the server, then nginx
./server/alpine-stop.sh      # stop nginx, then the server
```

The orders are opposite on purpose. nginx is the proxy in front, so on the way
up the app must exist before nginx forwards to it — otherwise that window is
served as 502s — and on the way down the front door closes first, so no
request reaches a backend that is shutting down. If the app fails to start,
nginx is deliberately left alone: a proxy with nothing behind it hides the real
error.

`alpine-start.sh` also **writes the nginx site config** if it isn't already
there, so a deployment script that clones the repo and runs it needs no manual
nginx step. It's idempotent — an already-correct config is left alone, an
out-of-date one is rewritten and backed up, and a config the script didn't
write is never overwritten without `--force-conf`. `--check-conf` prints what
it would write and changes nothing.

Both need root, and take `--skip-nginx` if you only want the app.
They're `#!/bin/sh` rather than `#!/bin/bash` on purpose: Alpine has no bash in
the base image, and a bash shebang there fails with "not found" — which reads
as though the script is missing rather than the shell.

`stop.js` is careful about what it signals, on purpose. A process qualifies
only if it is a Node binary running *this* checkout's `server/server.js`,
compared as a resolved absolute path. So a second copy of the project on the
same machine is left running, and nginx, Apache, `python -m http.server` and an
editor's live preview are never touched — even when one of them is the reason
the app is misbehaving. Stopping somebody's web server isn't this script's
business; `whats-serving.js` will tell you if one is in the way.

However you start it, the server prints the address it is listening on, and on
a fresh machine a **setup token**. Open the address, paste the token, create
the administrator account. That is the entire installation.

### First run: the setup token

**If you have just cloned this onto a VM and nothing ever asked you to create
an administrator, this is the section you want.** The app no longer prompts
you in the browser — the *server* does, in its console, at every start until
an account exists:

```
────────────────────────────────────────────────────────
  FIRST-RUN SETUP
  Open   http://localhost:8749/setup
  Token  4KJ2-9WQX-7ATB-1MZP
────────────────────────────────────────────────────────
```

Start with `node server/start.js` and you get that again at the very end,
after the warnings, together with every address the server answers on:

```
────────────────────────────────────────────────────────────
  FIRST RUN — create the administrator account now

  Token   4KJ2-9WQX-7ATB-1MZP

  Open one of these and paste the token in:
      http://localhost:8749/setup
      http://192.168.1.228:8749/setup
────────────────────────────────────────────────────────────
```

That second address is the one you want from another machine. Reaching for
`localhost` from a different computer is a common way to end up staring at the
"this is not the St. Peter's Keys server" panel with a perfectly good server
running.

Lost the console — started it from `systemd`, or closed the window? The same
token is on disk:

```sh
cat server/data/setup-token.txt        # or $KEYS_DATA/setup-token.txt
sudo journalctl -u keys -f             # if you run it as a service
```

Capitals and hyphens don't matter when you type it in. Until the first account
exists, `/` sends you to `/setup` rather than to a sign-in form for an account
nobody has yet; the moment it does exist the token is spent and `/setup` is
closed for good.

The token is there so the administrator account can't be claimed by whoever
reaches the machine first. On a shared network, "deploy the app" and "hand the
parish newsletter to a stranger" would otherwise be the same act.

### Configuration

Environment variables, all of them optional:

| Variable | Default | Meaning |
|---|---|---|
| `KEYS_PORT` | `8749` | Listen port |
| `KEYS_HOST` | `0.0.0.0` | Listen address; `127.0.0.1` for local-only |
| `KEYS_DATA` | `server/data` | Where `accounts.json` lives |
| `KEYS_IDLE_MS` | `300000` | Idle timeout, in milliseconds |
| `KEYS_TLS_CERT`, `KEYS_TLS_KEY` | — | If **both** are set, the server speaks HTTPS |
| `KEYS_TRUST_PROXY` | `0` | Trust `X-Forwarded-For`/`-Proto` from a reverse proxy |
| `KEYS_LOCAL` | unset | Desktop mode: no accounts, `127.0.0.1` only. See above |
| `KEYS_LOCAL_IDLE_MS` | `3600000` | Desktop mode only: quit after this long with no requests; `0` never quits |

Two things are deliberately not configurable: a session expires after 12 hours
however busy you have been, and passwords are always PBKDF2-HMAC-SHA256 at
310,000 iterations.

### TLS, and the plain-`http://` warning

**Do this.** Over plain HTTP every password typed into the sign-in page crosses
the network in the clear, and so does the session cookie and the newsletter
itself. Nothing about that failure is visible, because everything appears to
work — so the server warns at every start, and the app puts a warning in
Settings whenever the connection is not encrypted and not to this machine.

Either let the server do it:

```sh
KEYS_TLS_CERT=/etc/keys/fullchain.pem \
KEYS_TLS_KEY=/etc/keys/privkey.pem \
node server/server.js
```

(both variables, or neither), or terminate TLS in a reverse proxy in front and
set `KEYS_TRUST_PROXY=1` so the server knows the browser is on HTTPS.
`server/README.md` has an `nginx` example, a `systemd` unit, and the one trap
worth knowing about — a `Secure` cookie on a connection that isn't really TLS
produces an endless redirect back to `/login` with no error anywhere.

### Forgotten the administrator password?

Every lock needs a documented way back in. This is it, run on the machine
hosting the server:

```sh
node server/reset-accounts.js          # --yes to skip the confirmation
```

It lists the accounts, asks you to type `DELETE`, removes `accounts.json` and
issues a fresh setup token — so you start again from `/setup`. It **never
touches newsletter content**, and it destroys the accounts rather than
revealing them: whoever runs it has to set up a new administrator in front of
everybody. It needs shell access on the box, which is a higher bar than knowing
a password.

There is no browser equivalent, and there can't be: a page cannot wipe a
server's accounts.

### "This is not the St. Peter's Keys server"

If the app puts up a panel saying that, it means **the page was served by
something other than `server/server.js`**. The page and the editor arrive
normally, but nothing answers about accounts — so nobody can sign in, and the
administrator cannot add or remove anybody.

The usual causes:

- an editor's live-preview extension (VS Code's Live Server and friends),
- `python -m http.server`, `npx serve`, or any other plain file server,
- nginx or Apache pointed straight at this folder,
- the real server having stopped, with something else now on its port.

All of them hand over the files and then answer `404` to every `/api/...`
request. The fix is to serve the folder with its own server — `node
server/server.js`, then use the address **it** prints — or, if you don't need
accounts, use the desktop launcher or open `index.html` directly.

**If you are deliberately running nginx or Apache in front**, that is fine and
supported — but it has to *proxy* to the server rather than serve the folder
itself: a `location /` with `proxy_pass`, and no `root`, `index` or `try_files`
for this site. Two headers have to be right as well, and one of them fails in a
way that looks unrelated: leave `Host` at nginx's default and sign-in returns
**403 `CSRF`** while the rest of the site behaves normally. The reverse-proxy
section of [`server/README.md`](server/README.md) has a config that works,
including the case where something further out — Caddy, a Cloudflare tunnel —
is the thing holding the certificate.

**To find out which of them it is**, on the machine holding the files:

```sh
node server/whats-serving.js               # the usual port, plus the usual suspects
node server/whats-serving.js 8080          # some other port
node server/whats-serving.js http://the-vm:8749/
```

It asks each address what it is and tells you what it found: our server (and
whether it has accounts yet), some other web server handing out this folder as
plain files, or nothing at all. It changes nothing and is safe to run any time.

The case worth knowing about is **both at once** — our server running happily
on its port while nginx or Apache, left over from when this was a static site,
answers the address you actually typed. That looks exactly like a broken
install and is not one; the script names the address that works.

The panel itself also now prints the address it probed. If that isn't the
address the server printed, that's the whole story: something else is on it.

This used to fail much less helpfully: the app booted all the way into the
editor and then reported "the server sent a reply this app could not read
(HTTP 404)" the first time anybody touched an account. It now refuses to start
and says why.

### More

`server/README.md` is the operator's guide — deployment, `systemd`, TLS,
backups, and what is served and what is not. `docs/AUTH-API.md` is the contract
between the server and the browser: routes, cookies, error codes, expiry rules.

**Something not behaving?** From the browser console:

```js
Keys.Auth.diagnose()
```

It reports the *server's* view — which mode the app is in, whether the
connection is encrypted, whether the server is answering, whether any accounts
exist, who you are signed in as — plus a plain-English `summary` naming the
reason.

## Signing in

Served over `http://` or `https://`, everyone signs in by name and password on
the server's own sign-in page. There is no built-in account and no default
password; the first administrator is created once, at `/setup`, with the
one-time token above.

- The **administrator** can add and remove people, from **Settings → People**.
- **Anyone** can change their own password or delete their own account.
- The **last administrator** can't be removed, by themselves or anyone else —
  otherwise nobody would be able to manage accounts again.

Deleting an account never deletes the newsletter. Signing out destroys the
session on the server. Closing the browser discards the cookie, so that session
can't be used again either — and restarting the server signs everybody out,
because sessions are only ever held in its memory.

Changing your password signs out anyone signed in as you somewhere else, and
leaves the window you changed it in alone.

**You are signed out after 5 minutes of inactivity.** It's five minutes of
*not touching anything* — any typing, clicking, scrolling or mouse movement
resets the clock, so it will never interrupt you mid-article. You get a warning
about half a minute before. When it does happen the sign-in panel comes back
**over** your work rather than instead of it: the issue is still open behind
it, already saved, and signing in puts you straight back where you were with
nothing reloaded and nothing retyped. A session also ends 12 hours after you
signed in, however busy you have been.

In the desktop version and when opened from disk, none of the above applies:
there is nobody to sign in as, nothing to time out, and the app simply opens.

> ### What this protects, and what it doesn't
>
> **Served over `http://` or `https://`, the sign-in is a real lock.** The
> server will not send the newsletter — or the app that edits it, or the list
> of who has an account — to anyone without a valid session. Passwords are
> hashed on the server with PBKDF2-SHA256, a random salt per person and
> 310,000 iterations; what is kept is never the password itself, and never
> travels back to a browser. Sessions are held in the server's memory, close
> after 5 minutes without activity and after 12 hours regardless, and are gone
> entirely when the server restarts.
>
> **What it does not do is encrypt anything.** If you reach the app over a
> plain `http://` address, your name, your password and the newsletter itself
> travel across the network in a form anyone else on that network can read.
> Use `https://` — see TLS above — or a network you trust. The newsletter is
> not encrypted where it is stored, either: it lives in the browser's storage
> and in whatever `.json` files people have saved.
>
> **The desktop version has no sign-in, and does not need one.** Its
> protection is not a password but an address: with `KEYS_LOCAL=1` the server
> listens on `127.0.0.1` and refuses to start anywhere else, so no other
> machine can reach it at all. Anyone who can use that computer can read and
> edit the newsletter — which is the same as saying anyone who can use your
> computer can read your documents.
>
> **Opened straight from disk over `file://` there is no gate at all**, and
> that is a decision rather than an oversight. There is no server to
> authenticate against, and a sign-in box that anyone could delete by editing
> one file protects nothing from somebody who already has the files. Anyone who
> can open the folder can read the newsletter.
>
> **In every case, please don't keep anything confidential in the newsletter.**

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

Three things are remembered in your browser between visits, separately from the
newsletter file itself: your theme choice, the save-for-later drawer, and a
working copy of the current issue. Accounts are **not** among them — they live
on the server, which is why they are the same on every machine that reaches it.
Your sign-in is a cookie the browser holds only until you close it, and a
session the server drops sooner than that if you go quiet.

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

## Save for later

Down the right-hand edge of the preview is a **drawer**. Click its handle and it
slides out to show boxes you have kept for another week — the lunch slips and
forms you print again and again.

There are two ways to put something in it, and both ask you to **name it** so
you can find it later:

- press the **⤓** button on the box in the *Lunch Slips and Forms* section; or
- **drag the box from the page onto the drawer**. Hovering the handle mid-drag
  slides the drawer open so you can see where it is going.

Saving takes a **copy** — the box stays on the page. Press **Add** on a saved
item to drop a copy back onto the lunch slips page; the drawer keeps its copy,
so you can use the same slip every week. Each item can be renamed with **✎** or
thrown away with **✕**, and removing one never changes the newsletter.

The drawer starts out holding the boxes from the issue you first opened, so
there is something in it to try.

> Saved boxes live **in this browser**, not inside the newsletter file. That is
> deliberate: it means they stay put when you start a new issue, instead of
> being replaced every time you open a different `.json`. The trade-off is that
> e-mailing someone your `.json` does not send them your saved boxes.

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
assets/js/stash.js      the save-for-later drawer
assets/js/auth.js       identity, the re-entry gate, the Settings panel
assets/js/app.js        bootstrap and event wiring
server/server.js        the listener, routing, static allowlist, JSON API
server/accounts.js      password hashing, the accounts file, the account rules
server/sessions.js      in-memory sessions and both expiry clocks
server/ratelimit.js     the sign-in backoff
server/login.html       the sign-in page, served at /login
server/setup.html       the first-run page, served at /setup
server/start.js         starts server.js; surfaces the first-run setup token
server/stop.js          stops server.js, including copies started by hand
server/alpine-start.sh  Alpine: start the server, then nginx (rc-service)
server/alpine-stop.sh   Alpine: stop nginx (rc-service), then the server
server/instances.js     shared: which processes are ours, and only ours
server/reset-accounts.js  the way back in when the admin password is lost
server/whats-serving.js   "the app says this is not its server" — what is it, then?
server/README.md        running and deploying the server
desktop/launch.js       starts the server in local mode and opens the browser
desktop/StPeters-Keys.command   double-click launcher, macOS
desktop/StPeters-Keys.bat       double-click launcher, Windows
desktop/README.md       the desktop version, for a non-technical reader
docs/SPEC.md            module contract — read before changing anything
docs/CLASSES.md         CSS class contract for the paper
docs/AUTH-API.md        the server ↔ browser contract for accounts
tools/verify.js         automated browser checks
```

The server has no `package.json`, no `node_modules` and no lockfile, and must
never grow one: only Node's own `http`, `https`, `crypto`, `fs`, `path` and
`url` are used. A parish runs this unattended for years, and every package
added is something somebody has to patch long after they stopped thinking
about it.

`docs/SPEC.md` is the contract between these modules, and `docs/AUTH-API.md`
between the server and the browser. The interfaces and class names in them are
load-bearing — several modules depend on them by string.

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
