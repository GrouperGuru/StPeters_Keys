#!/usr/bin/env node
/* =============================================================================
 * server.js — St. Peter's Keys, served.
 *
 * Owns: the listener, the security headers, the CSRF rule, the static-file
 * allowlist and its auth gate, the JSON API in docs/AUTH-API.md, and graceful
 * shutdown. Accounts, sessions and the sign-in backoff each live in their own
 * file next to this one.
 *
 * Run it:   node server/server.js
 * Configure it: docs/AUTH-API.md §7, or server/README.md.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * This IS a real access-control boundary, and it is the reason the app's old
 * "this is not a security barrier" notice comes down in served mode. Nothing
 * behind it — not index.html, not the application JavaScript, not the API — is
 * handed to a request without a valid session cookie. The one deliberate
 * exception is assets/css/app.css, because the sign-in page itself needs it and
 * a stylesheet gives away nothing but the colour of the buttons.
 *
 * It is NOT a general web server, and the static handler is deliberately
 * crippled to keep it from becoming one: see the note above resolveAsset().
 *
 * It is NOT a substitute for TLS. Over plain http every password typed into the
 * sign-in page crosses the network in the clear, and so does the session
 * cookie. The server says so, loudly, at startup and in GET /api/auth/state,
 * and server/README.md explains how to put a certificate in front of it. What
 * this server refuses to do is pretend the problem away.
 *
 * -----------------------------------------------------------------------------
 * LOCAL MODE (KEYS_LOCAL=1) — the desktop app
 *
 * There is a second way to run this: as a single-person desktop application,
 * started by desktop/StPeters-Keys.command or desktop/StPeters-Keys.bat, which
 * run desktop/launch.js, which runs this file with KEYS_LOCAL=1. In that mode
 * there is no authentication at all — no gate, no accounts, no sessions, no
 * setup token — because there is nobody to authenticate: the person who
 * double-clicked the launcher already has the files.
 *
 * THE INTERLOCK. Local mode ALWAYS binds 127.0.0.1, and REFUSES TO START if
 * KEYS_HOST asks for anything else. This is not a preference and there is no
 * environment variable that relaxes it. "No authentication" and "listening on
 * 0.0.0.0" together would publish the parish newsletter — and a working editor
 * for it — to every machine on the network, with no sign that anything is
 * wrong. Bind to loopback, or do not run. See LOCAL/HOST below and the
 * assertion in main(); if you are about to change either, read the comment
 * there first.
 * -----------------------------------------------------------------------------
 *
 * It has NO dependencies, deliberately, and must keep having none. Only
 * node:http, node:https, node:crypto, node:fs, node:path and node:url. This
 * project has been dependency-free since the first commit; a parish will run it
 * unattended for years, and every package added here is something that has to
 * be patched by somebody who has long since stopped thinking about it.
 * ========================================================================== */
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const { Accounts } = require('./accounts.js');
const { Sessions } = require('./sessions.js');
const { RateLimit } = require('./ratelimit.js');

const fsp = fs.promises;

/* =============================================================================
 * CONFIGURATION — docs/AUTH-API.md §7
 * ========================================================================== */

const REPO_ROOT = path.resolve(__dirname, '..');
const ASSETS_ROOT = path.join(REPO_ROOT, 'assets');
const INDEX_FILE = path.join(REPO_ROOT, 'index.html');
const LOGIN_FILE = path.join(__dirname, 'login.html');
const SETUP_FILE = path.join(__dirname, 'setup.html');

function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn('[keys] ' + name + '="' + raw + '" is not a number; using ' + fallback + '.');
    return fallback;
  }
  /* Clamp rather than reject. A typo in a unit file should not stop the parish
   * newsletter from starting; it should produce a sane server and a warning. */
  const clamped = Math.min(Math.max(Math.trunc(n), min), max);
  if (clamped !== Math.trunc(n)) {
    console.warn('[keys] ' + name + '=' + raw + ' is out of range; using ' + clamped + '.');
  }
  return clamped;
}

