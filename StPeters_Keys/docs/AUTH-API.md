# Server-side accounts — the contract

This is the agreed interface between `server/` (Node, no dependencies) and
`assets/js/auth.js` (the browser). Both sides are written against this file;
if something here is wrong, fix **this file first**, then both sides.

---

## 0. The shape of the thing

The app now has two client-side modes, decided by `location.protocol`:

| Mode | How you got there | Accounts | Gate |
|---|---|---|---|
| **served** | `http://` / `https://` | Real, on the server | Yes — enforced by the server |
| **offline** | `file://` | None | No gate at all |

**Served mode is a real access-control boundary.** The server will not hand out
`index.html` or the application JavaScript without a valid session cookie. This
is the whole point of the change and the reason the old "this is not a security
barrier" notice comes down in served mode.

**Offline mode is not, and does not pretend to be.** Opened straight from disk
there is no server to authenticate against, and a local gate would protect
nothing from someone who already has the files. The app just opens.

### The third thing: local mode (the desktop app)

There is a third arrangement, and it is a property of the **server**, not of the
client: `KEYS_LOCAL=1`, used by `desktop/launch.js`. The client still sees
`http://`, so `Keys.Auth.mode` is `'served'` and nothing about the client's mode
detection changes. What changes is the answer to `GET /api/auth/state`, which
reports `mode: "local"` and `signedIn: true`.

| | served | **local** | offline |
|---|---|---|---|
| Client's `location.protocol` | `http`/`https` | `http` | `file` |
| `Keys.Auth.mode` | `served` | `served` | `offline` |
| `state.mode` | `"served"` | `"local"` | *no server to ask* |
| Authentication | sessions, cookies, gate | **none at all** | none possible |
| Listen address | `KEYS_HOST`, default `0.0.0.0` | **always `127.0.0.1`** | — |
| Accounts, `server/data` | yes | **never touched** | — |

**Local mode has no authentication whatsoever** — no gate, no accounts, no
sessions, no setup token — because it is one person on their own machine, and
they already have the files. What makes that safe is a single interlock in
`server/server.js`, and it is worth stating in this contract because it is the
one rule the whole arrangement rests on:

> In local mode the listen address is `127.0.0.1`, and the server **refuses to
> start** if `KEYS_HOST` is set to anything else. There is no environment
> variable that relaxes this. "No authentication" plus `0.0.0.0` would publish
> the newsletter, and a working editor for it, to every machine on the network,
> and would look — from the machine that started it — exactly like a working
> desktop app.

The client is expected to treat local mode as **already signed in**: that is
what `signedIn: true` plus a `user` object means, and no new client code path is
required to make the app work. `mode: "local"` exists so the UI can be honest
about which of the three it is (and so it can leave the idle machinery alone —
see the note on `idleMs` in §4), not so it can decide whether to boot.

---

## 1. Sessions

- Cookie name **`keys_sid`**.
- Value: 32 random bytes, base64url. Generated with `crypto.randomBytes`.
- Attributes: `HttpOnly; SameSite=Strict; Path=/`, plus `Secure` **only** when
  the server is serving TLS (a `Secure` cookie over plain http is never sent
  back, which would lock everyone out).
- Sessions live **in memory** on the server. A server restart signs everyone
  out. That is acceptable and slightly safer than persisting them.
- The server stores `sha256(token)`, not the token. A heap dump or an
  accidental log line then does not yield a usable session.

Two clocks, both enforced server-side — the client is never trusted about time:

- **Idle**: `KEYS_IDLE_MS`, default `300000` (5 minutes) since the last
  authenticated request.
- **Absolute**: 12 hours since sign-in, regardless of activity.

---

## 2. Cross-site request forgery

Non-`GET` requests are rejected unless **all** of:

1. `Content-Type: application/json` (a form post cannot set this cross-origin
   without a preflight),
2. `Origin` (or `Referer` if `Origin` is absent) matches the request's own
   `Host`,
3. the `keys_sid` cookie is `SameSite=Strict` (browser-enforced).

Rejections are `403 { error, code: "CSRF" }`.

**The content-type rule applies to `DELETE` too, which has no body.** So
`DELETE /api/users/:name` must still be sent with
`Content-Type: application/json` or it is refused — the one place this is easy
to get wrong. It is kept rather than exempted because "all non-GET requests
carry this header" is a rule a reader can check at a glance, whereas "all except
`DELETE`, because that one relies on the `Origin` leg alone" is the kind of
carve-out that quietly grows. The client sends it unconditionally.

