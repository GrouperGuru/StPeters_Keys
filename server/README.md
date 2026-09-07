# The server

Serves St. Peter's Keys with real accounts. Node 24, no dependencies, one
command to start.

```sh
node server/server.js
```

It prints where it is listening and, on a fresh machine, a **setup token**.
Open the address it gives you, paste the token, and create the administrator
account. That is the whole installation.

> **What this is, and what it is not**
>
> Served over HTTP(S), the sign-in **is** a real access-control boundary. The
> server will not hand out `index.html`, the application JavaScript or any of
> the API without a valid session cookie. This is not the old in-browser gate.
>
> Opened straight from disk over `file://`, none of this exists and the app
> just opens — there is no server to authenticate against, and a local gate
> would protect nothing from somebody who already has the files.
>
> The interface between the two halves is `docs/AUTH-API.md`. If something
> there is wrong, fix that file first and then both sides.

---

## Contents

| File | What it is |
|---|---|
| `server.js` | The listener, routing, security headers, the static allowlist, the JSON API, graceful shutdown |
| `accounts.js` | Password hashing, validation, the accounts file, the last-administrator rule |
| `sessions.js` | In-memory sessions and both expiry clocks |
| `ratelimit.js` | The sign-in backoff |
| `login.html` | The sign-in page, served at `/login` |
| `setup.html` | The first-run page, served at `/setup` |
| `reset-accounts.js` | The way back in when the administrator password is lost |
| `data/` | Created on first run. **Never committed** — see `.gitignore` |

There is no `package.json`, no `node_modules` and no lockfile, and there must
never be. Only `node:http`, `node:https`, `node:crypto`, `node:fs`, `node:path`
and `node:url` are used. A parish will run this unattended for years, and every
package added here is something that has to be patched by somebody who stopped
thinking about it long ago.

---

## Running it

```sh
node server/server.js
```

Configuration is entirely environment variables — `docs/AUTH-API.md` §7:

| Variable | Default | Meaning |
|---|---|---|
| `KEYS_PORT` | `8749` | Listen port |
| `KEYS_HOST` | `0.0.0.0` | Listen address. `127.0.0.1` to accept only local connections |
| `KEYS_DATA` | `server/data` | Where `accounts.json` lives |
| `KEYS_IDLE_MS` | `300000` | Idle timeout, in milliseconds |
| `KEYS_TLS_CERT`, `KEYS_TLS_KEY` | — | If **both** are set, the server speaks HTTPS itself |
| `KEYS_TRUST_PROXY` | `0` | Trust `X-Forwarded-For` and `X-Forwarded-Proto` |

Two things are not configurable on purpose. Sessions expire after **12 hours**
whatever happens, and passwords are always PBKDF2-HMAC-SHA256 at **310,000**
iterations. Both are floors rather than preferences.

### First run

With no accounts, the server prints this at every start and writes the same
token to `KEYS_DATA/setup-token.txt` at mode 0600:

```
────────────────────────────────────────────────────────────
  FIRST-RUN SETUP
  Open   http://localhost:8749/setup
  Token  4KJ2-9WQX-7ATB-1MZP
────────────────────────────────────────────────────────────
```

If you have lost the console, read it over SSH:

```sh
cat server/data/setup-token.txt
```

The token exists so that the administrator account cannot be claimed by
whoever reaches the box first on a shared network. Without it, "deploy the
app" and "hand the parish newsletter to a stranger" are the same act. It is
consumed the moment the first account is created, and `/setup` then answers
`403 SETUP_DONE` forever.

Capitals and hyphens do not matter when typing it in — somebody is going to
read it off a terminal and type it into a phone.

### What is served, and what is not

Exactly four things are reachable: `index.html` at `/`, the sign-in page at
`/login`, the first-run page at `/setup`, and files under `assets/` with a
known extension. Everything else — `docs/`, `reference/`, `tools/`, `server/`,
dotfiles, anything you drop in the project root next Tuesday — is a 404.

`assets/css/app.css` is the single asset served without a session, because the
sign-in page is styled by it. It gives away the colour of the buttons.

The rest of `assets/` needs a session, so the application JavaScript is not
readable by a stranger.

---

## Putting it on a VM

Nothing is installed. Copy the repository, run the one command, and put
something in front of it that restarts it.

```sh
sudo useradd --system --home /srv/keys --shell /usr/sbin/nologin keys
sudo git clone <your remote> /srv/keys
sudo mkdir -p /var/lib/keys
sudo chown -R keys:keys /srv/keys /var/lib/keys
sudo chmod 700 /var/lib/keys
```

`/etc/systemd/system/keys.service`:

```ini
[Unit]
Description=St. Peter's Keys
After=network.target

[Service]
Type=simple
User=keys
Group=keys
WorkingDirectory=/srv/keys
ExecStart=/usr/bin/node /srv/keys/server/server.js
Environment=KEYS_HOST=127.0.0.1
Environment=KEYS_PORT=8749
Environment=KEYS_DATA=/var/lib/keys
Environment=KEYS_TRUST_PROXY=1
Restart=on-failure
RestartSec=5

# The process needs to read the repository and write exactly one directory.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/keys

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now keys
sudo journalctl -u keys -f          # the setup token is in here
```

`KEYS_HOST=127.0.0.1` in that unit is deliberate: with a reverse proxy in
front, the server should not also be reachable directly on port 8749, because
that route would bypass TLS.