function envFlag(name) {
  const raw = String(process.env[name] == null ? '' : process.env[name]).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/* =============================================================================
 * LOCAL MODE AND THE LOOPBACK INTERLOCK
 * -----------------------------------------------------------------------------
 * KEYS_LOCAL=1 turns authentication off entirely (see handleLocalApi and the
 * local branch of handleStatic). The interlock below is what makes that safe,
 * and it is the single most dangerous line in this repository to get wrong.
 *
 * Read it as one rule: IN LOCAL MODE THE LISTEN ADDRESS IS 127.0.0.1, FULL
 * STOP. HOST is not computed from the environment in local mode; KEYS_HOST is
 * only inspected in order to REFUSE, loudly, if somebody set it to something
 * else. An unauthenticated server on 0.0.0.0 hands the newsletter and its
 * editor to everyone on the network and looks, from the machine that started
 * it, exactly like a working desktop app — the failure is total and silent.
 *
 * "127.0.0.1" is the only accepted spelling. Not "localhost" (a name, which
 * resolves through whatever /etc/hosts says today), not "::1", not the empty
 * string plus a comment. An allowlist of near-synonyms is how this check would
 * eventually acquire an entry that is not loopback at all — and nobody has a
 * reason to set KEYS_HOST for a desktop app in the first place.
 *
 * The refusal is recorded here and acted on as the first statement of main(),
 * rather than exiting at require-time, so that importing this module for its
 * exports cannot kill the importing process.
 * ========================================================================== */
const LOCAL = envFlag('KEYS_LOCAL');
const LOOPBACK = '127.0.0.1';

const HOST_REQUESTED = process.env.KEYS_HOST || '';

const HOST_REFUSAL = (LOCAL && HOST_REQUESTED && HOST_REQUESTED !== LOOPBACK)
  ? 'KEYS_LOCAL=1 turns authentication off, so this server may only listen ' +
    'on ' + LOOPBACK + ' — but KEYS_HOST="' + HOST_REQUESTED + '" asks for ' +
    'another address. Refusing to start: an unauthenticated server on any ' +
    'other address would hand the newsletter, and the editor for it, to ' +
    'every machine on the network. Unset KEYS_HOST (or set it to exactly ' +
    LOOPBACK + ') for the desktop app, or unset KEYS_LOCAL to run the real ' +
    'server with accounts.'
  : null;

const PORT = envInt('KEYS_PORT', 8749, 1, 65535);
const HOST = LOCAL ? LOOPBACK : (HOST_REQUESTED || '0.0.0.0');

/* Local mode walks upward from PORT rather than dying on EADDRINUSE: the
 * person who double-clicked the launcher cannot be asked to pick a free port,
 * and something else on their machine may well already own the default. The
 * port that was actually used is printed, and handed to the launcher on the
 * READY line, so the browser is opened at the right address. */
const LOCAL_PORT_TRIES = 20;

/* When does a desktop app stop? Not when a tab closes — a browser cannot be
 * asked, and treating an accidental ⌘W as "quit" would end the session someone
 * was in the middle of. So: local mode exits after a long stretch in which it
 * served NO requests at all. An open tab polls GET /api/auth/state on its
 * heartbeat, so "no requests for an hour" means the browser really is gone (or
 * the machine was asleep, in which case the person is not working either).
 *
 * An hour is deliberately far longer than any plausible pause. The cost of
 * being wrong is small and recoverable — the app is already loaded in the tab
 * and autosaves to that origin's localStorage, so nothing is lost; a reload
 * would fail until the launcher is double-clicked again, which desktop/README
 * says. The cost of the other mistake — never exiting — is a stray server left
 * listening for days after somebody thought they had finished.
 *
 * KEYS_LOCAL_IDLE_MS=0 disables the timer for anyone who wants it to stay up.
 * This is a convenience knob and NOT part of the interlock above. */
const LOCAL_IDLE_EXIT_MS = envInt('KEYS_LOCAL_IDLE_MS', 60 * 60 * 1000,
  0, 24 * 60 * 60 * 1000);

/* Who local mode says you are. Not an account — there are no accounts in local
 * mode — but /api/auth/state has to answer with something, and the client is
 * built to be told either "signed in as somebody" or "here is a gate". This is
 * the former: docs/AUTH-API.md §0 and §4.
 *
 * role is "user", not "admin", on purpose. An administrator in this app is
 * someone who manages OTHER PEOPLE'S accounts, and in local mode there are
 * none — no roster to read, nobody to add, nobody to remove. Claiming "admin"
 * would make the client fetch and draw a roster of accounts that do not exist.
 * "user" makes it ask for the least, and every account-management route
 * answers LOCAL_MODE anyway. */
const LOCAL_USER = Object.freeze({
  name: 'Local',
  role: 'user',
  createdAt: Date.now(),
  lastSignInAt: Date.now()
});

const DATA_DIR = process.env.KEYS_DATA
  ? path.resolve(process.env.KEYS_DATA)
  : path.join(__dirname, 'data');

/* Floor of one second so a mistyped KEYS_IDLE_MS cannot produce a server that
 * signs everybody out between one request and the next. Ceiling of a day
 * because past that the idle clock is not doing anything the absolute one is
 * not already doing. */
const IDLE_MS = envInt('KEYS_IDLE_MS', 300000, 1000, 24 * 60 * 60 * 1000);
const MAX_AGE_MS = Sessions.DEFAULT_MAX_AGE_MS;

const TLS_CERT = process.env.KEYS_TLS_CERT || '';
const TLS_KEY = process.env.KEYS_TLS_KEY || '';

/* Local mode is plain http, always. Nothing crosses a network — the packets do
 * not leave the machine — and a certificate would only give the launcher an
 * https URL to open, a warning page to click through, and one more thing to
 * expire. Stray TLS variables in a desktop user's environment are ignored
 * rather than obeyed, with a word so the ignoring is not a mystery. */
const TLS_ON = !LOCAL && !!(TLS_CERT && TLS_KEY);
const TLS_IGNORED = LOCAL && !!(TLS_CERT || TLS_KEY);

const TRUST_PROXY = envFlag('KEYS_TRUST_PROXY');

const COOKIE_NAME = 'keys_sid';

/* A sign-in body is a name and a password. 64 KiB is four orders of magnitude
 * more than that, and it is the point past which an unauthenticated caller
 * stops being a browser and starts being a way to fill the server's memory. */
const MAX_BODY_BYTES = 64 * 1024;

/* =============================================================================
 * SECURITY HEADERS
 * -----------------------------------------------------------------------------
 * Content-Security-Policy needs a word, because the obvious strict policy
 * silently breaks the newsletter.
 *
 * 'unsafe-inline' in style-src is NOT laziness. The app's shrink-to-fit
 * machinery (assets/js/fit.js) sizes type by writing to element.style, and
 * assets/js/state.js re-applies a sanitised `style` attribute to pasted markup
 * with setAttribute('style', …). index.html carries a literal style attribute
 * on its <noscript> block. Setting .style.fontSize through the CSSOM is not
 * governed by CSP, but setAttribute('style', …) and the parsed attribute both
 * are — so a policy without 'unsafe-inline' here does not throw an error
 * anybody notices, it just quietly stops the text fitting the page, which is
 * the one thing this application exists to do. If that ever changes, the fix is
 * to move those two call sites to CSSOM writes and CSS custom properties FIRST,
 * verify the fit, and only then tighten this line.
 *
 * 'unsafe-inline' in script-src is for index.html's theme bootstrap, which has
 * to run before the stylesheets to avoid a flash of the wrong palette, and for
 * the small inline scripts in login.html and setup.html. A nonce would be the
 * better answer and is not available: index.html is a static file that is also
 * opened straight from disk over file://, where there is no server to mint one.
 *
 * Everything else is as tight as it goes: no plugins, no framing, no base tag
 * rewriting, and connect-src 'self' so nothing on this page can talk to any
 * host but this one.
 *
 * img-src needs data: for the chevron SVGs in app.css's design tokens.
 * ========================================================================== */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

function applySecurityHeaders(res, secure) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP);

  /* HSTS ONLY under TLS. Sent over plain http it is either ignored (correct
   * browsers) or, if the site is later reached once over https, it pins every
   * future visit to https on a box that may have no certificate — turning a
   * working parish server into an unreachable one, with a fix that lives in
   * the browser's internals rather than on the server. */
  if (secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
}

/* =============================================================================
 * REQUEST HELPERS
 * ========================================================================== */

/** Is the browser talking to us over TLS?
 *
 *  Two ways that can be true: this process is the https server, or something
 *  in front of it terminated TLS and said so. The second only counts when
 *  KEYS_TRUST_PROXY is on, because X-Forwarded-Proto is just a header and
 *  anyone can send one. Getting this right matters twice over: it decides
 *  whether the session cookie is marked Secure, and whether the client shows
 *  its plain-http warning. */
function isSecure(req) {
  if (TLS_ON) return true;
  if (TRUST_PROXY) {
    const proto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0].trim().toLowerCase();
    if (proto === 'https') return true;
  }
  return false;
}

/** Who is asking, for rate-limiting purposes.
 *
 *  X-Forwarded-For is only consulted when KEYS_TRUST_PROXY is on. Without that
 *  guard, an attacker sends a different X-Forwarded-For with every request and
 *  gets a fresh five-attempt budget each time — the rate limiter is then not
 *  merely useless, it is worse than nothing, because it looks like protection. */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (first) return first;
    }
  }
  return (req.socket && req.socket.remoteAddress) || '?';
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch (e) {
      return raw;                       // not our encoding; it will just not match
    }
  }
  return null;
}

/** Build the Set-Cookie value for a session.
 *
 *  THE TRAP, and it is worth the paragraph: `Secure` must be set ONLY when the
 *  connection really is TLS. A cookie marked Secure that arrives over plain
 *  http is stored and then never sent back, so sign-in appears to succeed, the
 *  redirect to / lands, the server sees no cookie, and bounces straight back to
 *  /login. From the outside that is an infinite loop with no error message
 *  anywhere, and every instinct says the password is wrong. Do not "harden"
 *  this by making it unconditional.
 *
 *  No Max-Age and no Expires on purpose: this is a session cookie, so closing
 *  the browser ends it, on top of the two clocks the server enforces anyway. */