Names in the path are `encodeURIComponent`'d by the client and decoded once by
the server; they may legally contain spaces and full stops. The decoded name is
matched case-insensitively against the account list and **never** reaches a
filesystem path.

---

## 3. Static routes

| Route | Unauthenticated | Authenticated |
|---|---|---|
| `GET /` | `302 /setup` if no accounts exist, else `302 /login` | `200` `index.html` |
| `GET /login` | `200` the login page | `302 /` |
| `GET /setup` | `200` the first-run page, or `302 /login` if accounts exist | `302 /` |
| `GET /assets/css/app.css` | `200` (allowlisted — the login page needs it) | `200` |
| `GET /assets/**` (anything else) | `401` | `200` |
| anything else | `404` | `404` |

`docs/`, `reference/`, `tools/`, `server/` and dotfiles are **never** served.
The static handler works from an explicit allowlist of directories plus a
path-traversal check, not from "whatever is on disk".

---

## 4. JSON API

All responses are `application/json`. All errors share one shape:

```json
{ "error": "A sentence a human can act on.", "code": "SNAKE_CASE" }
```

Codes: `NO_SESSION`, `IDLE`, `EXPIRED`, `BAD_CREDENTIALS`, `RATE_LIMITED`,
`NOT_ADMIN`, `LAST_ADMIN`, `NAME_TAKEN`, `NO_SUCH_USER`, `WEAK_PASSWORD`,
`BAD_NAME`, `BAD_TOKEN`, `SETUP_DONE`, `CSRF`, `BAD_JSON`, `LOCAL_MODE`.

`LOCAL_MODE` is **only** returned in local mode, and only by the account
endpoints — `signin`, `signout`, `setup`, `password`, `/api/users*` — with
status `403`. It means "this request is about accounts, and this copy has none";
see §0 and the table in §4a. Nothing in served mode ever returns it, so a client
may treat it as "hide the account controls" without further checks.

A "user" object, everywhere it appears, is exactly:

```json
{ "name": "ryan", "role": "admin", "createdAt": 1757260000000, "lastSignInAt": 1757263000000 }
```

`role` is `"admin"` or `"user"`. Password material never appears in a response.

---

### `GET /api/auth/state` — never requires auth

**This route does NOT refresh `lastSeen`, and that is load-bearing.** It is the
client's only read-only "am I still signed in?" probe, used on
`visibilitychange`, `focus`, `online`, and on the first activity after a long
gap. If it refreshed the idle clock, every one of those probes would become a
keepalive and the five-minute timeout would never fire for a tab that is merely
open — the feature would silently do nothing. Only `touch` (and genuine
authenticated work) extends a session.

```json
{
  "mode": "served",
  "signedIn": true,
  "user": { "...": "or null" },
  "hasAccounts": true,
  "idleMs": 300000,
  "maxAgeMs": 43200000,
  "secure": false,
  "serverTime": 1757263000000
}
```

The client's boot check. `secure` is whether the connection is TLS; the client
shows a plain-http warning in Settings when it is `false` and the host is not
localhost.

In **local mode** the same route answers, without auth as always:

```json
{
  "mode": "local",
  "signedIn": true,
  "user": { "name": "Local", "role": "user",
            "createdAt": 1757260000000, "lastSignInAt": 1757260000000 },
  "hasAccounts": true,
  "idleMs": 0,
  "maxAgeMs": 0,
  "secure": false,
  "serverTime": 1757263000000
}
```

Field by field, because each value is a decision:

- **`signedIn: true` and a `user`** — the app must boot, and this is the answer
  it already knows how to act on. Making local mode look like "signed in
  already" was preferred over inventing a state the client has to learn.
- **`hasAccounts: true`** — a `false` here sends the client down the "no
  administrator yet, go to /setup" path, and there is no `/setup` in local mode.
- **`role: "user"`, name `"Local"`** — not an account, and not an administrator:
  an administrator manages *other people's* accounts and there are none. `admin`
  would make the client fetch and draw a roster that cannot exist.