`SIGTERM` — which is what `systemctl restart` sends — is handled: the server
stops listening, lets requests already in flight finish, waits for any pending
write to `accounts.json` to land, and exits. Sessions are in memory, so a
restart signs everybody out. That is a sign-in prompt, not lost work: the
newsletter autosaves continuously.

---

## TLS

**Do this.** Over plain HTTP every password typed into the sign-in page crosses
the network in the clear, and so does the session cookie — anyone on the parish
network can read both, and nothing about the failure is visible, because
everything appears to work. The server warns about it at every start and
reports `"secure": false` from `/api/auth/state`, which is what makes the
warning appear in the app.

There are two ways round it, and one trap.

### Either: let the server do it

```sh
KEYS_TLS_CERT=/etc/keys/fullchain.pem \
KEYS_TLS_KEY=/etc/keys/privkey.pem \
KEYS_PORT=8749 \
node server/server.js
```

Both variables, or neither. The key file must be readable by the service user
and by nobody else (`chmod 600`, owned by `keys`). TLS 1.2 is the floor.

### Or: terminate it in front

Any reverse proxy will do. The one thing it **must** do is tell the server that
the browser is on HTTPS, and the server must be told to believe it:

```nginx
server {
  listen 443 ssl;
  server_name keys.example.org;

  ssl_certificate     /etc/letsencrypt/live/keys.example.org/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/keys.example.org/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8749;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}

server {
  listen 80;
  server_name keys.example.org;
  return 301 https://$host$request_uri;
}
```

…with `KEYS_TRUST_PROXY=1` on the service.

`X-Forwarded-For` and `X-Forwarded-Proto` are only believed when
`KEYS_TRUST_PROXY` is set, and that guard is not ceremony. Without it anybody
can send a different `X-Forwarded-For` on every request and get a fresh
five-attempt sign-in budget each time — a rate limiter that looks like
protection and is not. Never set `KEYS_TRUST_PROXY=1` on a server that is
reachable directly.

### The trap

The session cookie is marked `Secure` **only** when the connection really is
TLS. A `Secure` cookie that arrives over plain `http` is stored by the browser
and then never sent back, so sign-in appears to succeed, the redirect to `/`
lands, the server sees no cookie, and bounces straight back to `/login`. From
the outside that is an endless loop with no error message anywhere, and every
instinct says the password is wrong.

If you ever see that loop: the server thinks it is on TLS and the browser is
not. Either `KEYS_TRUST_PROXY=1` is set on a server that is being reached
directly, or the proxy is sending `X-Forwarded-Proto: https` on a plain-HTTP
listener.

`Strict-Transport-Security` is sent only under TLS, for the same family of
reasons: pinning a parish box to HTTPS before it has a certificate makes it
unreachable, and the fix then lives inside the browser rather than on the
server.

---

## Recovering a lost administrator password

Every lock needs a documented way back. This is it:

```sh
sudo -u keys KEYS_DATA=/var/lib/keys node /srv/keys/server/reset-accounts.js
```

It lists the accounts about to go, asks you to type `DELETE`, then removes
`accounts.json` and issues a fresh setup token. Restart the server and go to
`/setup`.

- It **never touches newsletter content.** It knows about two files in
  `KEYS_DATA` and nothing else.
- It **opens nothing.** It destroys the accounts rather than revealing them;
  whoever runs it then has to set up a new administrator from scratch, in front
  of everybody.
- It needs **shell access on the machine**, which is a strictly higher bar than
  knowing a password. Anyone who can run it could already read `accounts.json`,
  edit `server.js`, or read the newsletter off the disk.
- `--yes` skips the confirmation, for scripts.

The browser cannot do this. `Keys.Auth.resetAllAccounts` was removed when
accounts moved to the server: a page can no longer wipe a server's accounts,
and pretending otherwise would have been a lie.

### The other failure it fixes

If `accounts.json` is corrupt, the server **refuses to start** and says so.
That is deliberate. Treating an unreadable accounts file as "no accounts
exist" would silently turn a damaged file into an open `/setup` for whoever
found it first. Restore from a backup if you have one; otherwise run
`reset-accounts.js`.

---

## Backing it up

One file:

```sh
sudo cp /var/lib/keys/accounts.json /somewhere/safe/accounts-$(date +%F).json
```

It contains salts and PBKDF2 hashes, never passwords, but it is still the thing
an offline attack would want. Keep it at mode 0600 and off shared drives.

The newsletter is not in here. It lives in the browser's storage and in
whatever `.json` files people have saved.

---

## Notes for whoever changes this next

**The atomic write in `accounts.js` is load-bearing.** `accounts.json` is
written to a temp file, `fsync`'d, then `rename`d. A crash halfway through a
plain write leaves a truncated file, which on the next start is an accounts
file with no administrator and no setup token to make one — a permanently
locked-out parish. Do not simplify it to `writeFile`.

**The static handler is an allowlist, not a denylist**, and the long comment
above `resolveAsset()` explains why. The short version: a denylist has to
enumerate every future mistake, and the day somebody drops a `.env` in the
project root it is served.

**`'unsafe-inline'` in the Content-Security-Policy is not laziness.** The
shrink-to-fit machinery writes inline styles, `state.js` re-applies a sanitised
`style` attribute to pasted markup, and `index.html` runs an inline theme
bootstrap before the stylesheets. Tightening `style-src` does not produce an
error anybody notices — it quietly stops the text fitting the page, which is
the one thing this application exists to do. The comment above `CSP` in
`server.js` says what would have to change first.

**Nothing but the setup token is ever logged.** No password, no session token,
no hash, in any log line. The setup token is printed on purpose — that is its
entire job, and it is useless the moment the first account exists.