function sessionCookie(token, secure) {
  const bits = [COOKIE_NAME + '=' + token, 'HttpOnly', 'SameSite=Strict', 'Path=/'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

function clearedCookie(secure) {
  const bits = [COOKIE_NAME + '=', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** docs/AUTH-API.md §2. Every non-GET request must clear all of this.
 *
 *  The two checks are doing different jobs. Content-Type: application/json
 *  cannot be produced by an HTML form — <form> can only send urlencoded,
 *  multipart or text/plain — so requiring it means a cross-origin attacker
 *  needs fetch(), which needs a CORS preflight, which this server answers with
 *  404 because it implements no preflight at all. The Origin check then covers
 *  the case where they have a preflight from somewhere and catches simple
 *  same-site mistakes.
 *
 *  Both absent is a refusal, not a pass. Browsers send Origin on every non-GET
 *  request; a caller that sends neither is a script, and a script can send the
 *  header. Defaulting to "allow when unsure" is how CSRF checks come to be
 *  worth nothing. */
function csrfOk(req, secure) {
  const ct = String(req.headers['content-type'] || '')
    .split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') return false;

  const host = req.headers.host;
  if (!host) return false;

  const source = req.headers.origin || req.headers.referer;
  if (!source) return false;

  let u;
  try {
    u = new URL(source);
  } catch (e) {
    return false;                       // includes the literal "null" Origin
  }
  if (u.host.toLowerCase() !== String(host).toLowerCase()) return false;

  /* Under TLS, an http:// Origin on the same host is a downgrade — something
   * stripped the transport somewhere. Refuse rather than shrug. */
  if (secure && u.protocol !== 'https:') return false;

  return true;
}

/* =============================================================================
 * PATH PARSING
 * -----------------------------------------------------------------------------
 * One decode, then a segment-by-segment check. Doing this by hand rather than
 * leaning on new URL() is deliberate: URL silently collapses "a/../b" into "b",
 * so a traversal attempt would arrive at the router already looking innocent
 * and would never be seen, let alone logged.
 * ========================================================================== */
function parsePath(rawUrl) {
  const raw = String(rawUrl || '');

  /* Absolute-form request targets ("GET http://elsewhere/x HTTP/1.1") are legal
   * for proxies and meaningless for an origin server. Refuse them rather than
   * guess which part is the path. */
  if (!raw.startsWith('/')) return { ok: false, reason: 'not an origin-form path' };

  const q = raw.indexOf('?');
  const encoded = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? '' : raw.slice(q + 1);

  let decoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch (e) {
    /* Malformed percent-encoding. Not a path; do not attempt to salvage one. */
    return { ok: false, reason: 'malformed percent-encoding' };
  }

  /* A NUL truncates the string in some system calls and in a great many C
   * libraries downstream, so "/assets/app.css%00.png" can pass an extension
   * check and then open a different file. There is no legitimate NUL in a URL. */
  if (decoded.indexOf('\0') !== -1) return { ok: false, reason: 'null byte' };

  /* Backslash is a path separator on Windows and not on the wire. Refusing it
   * means the segment checks below cannot be side-stepped by spelling the
   * separator differently. */
  if (decoded.indexOf('\\') !== -1) return { ok: false, reason: 'backslash' };

  /* The decode happens exactly once, and the traversal check runs on the
   * result, so "%2e%2e" and ".." are the same thing here and both are caught.
   * Anything still containing a "%" after one decode is a literal per cent in a
   * filename, and is NOT decoded again — a second pass is how "%252e%252e"
   * turns into "..". */
  for (const seg of decoded.split('/')) {
    if (seg === '') continue;
    if (seg === '.' || seg === '..') return { ok: false, reason: 'traversal' };
    /* Dotfiles are never content. .git, .env, .htpasswd and friends all live
     * behind this one line. */
    if (seg.charCodeAt(0) === 0x2e) return { ok: false, reason: 'dotfile' };
  }

  return { ok: true, path: decoded, query: query };
}

/* =============================================================================
 * STATIC FILES
 * -----------------------------------------------------------------------------
 * WHY AN ALLOWLIST AND NOT A DENYLIST
 *
 * The tempting shape is "serve the repository, but refuse docs/, tools/,
 * server/ and dotfiles". That shape is wrong in a way that only shows up later.
 * A denylist has to enumerate every future mistake: the day someone drops
 * backup.sql, notes-with-the-wifi-password.txt, or a .env into the project
 * root, it is served, and nobody finds out until it is indexed. The list also
 * has to survive every way of spelling a path — encoded, double-encoded,
 * mixed-case on a case-insensitive filesystem, reached through a symlink — and
 * each of those is a separate bug waiting to be written.
 *
 * The allowlist inverts the failure. Exactly four things are reachable:
 * index.html, /login, /setup, and files under assets/ with a known extension.
 * A new file dropped anywhere else in the repository is a 404 by default, and
 * the mistake is invisible instead of catastrophic. When it is wrong it is
 * wrong by refusing something, which somebody reports in a minute.
 *
 * The traversal checks in parsePath() and the realpath assertion below are the
 * second and third layers. All three are needed: the segment check stops "..",
 * the lexical prefix check stops a path that resolves outside the root, and the
 * realpath check stops a SYMLINK inside assets/ pointing at /etc/shadow, which
 * neither of the other two can see.
 * ========================================================================== */

/* Extensions are an allowlist too. An unknown extension is a 404, so an
 * accidentally committed assets/notes.md or assets/keys.pem is not served, and
 * nothing is ever sent with a guessed Content-Type. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

/* Resolved once at startup: the repository itself may sit behind a symlink
 * (/var/www/keys -> /srv/keys is an ordinary deployment), and comparing a
 * realpath against a non-real root would then reject every legitimate file. */
let ASSETS_REAL = ASSETS_ROOT;

/** Turn "/assets/js/app.js" into an absolute path that is provably inside
 *  assets/, or null. Every rejection here is a 404 or a 400 — never a message
 *  that distinguishes "outside the root" from "does not exist". */
async function resolveAsset(urlPath) {
  const prefix = '/assets/';
  if (!urlPath.startsWith(prefix)) return null;

  const rel = urlPath.slice(prefix.length);
  if (!rel) return null;

  const ext = path.extname(rel).toLowerCase();
  const type = MIME[ext];
  if (!type) return null;

  const target = path.join(ASSETS_ROOT, rel);

  // Layer two: lexical containment, before touching the filesystem at all.
  if (target !== ASSETS_ROOT && !target.startsWith(ASSETS_ROOT + path.sep)) {
    return null;
  }

  // Layer three: what the filesystem says it really is, symlinks followed.
  let real;
  try {
    real = await fsp.realpath(target);
  } catch (e) {
    return null;                        // missing, or a dangling symlink
  }
  if (real !== ASSETS_REAL && !real.startsWith(ASSETS_REAL + path.sep)) {
    return null;
  }

  let st;
  try {
    st = await fsp.stat(real);
  } catch (e) {
    return null;
  }
  /* Directories, FIFOs, devices and sockets are not content. Opening a FIFO
   * would hang the request forever. */
  if (!st.isFile()) return null;

  return { file: real, type: type, stat: st };
}

/* =============================================================================
 * RESPONSES
 * ========================================================================== */

function sendJson(res, status, payload, extraHeaders) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  res.writeHead(status, headers);
  if (res.req && res.req.method === 'HEAD') res.end();
  else res.end(body);
}

/** The single error shape from docs/AUTH-API.md §4. `error` is a sentence a
 *  person can act on; `code` is what the client branches on. Never put a
 *  username, a password, a token or a stack trace in either. */
function apiError(res, status, code, message, extra) {
  const payload = { error: message, code: code };
  if (extra) Object.assign(payload, extra);
  sendJson(res, status, payload);
}

function sendText(res, status, text) {
  const body = Buffer.from(text + '\n', 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  if (res.req && res.req.method === 'HEAD') res.end();
  else res.end(body);
}

function notFound(res) {
  /* Deliberately identical for "there is no such route", "that file is not on
   * the allowlist" and "that path tried to escape". Telling the three apart is
   * a map of the filesystem. */
  sendText(res, 404, 'Not found.');
}

function redirect(res, location) {
  res.writeHead(302, {
    'Location': location,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': 0,
    'Cache-Control': 'no-store'
  });
  res.end();
}

function sendFile(req, res, file, type, cacheControl, extraHeaders) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return notFound(res);
  }
  if (!st.isFile()) return notFound(res);

  const etag = '"' + st.size.toString(16) + '-' + Math.trunc(st.mtimeMs).toString(16) + '"';
  const headers = {
    'Content-Type': type,
    'Cache-Control': cacheControl,
    'ETag': etag,
    'Last-Modified': new Date(st.mtimeMs).toUTCString()
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);

  /* A 304 is only reachable after the auth gate above has already said yes, so
   * revalidation is not a way around the session check. `no-cache` (rather than
   * a max-age) is what forces the browser to come back and ask every time,
   * which is what makes that true. */
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(file);
  stream.on('error', () => { res.destroy(); });
  res.on('close', () => { stream.destroy(); });
  stream.pipe(res);
}

/* =============================================================================
 * BODY
 * ========================================================================== */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        /* Stop reading AND stop the socket. Just resolving would leave the rest
         * of the body streaming into a request nobody is listening to. */
        finish({ ok: false, tooLarge: true });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return finish({ ok: true, value: {} });
      let value;
      try {
        value = JSON.parse(text);
      } catch (e) {
        return finish({ ok: false });
      }
      /* An array or a bare string parses fine and then makes body.name throw or
       * silently read a String method. Only an object is a request body. */
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return finish({ ok: false });
      }
      finish({ ok: true, value: value });
    });

    req.on('error', () => finish({ ok: false }));
    req.on('aborted', () => finish({ ok: false }));
  });
}

