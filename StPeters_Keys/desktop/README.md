# St. Peter's Keys on your own computer

This folder is the **desktop version**: the newsletter, running on your own
Mac or Windows PC, with no sign-in and no accounts. Nobody else can reach it,
not even someone else in the building on the same wifi.

It is the same program as the shared server version — the same editor, the same
four pages, the same printing — just started differently.

---

## Starting it

### On a Mac

Double-click **`StPeters-Keys.command`**.

A small black window appears with some text in it, and the newsletter opens in
your usual browser. **Leave the black window alone while you work.** Closing it
stops the newsletter.

> **If double-clicking opens a text file instead of starting anything**, the
> file has lost its "you may run this" permission — that happens when the
> project is copied through a zip file or from a Windows machine. To fix it
> once and for all, open Terminal (in Applications ▸ Utilities), type
> `chmod +x ` — with the space — then drag `StPeters-Keys.command` into the
> Terminal window and press Return.

### On Windows

Double-click **`StPeters-Keys.bat`**.

A small black window appears with some text in it, and the newsletter opens in
your usual browser. **Leave the black window alone while you work.** Closing it
stops the newsletter.

> Windows may show a blue "Windows protected your PC" box the first time,
> because the file came from the internet. Click **More info**, then **Run
> anyway**. That box appears for anything downloaded and not paid-for-and-signed;
> the file is a plain text script and you can read every line of it.

---

## What it will ask you, once

The newsletter needs one free program called **Node.js** — the standard,
widely-used program that runs the small local server holding your newsletter
while you edit it. Nothing leaves your computer.

If Node.js is not already installed, the launcher says so and asks:

```
Install Node.js now? [y/N]
```

Type `y` and press Return to let it install Node for you. It uses the official
source in every case:

| | With a package manager | Without one |
|---|---|---|
| **Mac** | `brew install node` | the official installer from nodejs.org |
| **Windows** | `winget install OpenJS.NodeJS.LTS` | the official `.msi` from nodejs.org |

Your Mac password (or a Windows permission box) is asked for at that point,
because installing a program touches shared folders. The launcher warns you
before that happens, and cancelling does no harm.

**You can say no.** If you do — or if the install fails, or there is no
internet — the launcher opens the newsletter straight from the file instead,
and you can still write, arrange and print exactly as usual.

**What saying no costs you.** Opened straight from the file, the page has no web
address, and some browsers — Safari most of all — refuse to let a page like that
remember anything. If that happens, your work is **not** kept when you close the
tab. So either print to PDF as you go, or install Node.js and start it again
properly. With Node.js, the newsletter is saved in the browser as you type, and
it is still there tomorrow.

---

## Stopping it

Close the small black window, or click it and press **Ctrl-C**. The newsletter
stops; anything you have written is already saved.

You do not have to remember. If the browser is closed and nothing asks the
newsletter for anything for an hour, it stops by itself and says so. Should you
come back to a tab that has been open all afternoon and find it will not
reload, that is what happened — double-click the launcher again.

---

## Where the writing is kept

In your browser, under the address `http://127.0.0.1:8750`. Two things follow
from that, and they are worth knowing before they surprise you:

- **It is per-browser and per-computer.** Written in Chrome on the office PC,
  the issue is not in Safari, and not on the laptop at home. Use the same
  browser on the same machine, or export a copy and carry that.
- **Clearing your browser's history and site data can delete it**, if you tell
  the browser to include "cookies and other site data". Export or print to PDF
  anything you would be sorry to lose.

If several people need to work on the same issue from different machines, that
is what the shared server version is for: see `server/README.md`.

---

## Is this safe?

Yes, and here is the whole of why in five lines.

- It listens on **127.0.0.1** — the name a computer has for itself. Traffic to
  that address never reaches a network card, so no other machine can connect,
  and that is enforced by the server: it **refuses to start** in desktop mode
  if anything asks it to listen anywhere else.
- Because nobody else can reach it, it does not ask for a password. There is
  nobody to keep out but yourself.
- A web page in another tab cannot read your newsletter: browsers keep each
  address's data to itself, and this server sends none of the permissions that
  would let another site look in.
- No accounts are created, and no files are written outside your browser: the
  desktop version does not touch the `server/data` folder at all.
- It is not a way to publish the newsletter. When you want other people to
  read it, print it, or export a PDF.

---

## If something goes wrong

Run it from a terminal or command prompt, where the messages stay put:

```
node desktop/launch.js
```

Useful options:

| | |
|---|---|
| `--port 9000` | use a different port (it walks upward from 8750 by itself if 8750 is busy) |
| `--no-browser` | start it without opening a browser, and print the address |

Common things:

- **"The newsletter server did not come up"** — something else may be using a
  great many ports, or a security product is blocking the launcher. Try
  `node desktop/launch.js --port 9000`.
- **"not answering at http://127.0.0.1:…"** — a firewall or security product is
  blocking connections your computer makes to itself. That is unusual, and worth
  asking whoever looks after the machine about.
- **The launcher says Node is too old.** It will offer to install a current one.
  Existing Node projects on the machine are unaffected: Node 20 and newer are
  installed side by side by every method used here.

---

## The files here

| File | What it is |
|---|---|
| `StPeters-Keys.command` | macOS: finds or installs Node, then runs `launch.js`. Needs the executable bit (see above). |
| `StPeters-Keys.bat` | Windows: the same, with winget or the official `.msi`. |
| `launch.js` | Starts `server/server.js` in local mode, waits for it, opens the browser, and ties the two lifetimes together. |

Local mode itself lives in `server/server.js` — look for `KEYS_LOCAL`. The
loopback interlock described above is documented at length there, and in
`docs/AUTH-API.md` §0 and §7.