- **`idleMs: 0`, `maxAgeMs: 0`** — `0` means **no timeout**, which is new and is
  only ever sent in local mode. There is no session, so nothing expires. The
  client already ignores a non-positive `idleMs` (it keeps its own default),
  so an unmodified client still works; what it should not do is *quote* its
  default at the user, or run the idle warning, when `mode === "local"`.
- **`secure: false`** — accurate: it is plain `http`. Loopback traffic does not
  reach a network card, and the client already exempts localhost from its
  plain-http warning.

### §4a. The other routes in local mode

| Route | Local mode |
|---|---|
| `GET /api/auth/state` | `200`, as above |
| `POST /api/auth/touch` | `200 { "idleFor": 0, "expiresInMs": 0, "user": {...} }` — a no-op, so an older client's heartbeat costs nothing |
| `POST /api/auth/signin`, `/signout`, `/setup`, `/password` | `403 LOCAL_MODE` |
| `GET`/`POST /api/users`, `DELETE /api/users/:name` | `403 LOCAL_MODE` |
| anything else under `/api/` | `404` |
| `GET /` | `200` `index.html` — no gate, no redirect |
| `GET /login`, `GET /setup` | `302 /` |
| `GET /assets/**` | `200`, same allowlist and traversal checks as served mode |
| any `Host` header that is not `127.0.0.1`, `localhost` or `::1` | `400` (DNS-rebinding refusal) |

The CSRF rule in §2 still applies to every non-`GET` request in local mode.
Local mode's own handlers never call `authenticate()`, never read
`accounts.json` and never create a session; served mode's code is not reached
at all.

### `POST /api/auth/setup` — first run only

Request `{ "token": "...", "name": "...", "password": "..." }`
→ `201 { "user": {...} }` + `Set-Cookie`.
→ `403 SETUP_DONE` if any account already exists.
→ `400 BAD_TOKEN` / `400 WEAK_PASSWORD` / `400 BAD_NAME`.

The created account is always `role: "admin"`.

### `POST /api/auth/signin`

Request `{ "name": "...", "password": "..." }`
→ `200 { "user": {...} }` + `Set-Cookie`.
→ `401 BAD_CREDENTIALS` — identical response for a wrong name and a wrong
password, and the same amount of work is done in both cases.
→ `429 RATE_LIMITED` with `retryAfterMs`.

### `POST /api/auth/signout`
→ `204`, cookie cleared, session destroyed server-side.

### `POST /api/auth/touch` — the idle heartbeat
→ `200 { "idleFor": 1200, "expiresInMs": 298800, "user": {...} }`
→ `401 { code: "IDLE" | "EXPIRED" | "NO_SESSION" }`

Every other authenticated request also refreshes `lastSeen`; `touch` exists so
a client that is being *used* but not making requests stays alive, and so the
client learns promptly when it has been dropped.

### `GET /api/users` — admin only
→ `200 { "users": [ {...}, {...} ] }` → `403 NOT_ADMIN`

### `POST /api/users` — admin only
Request `{ "name": "...", "password": "...", "role": "user" }`
→ `201 { "user": {...} }` → `409 NAME_TAKEN`, `400 WEAK_PASSWORD|BAD_NAME`.

### `DELETE /api/users/:name` — admin, or yourself
→ `200 { "removed": {...}, "self": false }`
→ `403 NOT_ADMIN` when a non-admin targets someone else.
→ `409 LAST_ADMIN` when it would leave no administrator.

Deleting yourself destroys your session and clears the cookie.

### `POST /api/auth/password`
Request `{ "current": "...", "next": "..." }`
→ `200 { "changed": true }` → `401 BAD_CREDENTIALS`, `400 WEAK_PASSWORD`.

A successful change **rotates the salt** and **invalidates every other session
for that user**, keeping the one that made the change.

---

## 5. Password storage

- PBKDF2-HMAC-SHA256, **310,000** iterations, 32-byte derived key,
  per-user 16-byte random salt — the same parameters the browser version used,
  so nothing gets weaker by moving.
- Verified with `crypto.timingSafeEqual`.
- Minimum length **8**. Names: 1–40 chars, `[A-Za-z0-9 ._-]`, compared
  case-insensitively for uniqueness, stored as typed.
- Stored in `KEYS_DATA/accounts.json`, mode `0600`, written atomically
  (temp file in the same directory, `fsync`, then `rename`).

Because hashing now happens on the server, `crypto.subtle` — and therefore the
browser's secure-context rule — is **no longer involved**. The old failure where
accounts silently switched themselves off on `http://192.168.x.x` cannot happen.