/** Body fields are attacker-controlled and may be numbers, objects or absent.
 *  Everything that reads one goes through here so nothing downstream ever sees
 *  a non-string where it expected a string. */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/* =============================================================================
 * STATE
 * ========================================================================== */
const accounts = new Accounts(DATA_DIR);
const sessions = new Sessions({ idleMs: IDLE_MS, maxAgeMs: MAX_AGE_MS });
const limiter = new RateLimit();

/* One setup can be in flight at a time. Two requests arriving with the same
 * valid token would both see "no accounts yet", both spend ~100ms hashing, and
 * both create an administrator — and the second one would be an administrator
 * nobody asked for. */
let setupInFlight = false;

/** Resolve the caller. Returns { user, session, code }, where a null user is
 *  accompanied by the reason (NO_SESSION / IDLE / EXPIRED) so the client can
 *  tell "you stepped away" from "you were never here". */
function authenticate(req) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return { user: null, session: null, code: 'NO_SESSION' };

  const found = sessions.lookup(token);
  if (!found.ok) return { user: null, session: null, code: found.code };

  const user = accounts.findById(found.session.userId);
  if (!user) {
    /* The account was deleted under a live session — by another administrator,
     * or by reset-accounts.js. Kill the session now rather than let a deleted
     * person keep working for up to another idle timeout. */
    sessions.destroy(found.session);
    return { user: null, session: null, code: 'NO_SESSION' };
  }
  return { user: user, session: found.session, code: null };
}

/* One sentence per reason. IDLE is deliberately reassuring: being dropped to a
 * sign-in prompt with no explanation reads as a fault, and the first thing the
 * person wants to know is whether they have lost the issue they were writing. */
const MESSAGES = {
  NO_SESSION: 'Sign in to continue.',
  IDLE: 'You were signed out after a spell without activity. Sign in again — ' +
        'your newsletter was saved.',
  EXPIRED: 'That session has reached its twelve-hour limit. Sign in again.'
};

function unauthenticated(res, code) {
  apiError(res, 401, code, MESSAGES[code] || MESSAGES.NO_SESSION);
}

/* =============================================================================
 * LOCAL MODE — THE WHOLE OF IT
 * -----------------------------------------------------------------------------
 * Everything local mode serves is in these two functions, and handle() routes
 * to them before it reaches anything else. That is the point of writing it this
 * way rather than sprinkling `if (LOCAL)` through the real handlers: it is
 * checkable by reading. authenticate(), accounts, sessions and the rate limiter
 * are NOT REACHABLE in local mode — not gated, not bypassed, not called at all
 * — so there is no path by which a half-initialised account store or a null
 * session could be handed to code that expects a real one.
 *
 * What a hostile page in another tab can do to this server, since "no
 * authentication on a listening socket" deserves the question asked out loud:
 *
 *   - frame it: no. frame-ancestors 'none' and X-Frame-Options: DENY.
 *   - read a response with fetch(): no. There is no CORS header anywhere in
 *     this file, so the browser refuses to show it the body.
 *   - read the newsletter out of localStorage: no. That belongs to the
 *     http://127.0.0.1:<port> origin and the same-origin policy applies.
 *   - reach it from another machine: no. See the interlock.
 *   - point a hostname it controls at 127.0.0.1 to become same-origin (DNS
 *     rebinding): no — hence the Host check in handle().
 * ========================================================================== */

/** Is the Host header one of this machine's own names for itself?
 *
 *  DNS rebinding is the one attack the loopback binding does not by itself
 *  answer: a hostile site resolves evil.example to 127.0.0.1, and the browser
 *  then treats http://evil.example:<port> as a different origin from ours but
 *  the same server — which is how a page nobody trusts gets to make requests
 *  that look same-origin. Refusing any Host but our own closes it. */
function localHostOk(hostHeader) {
  const host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return false;
  /* Strip the port — it is whatever port we ended up on, and comparing it adds
   * nothing: the request already arrived on our socket. */
  const name = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)      // [::1]:8750
    : host.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' ||
         name === '[::1]' || name === '::1';
}

/** The local-mode JSON API. Two routes answer; every other /api/ path is
 *  refused with one sentence that says why. */
