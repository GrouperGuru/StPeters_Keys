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

### Alpine: the two shell scripts

If you are starting and stopping this by hand — rather than as an OpenRC
service — these bring the app and its nginx proxy up and down together:

```sh
./server/alpine-start.sh          # start the server, then nginx
./server/alpine-stop.sh           # stop nginx, then the server
./server/alpine-stop.sh --dry-run # show what would be stopped
```

Both need root, because `rc-service` does.

**The order is deliberate and opposite in each.** nginx is the reverse proxy in
front of the app, so:

- **Starting**: app first, nginx second. A proxy started before the thing it
  forwards to answers every request in that window with a 502, which looks to
  whoever is holding the page like the app is broken.
- **Stopping**: nginx first, app second. Closing the front door first means no
  request ever reaches a backend on its way out — and with no new traffic
  arriving, `stop.js`'s SIGTERM finds the server idle, so it can let in-flight
  requests finish and flush a queued `accounts.json` write before exiting.
  That wait is why an account added seconds earlier is not lost.

**If the app fails to start, `alpine-start.sh` does not start nginx.** A proxy
with nothing behind it serves 502s to the whole parish and hides the real
error, which is on the screen in front of you.

The start script is **idempotent** — run it twice and it will notice the server
is already up and carry on to nginx, rather than refusing. That matters when
the first run got half way.

`--skip-nginx` on either script leaves nginx alone entirely, for when you are
only interested in the app.

If nginx fails to start, the script runs `nginx -t` afterwards and prints what
it says — but **only after** a real failure, never as a gate beforehand. That
distinction is worth knowing about, because `nginx -t` fails misleadingly on a
fresh Alpine boot:

```
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: [emerg] open() "/run/nginx/nginx.pid" failed (2: No such file or directory)
nginx: configuration file /etc/nginx/nginx.conf test failed
```

The first line says the config is fine and the last calls it a failure. Both
are true: the syntax *is* fine, and the test *did* fail — because `nginx -t`
opens the pid file, `/run` is a tmpfs emptied at every boot, and `/run/nginx`
is recreated by the init script's `start_pre` rather than by nginx itself. Run
`nginx -t` on its own before nginx has been started since boot and you get
this every time, on a perfectly healthy config.

So if you see it, the fix is not in your config:

```sh
mkdir -p /run/nginx && chown nginx:nginx /run/nginx
```

Usually you do not even need that — `rc-service nginx start` creates the
directory itself. An earlier version of `alpine-start.sh` used `nginx -t` as a
pre-flight check and consequently refused to start an nginx that would have
started perfectly well. There is a comment in the script saying not to put it
back.

Both are `#!/bin/sh`, not `#!/bin/bash`, and that is deliberate: Alpine has no
bash in the base image, and a bash shebang fails with "not found" — which
reads as though the *script* is missing rather than the shell. They are plain
POSIX and behave identically under bash if you have it.

They need the executable bit. Git records it, but if the files arrived by zip
or from a Windows machine:

```sh
chmod +x server/alpine-start.sh server/alpine-stop.sh
```

### Alpine, and other OpenRC systems

Alpine has no `systemd`, and no `bash` either. Nothing here needs bash — every
script in `server/` is plain Node — but the service definition is different.

```sh
apk add nodejs                        # Node 20+ on Alpine 3.19 and later
node --version                        # confirm it is 20 or newer
adduser -S -D -H -s /sbin/nologin keys
install -d -o keys -g nogroup -m 700 /var/lib/keys
```

`/etc/init.d/keys` — remember `chmod +x` on it:

```sh
#!/sbin/openrc-run

name="St. Peter's Keys"
description="Newsletter server"

command="/usr/bin/node"
command_args="/srv/keys/server/server.js"
command_user="keys:nogroup"
command_background=true
directory="/srv/keys"
pidfile="/run/keys.pid"
output_log="/var/log/keys.log"
error_log="/var/log/keys.log"

export KEYS_HOST=127.0.0.1
export KEYS_PORT=8749
export KEYS_DATA=/var/lib/keys
export KEYS_TRUST_PROXY=1

depend() {
  need net
}
```

```sh
rc-update add keys default
rc-service keys start
grep -A4 'FIRST-RUN' /var/log/keys.log     # the setup token is in here
```

`command_background=true` is what makes OpenRC write the pidfile and return,
and it is also why the output has to be redirected to `output_log`: the setup
token is printed to stdout, and with nowhere to go it is simply lost — leaving
a deployment that cannot be set up and gives no clue why. If it has already
been lost, the token is on disk too:

```sh
cat /var/lib/keys/setup-token.txt
```

**In an LXC container**, run the service inside the container as above and
publish the port at the host. Two things catch people out:

- `KEYS_HOST=127.0.0.1` binds the container's own loopback, so nothing
  outside the container can reach it. That is correct *only* when a reverse
  proxy runs in the same container. If your proxy is on the host, or you are
  connecting straight from your desktop, leave `KEYS_HOST` unset so the server
  binds all of the container's interfaces — the container boundary is doing
  the isolating.
- `node server/stop.js` finds processes through `/proc`, so it must run inside
  the same container as the server. From the host it will correctly report
  finding nothing, because from the host those PIDs are different numbers.

`node server/start.js` and `node server/stop.js` work on Alpine unchanged, and
need neither `ps` nor `lsof` — on Linux they read `/proc` directly. `ps` on
BusyBox does not support the flags the alternative would have needed, so this
is the one path that works everywhere.

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