---

## 6. First run

If `accounts.json` has no users, the server generates a one-time **setup token**
and, every time it starts in that state, prints it prominently to stdout:

```
────────────────────────────────────────────────────────
  FIRST-RUN SETUP
  Open   http://<host>:8749/setup
  Token  4KJ2-9WQX-7ATB-1MZP
────────────────────────────────────────────────────────
```

It is also written to `KEYS_DATA/setup-token.txt` (mode `0600`) so an admin who
has lost the console can `cat` it over SSH.

The token exists so that the administrator account cannot be claimed by whoever
reaches the box first on a shared network. It is consumed on success.

This is the direct answer to "I cloned it onto a VM and was never prompted to
create an administrator" — the prompt is now unmissable, in the console and at
`/setup`.

**Recovery**: `node server/reset-accounts.js` deletes `accounts.json` and issues
a fresh setup token. It never touches newsletter content.

---

## 7. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `KEYS_PORT` | `8749` | Listen port. In local mode, the *first* port tried: it walks upward if busy |
| `KEYS_HOST` | `0.0.0.0` | Listen address. In local mode: forced to `127.0.0.1`, and any other value **refuses to start** |
| `KEYS_DATA` | `<repo>/server/data` | Where `accounts.json` lives. Unused in local mode |
| `KEYS_IDLE_MS` | `300000` | Idle timeout. Unused in local mode — there are no sessions |
| `KEYS_TLS_CERT`, `KEYS_TLS_KEY` | — | If both set, serve HTTPS. Ignored (with a warning) in local mode |
| `KEYS_TRUST_PROXY` | `0` | Trust `X-Forwarded-For` for rate-limit keys |
| `KEYS_LOCAL` | `0` | **Desktop mode**: no authentication, `127.0.0.1` only. See §0 |
| `KEYS_LOCAL_IDLE_MS` | `3600000` | Local mode only: stop after this long with no requests at all. `0` never stops. Not part of the interlock |

`KEYS_LOCAL=1` is set by `desktop/launch.js`; nothing else should set it. The
desktop launchers default the port to **8750** rather than 8749 so that trying
the desktop copy on a machine that also serves the real one does not fight over
a socket.

---

## 8. Rate limiting

Per `(IP, lowercased name)`: 5 free attempts, then a doubling delay from 1s,
capped at 5 minutes, decaying after 15 minutes of quiet. In memory. Successful
sign-in clears the counter for that pair.

---

## 9. Client behaviour (`assets/js/auth.js`)

- `Keys.Auth.start(boot)` keeps its existing signature.
- **Offline mode** (`file:`): call `boot()` immediately. No gate. Settings shows
  an "opened from disk, accounts live on the server" note instead of a roster.
- **Served mode**: fetch `/api/auth/state` for identity, then `boot()`.

  **Served mode must be proven, not assumed — this is a fixed bug, not a
  preference.** The client cannot conclude "the server refused to send this page
  to a stranger, therefore I am signed in" from the URL scheme. Any plain file
  server will hand over `index.html` and every asset and then answer nothing
  about accounts: `python -m http.server`, an editor's live-preview extension,
  `npx serve`, nginx pointed at the folder, or this server having died with
  something else on its port. The symptom reported from the field was an
  administrator who could not add users and a sign out that failed with
  "HTTP 404" — one cause, two faces.

  So `start()` requires `GET /api/auth/state` to return 2xx **and** JSON with
  `mode` (string), `signedIn` and `hasAccounts` (booleans) before anyone is let
  in. Failing that, the app puts the `#auth-gate` up as a blocking panel naming
  the cause, how to get accounts back (`node server/server.js`) and how to carry
  on without them (open `index.html` from the folder), and **does not boot**.
  Booting into an editor whose Save works and whose every account action 404s is
  the bug; failing closed with no way forward would be a different one.

  **The classifier is response *shape*, not status code.** Every JSON error this
  server sends carries a `code` from §4 — so an error body with no `code` did
  not come from it. That one rule catches a 404 with an HTML body, a proxy's 502
  page, python's 501 on POST, and a 200 of unrelated JSON, while leaving genuine
  refusals (`401 BAD_CREDENTIALS`, `409 NAME_TAKEN`, `403 NOT_ADMIN`) to show
  the server's own sentence. Client-side code `NO_API`, a sibling of `OFFLINE`.

  **"Absent" and "unreachable" are different, and conflating them loses work.**
  A rejected `fetch` (no status, no body) is transient: retried, never a panel,
  never an eviction. A code-less reply is positive evidence and is not retried —
  a static server's 404 is the same 404 next time. Mid-session it takes two
  consecutive absent verdicts before a panel covers a running editor, since one
  odd reply can be a proxy hiccup. Autosave before raising the gate, but **only
  once booted**: autosaving pre-boot would write the empty starting document
  over the autosave that has not been read back yet, turning a misconfiguration
  into real data loss.