function handleLocalApi(req, res, ctx) {
  const p = ctx.path;
  const method = req.method;

  /* --- GET /api/auth/state ---------------------------------------------------
   * docs/AUTH-API.md §4. This is the route the client decides its whole
   * behaviour from, so local mode answers it as "signed in already" rather than
   * inventing a state the client has to learn about: signedIn true, a user
   * object of the documented shape, hasAccounts true so nothing sends anybody
   * to /setup.
   *
   * mode is "local" so the UI can be honest about which of the three things
   * this is, and idleMs/maxAgeMs are 0 — the documented "no timeout" — because
   * there is no session to expire. A client that has not learned about "local"
   * yet still works: it reads signedIn and boots. */
  if (p === '/api/auth/state' && (method === 'GET' || method === 'HEAD')) {
    return sendJson(res, 200, {
      mode: 'local',
      signedIn: true,
      user: LOCAL_USER,
      hasAccounts: true,
      idleMs: 0,
      maxAgeMs: 0,
      /* Not TLS, and not a lie by omission either: loopback traffic never
       * reaches a network card, and the client already exempts localhost from
       * its plain-http warning. */
      secure: false,
      serverTime: Date.now()
    });
  }

  /* --- POST /api/auth/touch -------------------------------------------------
   * The client's heartbeat. Answered rather than refused so an older client's
   * once-a-minute touch is a no-op instead of a 403 it has to interpret. Both
   * clocks read 0, matching idleMs/maxAgeMs above: nothing is counting down. */
  if (p === '/api/auth/touch' && method === 'POST') {
    return sendJson(res, 200, {
      idleFor: 0,
      expiresInMs: 0,
      user: LOCAL_USER
    });
  }

  /* Sign-in, sign-out, setup, password changes, the roster. All of it is
   * account management, and local mode has no accounts to manage. A specific
   * refusal, not a 404: "there is no such endpoint" would send somebody looking
   * for a typo, and not a silent success either — pretending to add a user who
   * cannot exist is worse than saying no. */
  const ACCOUNT_ROUTES = ['/api/auth/signin', '/api/auth/signout',
    '/api/auth/setup', '/api/auth/password', '/api/users'];
  if (ACCOUNT_ROUTES.indexOf(p) !== -1 || p.startsWith('/api/users/')) {
    return apiError(res, 403, 'LOCAL_MODE',
      'This is the desktop version: it runs on your own computer with no ' +
      'accounts and no sign-in, so there is nothing to sign in or out of and ' +
      'nobody to add or remove. Accounts belong to the shared server version ' +
      '(see server/README.md).');
  }

  return notFound(res);
}

/** The local-mode static routes. The gate is not bypassed here; there is no
 *  gate. /login and /setup redirect to the app rather than 404, because a
 *  bookmark from the served version should land somewhere useful. */
async function handleLocalStatic(req, res, ctx) {
  const p = ctx.path;
  const method = req.method;

  if (method !== 'GET' && method !== 'HEAD') return notFound(res);

  if (p === '/') {
    return sendFile(req, res, INDEX_FILE, MIME['.html'], 'no-store');
  }

  if (p === '/login' || p === '/setup') return redirect(res, '/');

  if (p.startsWith('/assets/')) {
    /* Still the same allowlist, the same traversal checks and the same
     * realpath assertion as served mode — resolveAsset() is the one that
     * keeps this from being a general web server, and it has nothing to do
     * with authentication. */
    const found = await resolveAsset(p);
    if (!found) return notFound(res);
    return sendFile(req, res, found.file, found.type, 'private, no-cache');
  }

  return notFound(res);
}

/* =============================================================================
 * THE JSON API — docs/AUTH-API.md §4
 * ========================================================================== */
async function handleApi(req, res, ctx) {
  const p = ctx.path;
  const method = req.method;
  const secure = ctx.secure;

  /* --- GET /api/auth/state — never requires auth ------------------------ */
  if (p === '/api/auth/state' && (method === 'GET' || method === 'HEAD')) {
    const auth = authenticate(req);
    /* Note what this does NOT do: it does not touch the session's idle clock.
     * The client polls this on boot and in diagnose(); if it counted as
     * activity, an open tab that nobody is sitting at would keep itself signed
     * in forever and the idle timeout would be decorative. */
    return sendJson(res, 200, {
      mode: 'served',
      signedIn: !!auth.user,
      user: auth.user ? accounts.publicUser(auth.user) : null,
      hasAccounts: accounts.hasAccounts(),
      idleMs: IDLE_MS,
      maxAgeMs: MAX_AGE_MS,
      secure: secure,
      serverTime: Date.now()
    });
  }

  /* --- POST /api/auth/setup --------------------------------------------- */
  if (p === '/api/auth/setup' && method === 'POST') {
    if (accounts.hasAccounts() || setupInFlight) {
      return apiError(res, 403, 'SETUP_DONE',
        'This server already has an account. Sign in instead.');
    }

    const body = await ctx.body();
    if (!body.ok) return badBody(res, body);

    /* The token is ~76 bits, so guessing it is not a threat worth a limiter.
     * What IS worth one is a script hammering this endpoint: without the brake
     * it is an unauthenticated way to make the server hash passwords all day.
     * Keyed on the IP alone — there is no account name to key on yet. */
    const rlKey = RateLimit.key(ctx.ip, '\u0000setup');
    const gate = limiter.check(rlKey);
    if (gate.limited) return rateLimited(res, gate.retryAfterMs);

    if (!accounts.checkSetupToken(str(body.value.token))) {
      limiter.fail(rlKey);
      return apiError(res, 400, 'BAD_TOKEN',
        'That setup token is not right. It is printed in the server’s ' +
        'console, and saved in the data directory as setup-token.txt.');
    }

    const n = accounts.checkName(str(body.value.name));
    if (n.code) return apiError(res, 400, 'BAD_NAME', n.error);

    const pw = accounts.checkPassword(str(body.value.password));
    if (pw.code) return apiError(res, 400, 'WEAK_PASSWORD', pw.error);

    setupInFlight = true;
    let made;
    try {
      // The first account is always an administrator: docs/AUTH-API.md §6.
      made = await accounts.createUser(n.value, pw.value, 'admin');
    } finally {
      setupInFlight = false;
    }
    if (made.code) return apiError(res, 400, made.code, made.error);

    await accounts.consumeSetupToken();
    limiter.succeed(rlKey);
    await accounts.noteSignIn(made.user);

    const token = sessions.create(made.user);
    console.log('[keys] first-run setup complete; administrator "' +
      made.user.name + '" created.');
    return sendJson(res, 201, { user: accounts.publicUser(made.user) },
      { 'Set-Cookie': sessionCookie(token, secure) });
  }

  /* --- POST /api/auth/signin -------------------------------------------- */
  if (p === '/api/auth/signin' && method === 'POST') {
    const body = await ctx.body();
    if (!body.ok) return badBody(res, body);

    const name = str(body.value.name);
    const password = str(body.value.password);
    const rlKey = RateLimit.key(ctx.ip, name);

    const gate = limiter.check(rlKey);
    if (gate.limited) return rateLimited(res, gate.retryAfterMs);

    const user = accounts.findByName(name);
    /* `user` may be null, and verifyPassword is written to do the same amount
     * of work either way — see the comment on it in accounts.js. Do not add an
     * early return here for the unknown-name case: the timing difference is
     * exactly how a stranger works out which parish names have accounts. */
    const ok = await accounts.verifyPassword(user, password);

    if (!ok) {
      limiter.fail(rlKey);
      /* One message for a wrong name and a wrong password. */
      return apiError(res, 401, 'BAD_CREDENTIALS',
        'That name and password do not match.');
    }

    limiter.succeed(rlKey);
    await accounts.noteSignIn(user);
    const token = sessions.create(user);
    return sendJson(res, 200, { user: accounts.publicUser(user) },
      { 'Set-Cookie': sessionCookie(token, secure) });
  }

  /* --- POST /api/auth/signout ------------------------------------------- */
  if (p === '/api/auth/signout' && method === 'POST') {
    const auth = authenticate(req);
    if (auth.session) sessions.destroy(auth.session);
    /* 204 whether or not there was a session: signing out is idempotent, and a
     * client that has already been expired should not get an error for tidying
     * up after itself. */
    res.writeHead(204, {
      'Set-Cookie': clearedCookie(secure),
      'Cache-Control': 'no-store'
    });
    return res.end();
  }

  /* --- POST /api/auth/touch --------------------------------------------- */
  if (p === '/api/auth/touch' && method === 'POST') {
    const auth = authenticate(req);
    if (!auth.user) return unauthenticated(res, auth.code);

    const now = Date.now();
    const idleFor = sessions.idleFor(auth.session, now);
    /* Both numbers describe the moment this request ARRIVED, before the touch
     * below pushes the clock forward — which is why they add up to idleMs, as
     * the worked example in docs/AUTH-API.md §4 shows. */
    const expiresInMs = Math.max(0, IDLE_MS - idleFor);
    sessions.touch(auth.session, now);

    return sendJson(res, 200, {
      idleFor: idleFor,
      expiresInMs: expiresInMs,
      user: accounts.publicUser(auth.user)
    });
  }

  /* --- POST /api/auth/password ------------------------------------------ */
  if (p === '/api/auth/password' && method === 'POST') {
    const auth = authenticate(req);
    if (!auth.user) return unauthenticated(res, auth.code);

    const body = await ctx.body();
    if (!body.ok) return badBody(res, body);

    /* The current password first. Requiring it is what stops somebody who
     * walks up to an unlocked screen from locking the real user out of their
     * own account. */
    const ok = await accounts.verifyPassword(auth.user, str(body.value.current));
    if (!ok) {
      return apiError(res, 401, 'BAD_CREDENTIALS',
        'That is not your current password.');
    }

    const pw = accounts.checkPassword(str(body.value.next));
    if (pw.code) return apiError(res, 400, 'WEAK_PASSWORD', pw.error);

    await accounts.setPassword(auth.user, pw.value);
    /* Half the reason anybody changes a password is that they think someone
     * else knows it. Leaving that someone else signed in would make the change
     * pointless. The session that asked for the change is kept. */
    const dropped = sessions.destroyOthersForUser(auth.user.id, auth.session);
    if (dropped) {
      console.log('[keys] password changed for "' + auth.user.name + '"; ' +
        dropped + ' other session(s) signed out.');
    }
    sessions.touch(auth.session);
    return sendJson(res, 200, { changed: true });
  }

  /* --- GET /api/users --------------------------------------------------- */
  if (p === '/api/users' && (method === 'GET' || method === 'HEAD')) {
    const auth = authenticate(req);
    if (!auth.user) return unauthenticated(res, auth.code);
    if (auth.user.role !== 'admin') return notAdmin(res);
    sessions.touch(auth.session);
    return sendJson(res, 200, { users: accounts.roster() });
  }

  /* --- POST /api/users -------------------------------------------------- */
  if (p === '/api/users' && method === 'POST') {
    const auth = authenticate(req);
    if (!auth.user) return unauthenticated(res, auth.code);
    if (auth.user.role !== 'admin') return notAdmin(res);
    sessions.touch(auth.session);

    const body = await ctx.body();
    if (!body.ok) return badBody(res, body);

    const n = accounts.checkName(str(body.value.name));
    if (n.code === 'NAME_TAKEN') return apiError(res, 409, 'NAME_TAKEN', n.error);
    if (n.code) return apiError(res, 400, 'BAD_NAME', n.error);

    const pw = accounts.checkPassword(str(body.value.password));
    if (pw.code) return apiError(res, 400, 'WEAK_PASSWORD', pw.error);

    /* Anything that is not exactly "admin" is a user. An unrecognised role must
     * never round UP to administrator. */
    const role = str(body.value.role) === 'admin' ? 'admin' : 'user';

    const made = await accounts.createUser(n.value, pw.value, role);
    if (made.code === 'NAME_TAKEN') {
      return apiError(res, 409, 'NAME_TAKEN', made.error);
    }
    if (made.code) return apiError(res, 400, made.code, made.error);

    console.log('[keys] "' + auth.user.name + '" added "' + made.user.name +
      '" as ' + made.user.role + '.');
    return sendJson(res, 201, { user: accounts.publicUser(made.user) });
  }

  /* --- DELETE /api/users/:name ------------------------------------------ */
  if (p.startsWith('/api/users/') && method === 'DELETE') {
    const auth = authenticate(req);
    if (!auth.user) return unauthenticated(res, auth.code);

    const targetName = p.slice('/api/users/'.length);
    if (!targetName) return notFound(res);

    const isSelfByName =
      targetName.trim().toLowerCase() === auth.user.name.toLowerCase();

    /* Authorisation BEFORE existence, on purpose. Checking existence first
     * would turn this endpoint into a way for an ordinary user to discover who
     * has an account, by reading 404 as "no" and 403 as "yes". */
    if (!isSelfByName && auth.user.role !== 'admin') return notAdmin(res);

    const target = accounts.findByName(targetName);
    if (!target) {
      return apiError(res, 404, 'NO_SUCH_USER',
        'There is no account by that name.');
    }

    if (accounts.wouldStripLastAdmin(target)) {
      const self = target.id === auth.user.id;
      return apiError(res, 409, 'LAST_ADMIN', self
        ? 'You are the only administrator. Make somebody else an ' +
          'administrator first, or nobody will be able to manage accounts.'
        : 'That is the only administrator, so it cannot be removed.');
    }

    const self = target.id === auth.user.id;
    await accounts.removeUser(target);
    /* Every session that account had, not just this one. A deleted person with
     * a live cookie in another browser is still signed in otherwise. */
    sessions.destroyAllForUser(target.id);
    console.log('[keys] "' + auth.user.name + '" removed "' + target.name + '".');

    const headers = self ? { 'Set-Cookie': clearedCookie(secure) } : null;
    if (!self) sessions.touch(auth.session);
    return sendJson(res, 200, {
      removed: accounts.publicUser(target),
      self: self
    }, headers);
  }

  /* No such endpoint. Plain 404 rather than one of §4's error codes: every code
   * in that list means something specific about accounts or sessions, and
   * borrowing one to mean "you typed the URL wrong" would have the client
   * branching on it. §3's last row already says anything else is a 404. */
  return notFound(res);
}

function notAdmin(res) {
  apiError(res, 403, 'NOT_ADMIN',
    'Only an administrator can do that.');
}

function rateLimited(res, retryAfterMs) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  sendJson(res, 429, {
    error: 'Too many sign-in attempts. Try again in about ' + seconds +
           ' second' + (seconds === 1 ? '' : 's') + '.',
    code: 'RATE_LIMITED',
    retryAfterMs: retryAfterMs
  }, { 'Retry-After': String(seconds) });
}

function badBody(res, body) {
  if (body.tooLarge) {
    return apiError(res, 413, 'BAD_JSON', 'That request was too large.');
  }
  return apiError(res, 400, 'BAD_JSON',
    'That request body was not the JSON object this endpoint expects.');
}

/* =============================================================================
 * STATIC ROUTES — docs/AUTH-API.md §3
 * ========================================================================== */