- **Idle expiry must not lose work.** When `touch` returns 401, put the existing
  in-page `#auth-gate` up and re-authenticate *in place* via
  `POST /api/auth/signin` — do **not** navigate to `/login`. The editor is still
  behind the gate with the issue in it. On success, dismiss the gate and carry
  on without a reload.
- All account management in Settings goes through the API above.
- `Keys.Auth.diagnose()` stays, and reports the server's view.
- **Local mode** (`state.mode === "local"`, `Keys.Auth.mode` still `'served'`):
  boot exactly as served mode does — `signedIn: true` is the whole instruction.
  Beyond that, three things are true and the UI is free to act on them: the
  account controls answer `403 LOCAL_MODE`, so there is nothing to show; there
  is no idle clock (`idleMs: 0`), so the "you will be signed out in about 30
  seconds" warning and the served notice's "closes the session after N minutes"
  sentence are both false here; and there is no gate to raise, because a `touch`
  can never return `401`.

Public surface (unchanged names where behaviour survives):
`start, currentUser, isAdmin, users, signIn, signOut, addUser, removeUser,
changePassword, hasAccounts, diagnose, checkIdle, idleFor, IDLE_MS,
openSettings, closeSettings, mode`.

**Resolved shapes** — pinned here so `tools/verify.js` has something stable to
test against:

| Call | Resolves to |
|---|---|
| `users()` | `{ users: [...] }` or `{ error, code }` |
| `signIn(name, pw)` | `{ user }` or `{ error, code }` |
| `signOut()` | `{ signedOut: true }` or `{ error, code }` |
| `addUser(name, pw, role)` | `{ user }` or `{ error, code }` |
| `removeUser(name)` | `{ removed, self }` or `{ error, code }` |
| `changePassword(cur, next)` | `{ changed: true }` or `{ error, code }` |
| `checkIdle()` | `'active'` \| `'warning'` \| `'expired'` \| `'no session'` \| `'unknown'` \| `'offline'` |
| `currentUser()`, `isAdmin()`, `idleFor()`, `mode` | **synchronous**, from the last server answer |

Client-side pre-validation carries the **same `code`** the server would have
sent (`WEAK_PASSWORD`, `BAD_NAME`). A caller branching on `code` must not have
to care whether the rejection made it to the server or was caught locally —
that difference is exactly what makes a UI behave one way on a fast network and
another on a slow one.

`signOut()` does **not** clear the screen; a rendered newsletter is still on
display when it resolves. Clearing is the caller's job — the Sign out button
follows it with a reload, which the server bounces to `/login`. That is the only
way to be certain nothing is left visible.

In offline mode every network-backed call above resolves
`{ error, code: 'OFFLINE' }` rather than issuing a doomed fetch.

**`checkIdle()` distinguishes `'unknown'` from `'expired'`, and that matters
more than it looks.** `'unknown'` means the server could not be reached;
`'expired'` means it was reached and said no. Collapsing the two would sign
somebody out — putting the gate over their unsaved issue — because their wifi
dropped for a moment. Only a server that actually answers may end a session.
`checkIdle()` also always makes the request rather than answering from the local
clock: a check that returns `'active'` from a variable has verified nothing, and
would be useless as the test hook it exists to be.

`resetAllAccounts` and `createFirstAdmin` are **retained as functions that
throw**, each naming its replacement (`node server/reset-accounts.js`, and
`/setup` with the printed token). A browser can no longer wipe the server's
accounts or mint the first administrator, and pretending otherwise would be a
lie — but deleting the names outright would greet anyone with an old console
snippet or an out-of-date runbook with a bare `TypeError`, which teaches nobody
anything. A loud, specific failure is worth keeping the stub for.