async function handleStatic(req, res, ctx) {
  const p = ctx.path;
  const method = req.method;

  if (method !== 'GET' && method !== 'HEAD') return notFound(res);

  const auth = authenticate(req);
  const signedIn = !!auth.user;

  if (p === '/') {
    if (signedIn) {
      sessions.touch(auth.session);
      return sendFile(req, res, INDEX_FILE, MIME['.html'], 'no-store');
    }
    /* The whole point of §6: a fresh box sends you to /setup, not to a sign-in
     * form for an account that does not exist yet. */
    return redirect(res, accounts.hasAccounts() ? '/login' : '/setup');
  }

  if (p === '/login') {
    if (signedIn) return redirect(res, '/');
    return sendFile(req, res, LOGIN_FILE, MIME['.html'], 'no-store');
  }

  if (p === '/setup') {
    if (signedIn) return redirect(res, '/');
    if (accounts.hasAccounts()) return redirect(res, '/login');
    return sendFile(req, res, SETUP_FILE, MIME['.html'], 'no-store');
  }

  if (p.startsWith('/assets/')) {
    /* The ONE unauthenticated asset. The sign-in and setup pages are styled by
     * it, and it must therefore be readable by someone who has not signed in.
     * It is a stylesheet: it reveals the colour of the buttons and nothing
     * about the newsletter, the roster or the application's behaviour. Written
     * as an exact path so it can never widen to a prefix by accident. */
    const open = (p === '/assets/css/app.css');

    if (!open && !signedIn) {
      return unauthenticated(res, auth.code);
    }

    const found = await resolveAsset(p);
    if (!found) return notFound(res);

    if (signedIn) sessions.touch(auth.session);
    /* `private` so a shared proxy never holds a copy; `no-cache` so the browser
     * revalidates every time, which means the auth gate above runs every time. */
    return sendFile(req, res, found.file, found.type, 'private, no-cache');
  }

  return notFound(res);
}

/* =============================================================================
 * THE HANDLER
 * ========================================================================== */
/* Last time any request arrived. Only local mode reads it — see
 * LOCAL_IDLE_EXIT_MS — and it is updated for every request, including the ones
 * that get refused, because a refused request still proves a browser is there. */
let lastRequestAt = Date.now();

async function handle(req, res) {
  lastRequestAt = Date.now();

  const secure = isSecure(req);
  applySecurityHeaders(res, secure);

  /* Local mode: our own name, or nothing. See localHostOk(). */
  if (LOCAL && !localHostOk(req.headers.host)) {
    console.warn('[keys] refused request with Host "' +
      String(req.headers.host || '') + '" — local mode answers only to ' +
      '127.0.0.1 and localhost.');
    return sendText(res, 400, 'Bad request.');
  }

  const parsed = parsePath(req.url);
  if (!parsed.ok) {
    /* Logged because a traversal attempt is worth knowing about, and the URL
     * is the attacker's own string — no secret of ours is in it. */
    console.warn('[keys] refused request path (' + parsed.reason + ') from ' +
      clientIp(req));
    return sendText(res, 400, 'Bad request.');
  }

  const method = req.method;

  /* docs/AUTH-API.md §2. Applied to EVERY non-GET request, before any routing,
   * so a new endpoint cannot be added later that quietly misses the check.
   *
   * HEAD is exempt with GET: it is the same read, without the body.
   *
   * There is no OPTIONS handler anywhere in this file, and no
   * Access-Control-Allow-* header anywhere either, and that is the point. A
   * cross-origin fetch() with Content-Type: application/json needs a successful
   * preflight first; an OPTIONS from another origin falls into this very check
   * and gets 403 with no CORS headers at all, so the preflight fails and the
   * real request is never sent. */
  if (method !== 'GET' && method !== 'HEAD') {
    if (!csrfOk(req, secure)) {
      return apiError(res, 403, 'CSRF',
        'That request did not look like it came from this site. Reload the ' +
        'page and try again.');
    }
  }

  const ctx = {
    path: parsed.path,
    query: parsed.query,
    secure: secure,
    ip: clientIp(req),
    /* Lazily read, and read at most once. Endpoints that reject before looking
     * at the body — SETUP_DONE, NOT_ADMIN — never pull it off the wire. */
    body: (() => {
      let pending = null;
      return () => (pending || (pending = readJsonBody(req)));
    })()
  };

  const isApi = (ctx.path === '/api' || ctx.path.startsWith('/api/'));

  /* The fork. Local mode's handlers never call authenticate(), never read
   * accounts and never create a session; served mode's are untouched by local
   * mode existing. */
  if (LOCAL) {
    return isApi ? handleLocalApi(req, res, ctx) : handleLocalStatic(req, res, ctx);
  }

  if (isApi) return handleApi(req, res, ctx);
  return handleStatic(req, res, ctx);
}

/* =============================================================================
 * THE LISTENER
 * ========================================================================== */
function createServer() {
  const onRequest = (req, res) => {
    handle(req, res).catch((err) => {
      /* The stack goes to the log, never to the client. A stack trace names
       * paths, module versions and sometimes arguments. */
      console.error('[keys] unhandled error on ' + req.method + ' ' +
        String(req.url).split('?')[0] + ':', err && err.stack ? err.stack : err);
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: 'Something went wrong on the server. The details are in its log.',
          code: 'BAD_JSON'
        });
      } else {
        res.destroy();
      }
    });
  };

  if (TLS_ON) {
    return https.createServer({
      cert: fs.readFileSync(TLS_CERT),
      key: fs.readFileSync(TLS_KEY),
      minVersion: 'TLSv1.2'
    }, onRequest);
  }
  return http.createServer(onRequest);
}

function banner(lines) {
  const rule = '─'.repeat(60);
  console.log('');
  console.log(rule);
  for (const line of lines) console.log('  ' + line);
  console.log(rule);
  console.log('');
}

/* The marker desktop/launch.js waits for on stdout. It is printed once, only in
 * local mode, and only after listen() has succeeded, so the launcher opens the
 * browser at the port the server really got rather than the one it asked for.
 * If you rename this, rename it in desktop/launch.js too. */
const LOCAL_READY_PREFIX = '[keys] KEYS-LOCAL-READY ';

async function main() {
  /* ===========================================================================
   * THE INTERLOCK, ACTED ON BEFORE ANYTHING ELSE.
   *
   * First statement of the program's real work, on purpose: nothing is loaded,
   * no socket is opened and no file is written before this refusal has had its
   * chance. Read the long comment beside HOST_REFUSAL before touching it.
   * ======================================================================== */
  if (HOST_REFUSAL) {
    console.error('[keys] ' + HOST_REFUSAL);
    process.exit(1);
  }

  /* Local mode has no accounts, so it does not read, create or write the data
   * directory at all — no accounts.json, no setup-token.txt, nothing to leave
   * behind on somebody's laptop. */
  if (!LOCAL) await accounts.load();

  /* Resolve the assets root once, with symlinks followed, so the containment
   * check in resolveAsset() compares like with like. */
  try {
    ASSETS_REAL = await fsp.realpath(ASSETS_ROOT);
  } catch (e) {
    console.error('[keys] cannot find ' + ASSETS_ROOT + '. Run this from the ' +
      'repository, or check the checkout is complete.');
    process.exit(1);
  }

  const token = LOCAL ? null : await accounts.ensureSetupToken();

  if (TLS_IGNORED) {
    console.warn('[keys] KEYS_TLS_CERT/KEY are set but local mode is plain ' +
      'http on 127.0.0.1; ignoring them.');
  }

  const server = createServer();

  /* The same rule again, one line above the call that would break it. HOST is a
   * const computed from LOCAL, so this cannot fire — which is why it is cheap
   * to keep. It exists so that anyone who later makes HOST mutable, or moves
   * the computation, is stopped here instead of shipping an unauthenticated
   * server on 0.0.0.0. */
  if (LOCAL && HOST !== LOOPBACK) {
    console.error('[keys] refusing to listen: local mode must bind ' +
      LOOPBACK + ', not "' + HOST + '". This is a bug in server.js.');
    process.exit(1);
  }

  let listenPort = PORT;

  if (LOCAL) {
    /* Walk upward. Nobody double-clicking a launcher can be asked to free a
     * port, and the launcher is told which one we landed on. */
    let tried = 1;
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && tried < LOCAL_PORT_TRIES &&
          listenPort < 65535) {
        tried++;
        console.log('[keys] port ' + listenPort + ' is busy; trying ' +
          (listenPort + 1) + '.');
        listenPort += 1;
        server.listen(listenPort, HOST);
        return;
      }
      if (err.code === 'EADDRINUSE') {
        console.error('[keys] ports ' + PORT + '-' + listenPort + ' are all ' +
          'in use. Close whatever is using them, or set KEYS_PORT to a free ' +
          'one and try again.');
      } else {
        console.error('[keys] server error:', err.message);
      }
      process.exit(1);
    });
  } else {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error('[keys] port ' + PORT + ' is already in use. Set ' +
          'KEYS_PORT to something else, or stop the other server.');
      } else if (err.code === 'EACCES') {
        console.error('[keys] not allowed to listen on port ' + PORT + '. ' +
          'Ports below 1024 need extra privileges — use a high port and put a ' +
          'reverse proxy in front (see server/README.md).');
      } else {
        console.error('[keys] server error:', err.message);
      }
      process.exit(1);
    });
  }

  server.on('listening', () => {
    const addr = server.address();
    if (addr && typeof addr === 'object' && addr.port) listenPort = addr.port;

    const scheme = TLS_ON ? 'https' : 'http';
    const shown = (HOST === '0.0.0.0' || HOST === '::') ? 'localhost' : HOST;

    if (LOCAL) {
      const url = 'http://' + LOOPBACK + ':' + listenPort + '/';
      console.log('[keys] St. Peter’s Keys — desktop (local) mode.');
      console.log('[keys]   ' + url);
      console.log('[keys]   address    ' + LOOPBACK + ' only — this server is ' +
        'not reachable from the network');
      console.log('[keys]   accounts   none: authentication is OFF in local mode');
      console.log('[keys]   idle exit  ' + (LOCAL_IDLE_EXIT_MS
        ? Math.round(LOCAL_IDLE_EXIT_MS / 60000) + ' minutes with no requests'
        : 'never (KEYS_LOCAL_IDLE_MS=0)'));
      console.log(LOCAL_READY_PREFIX + url);
      return;
    }

    console.log('[keys] St. Peter’s Keys is being served.');
    console.log('[keys]   ' + scheme + '://' + shown + ':' + listenPort + '/');
    console.log('[keys]   data       ' + DATA_DIR);
    console.log('[keys]   accounts   ' + accounts.count);
    console.log('[keys]   idle       ' + Math.round(IDLE_MS / 1000) + 's');
    console.log('[keys]   session    ' + Math.round(MAX_AGE_MS / 3600000) + 'h maximum');
    console.log('[keys]   tls        ' + (TLS_ON ? 'on' : 'OFF'));

    if (!TLS_ON) {
      /* Said plainly, every start. Anyone reachable on the parish network can
       * read a password typed into a page served over plain http, and the
       * failure is silent — everything works, so nobody investigates. */
      console.warn('[keys] WARNING: no TLS. Passwords and session cookies ' +
        'cross the network in the clear.');
      console.warn('[keys]          See server/README.md for how to put a ' +
        'certificate in front of this.');
    }

    if (token) {
      /* The setup token is the ONE secret this server prints on purpose —
       * printing it IS its job, and it is useless the moment the first account
       * exists. Nothing else — no password, no session token, no hash — ever
       * appears in a log line from this process. */
      banner([
        'FIRST-RUN SETUP',
        'Open   ' + scheme + '://' + shown + ':' + listenPort + '/setup',
        'Token  ' + token,
        '',
        'Also saved to ' + path.join(DATA_DIR, 'setup-token.txt')
      ]);
    }
  });

  server.listen(listenPort, HOST);

  /* --- graceful shutdown --------------------------------------------------
   * Stop listening, let the requests that are already in flight finish, flush
   * any accounts write that is still queued, then go. The flush is the part
   * that matters: an admin who adds a user and immediately restarts the service
   * must not find that the user was never written.
   * ---------------------------------------------------------------------- */
  let shuttingDown = false;

  /* `why` is a signal name for the two signal handlers, and a short phrase for
   * local mode's inactivity timer, which is the one caller that is not a
   * signal. It is only ever printed. */
  const shutdown = (why) => {
    if (shuttingDown) {
      /* A second Ctrl-C means "I meant it". */
      console.warn('[keys] ' + why + ' again — exiting now.');
      process.exit(1);
    }
    shuttingDown = true;
    console.log('[keys] stopping (' + why + '); finishing open requests.');

    sessions.stop();
    limiter.stop();

    server.close(() => {
      accounts.flush().then(() => {
        console.log('[keys] stopped.');
        process.exit(0);
      });
    });

    /* Keep-alive sockets sitting idle would otherwise hold the close open for
     * as long as the client felt like. */
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }

    const giveUp = setTimeout(() => {
      console.warn('[keys] some connections would not close; exiting anyway.');
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      accounts.flush().then(() => process.exit(0));
    }, 5000);
    if (typeof giveUp.unref === 'function') giveUp.unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  /* SIGHUP is what a closed Terminal window or console sends to everything in
   * its process group, and it is the desktop app's ordinary way of being told
   * to stop. Node's default for SIGHUP is to die anyway; handling it means the
   * accounts flush and the "stopped." line still happen, and it costs served
   * mode nothing. */
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  /* --- local mode: stop after a long silence ------------------------------
   * See LOCAL_IDLE_EXIT_MS for why this is measured in requests-not-arriving
   * rather than in tabs-closing, and why the number is an hour. */
  if (LOCAL && LOCAL_IDLE_EXIT_MS > 0) {
    const CHECK_MS = Math.min(60000, LOCAL_IDLE_EXIT_MS);
    const watcher = setInterval(() => {
      if (shuttingDown) return;
      const quietFor = Date.now() - lastRequestAt;
      if (quietFor < LOCAL_IDLE_EXIT_MS) return;
      console.log('[keys] nothing has asked for anything in ' +
        Math.round(quietFor / 60000) + ' minutes, so the browser has ' +
        'evidently gone. Stopping — double-click the launcher again when ' +
        'you next want it.');
      clearInterval(watcher);
      shutdown('no activity');
    }, CHECK_MS);
    /* NOT unref'd: this timer is the only thing that will ever end an
     * otherwise-idle desktop server, and an unref'd one would let the process
     * exit... which is the same outcome, but by luck rather than on purpose.
     * Keeping the reference means the reason for stopping is always printed. */
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[keys] could not start: ' + (err && err.message ? err.message : err));
    process.exit(1);
  });
}

module.exports = { parsePath, csrfOk, sessionCookie, CSP, MIME };
