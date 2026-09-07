/* =============================================================================
 * sessions.js — the in-memory session store.
 *
 * Owns: minting session tokens, finding the session behind a cookie, both
 * expiry clocks, sweeping dead sessions, and invalidating a user's other
 * sessions when their password changes.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * Sessions live in a Map and nowhere else. A restart signs everybody out. That
 * is deliberate and slightly safer than persisting them: a stolen laptop with a
 * copy of the data directory yields nothing that can be replayed, and a service
 * that has just been restarted for a security fix has not carried the old
 * sessions across the fix. The cost is that `systemctl restart` interrupts
 * whoever is typing — the newsletter autosaves continuously, so what they lose
 * is a sign-in prompt, not an article.
 *
 * It is NOT a token this store can hand back. What is kept is sha256(token),
 * never the token. If this Map is ever dumped — a heap snapshot, a crash log, a
 * careless console.log of the whole store — nothing in it can be pasted into a
 * cookie jar. The token exists exactly twice: in the Set-Cookie header on the
 * way out, and in the browser.
 *
 * It knows nothing about HTTP or about accounts. It stores a user id and a name
 * and answers questions about clocks.
 *
 * -----------------------------------------------------------------------------
 * TWO CLOCKS, BOTH ENFORCED HERE
 *
 * Idle:     KEYS_IDLE_MS since the last authenticated request (default 5 min).
 * Absolute: 12 hours since sign-in, no matter how busy the session has been.
 *
 * Both are checked server-side on every request. The client is never trusted
 * about time — a client that has had its timers throttled, or whose clock is
 * simply wrong, or which has been edited by whoever is sitting at it, must not
 * be able to keep a session alive by insisting that it is fresh.
 * ========================================================================== */
'use strict';

const crypto = require('node:crypto');

const TOKEN_BYTES = 32;

/* An absolute ceiling on a session. A browser left open on an office machine
 * overnight should not still be signed in in the morning, however much the
 * screensaver was nudged. */
const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const DEFAULT_IDLE_MS = 5 * 60 * 1000;

/* Expired sessions are already refused on lookup; the sweep only stops the Map
 * growing without bound on a busy, long-lived process. A minute is plenty. */
const SWEEP_INTERVAL_MS = 60 * 1000;

/* The sweep waits this long PAST expiry before forgetting a session, and that
 * delay is a feature rather than laziness. lookup() is what tells the client
 * WHY it was turned away — "IDLE" produces "you were signed out after a spell
 * without activity, your newsletter was saved", which is a timeout; once the
 * record is gone the only honest answer is "NO_SESSION", which reads as a
 * fault. A laptop closed over lunch should come back to the first message. The
 * record is refused from the instant it expires either way; all this changes is
 * how long the reason survives. */
const REAP_GRACE_MS = 15 * 60 * 1000;

/** sha256 of the token, as a Buffer. The hex form of this is the Map key. */
function digest(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest();
}

class Sessions {
  constructor(options) {
    const opts = options || {};
    this.idleMs = opts.idleMs || DEFAULT_IDLE_MS;
    this.maxAgeMs = opts.maxAgeMs || DEFAULT_MAX_AGE_MS;

    /* hex(sha256(token)) -> { digest, userId, name, createdAt, lastSeen } */
    this.byDigest = new Map();

    this._sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    /* unref so an idle sweep timer never keeps the process alive after the
     * HTTP server has closed. Without this, graceful shutdown hangs for up to
     * a minute for no reason anybody can see. */
    if (typeof this._sweeper.unref === 'function') this._sweeper.unref();
  }

  /** Mint a session and return the raw token — the ONLY moment the token is
   *  available. It goes straight into Set-Cookie and is never stored, logged or
   *  returned again. */
  create(user) {
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const d = digest(token);
    const now = Date.now();
    this.byDigest.set(d.toString('hex'), {
      digest: d,
      userId: user.id,
      name: user.name,
      createdAt: now,
      lastSeen: now
    });
    return token;
  }

  /** Find the session behind a cookie value.
   *
   *  Returns { ok: true, session } or { ok: false, code } where code is one of
   *  NO_SESSION / IDLE / EXPIRED, matching docs/AUTH-API.md §4.
   *
   *  On constant time: the Map is keyed by the SHA-256 of the token, so the
   *  hash-table probe compares digests, not secrets — a timing signal about
   *  which bucket was hit tells an attacker something about sha256(guess),
   *  which they can compute themselves anyway and cannot invert. The
   *  timingSafeEqual below is therefore belt and braces rather than the load
   *  bearing part, and it is here so that this file cannot later be cited as
   *  an example of comparing session tokens with ===. */
  lookup(token, now) {
    if (typeof token !== 'string' || token.length === 0) {
      return { ok: false, code: 'NO_SESSION' };
    }
    const t = now || Date.now();
    const d = digest(token);
    const session = this.byDigest.get(d.toString('hex'));
    if (!session) return { ok: false, code: 'NO_SESSION' };
    if (!crypto.timingSafeEqual(d, session.digest)) {
      return { ok: false, code: 'NO_SESSION' };
    }

    /* Absolute first: if both clocks have run out, "your day is over" is the
     * more useful thing to tell somebody than "you stepped away".
     *
     * Note what does NOT happen here: the expired record is not deleted. It is
     * refused, and left for the sweep to forget REAP_GRACE_MS later. Deleting
     * it on the spot means the FIRST request after expiry learns the real
     * reason and every one after that is told NO_SESSION — so whether the user
     * sees "you were signed out after a spell without activity" or the much
     * more alarming "sign in to continue" depends on whether the heartbeat or
     * a stylesheet happened to arrive first. Nothing is gained by the early
     * delete: an expired record is refused either way. */
    if (t - session.createdAt > this.maxAgeMs) {
      return { ok: false, code: 'EXPIRED' };
    }
    if (t - session.lastSeen > this.idleMs) {
      return { ok: false, code: 'IDLE' };
    }
    return { ok: true, session: session };
  }

  /** Milliseconds since this session last made an authenticated request. */
  idleFor(session, now) {
    return (now || Date.now()) - session.lastSeen;
  }

  /** Push the idle clock forward. Called for every authenticated request
   *  EXCEPT GET /api/auth/state — see the note at that route in server.js. */
  touch(session, now) {
    session.lastSeen = now || Date.now();
  }

  destroy(session) {
    if (!session) return;
    this.byDigest.delete(session.digest.toString('hex'));
  }

  /** Every session that user has, gone. Used when the account is deleted:
   *  a session whose account no longer exists must not survive to the next
   *  request, and leaving it to expire on its own would keep a deleted person
   *  signed in for up to five minutes. */
  destroyAllForUser(userId) {
    let n = 0;
    for (const [key, s] of this.byDigest) {
      if (s.userId === userId) { this.byDigest.delete(key); n++; }
    }
    return n;
  }

  /** Every session that user has EXCEPT this one.
   *
   *  This is what a password change is for, half the time: somebody thinks
   *  another person may know their password, so they change it. If the other
   *  person's session survived the change, the change achieved nothing. The
   *  session that made the change is kept, because signing yourself out as the
   *  reward for good security hygiene is how you teach people not to do it. */
  destroyOthersForUser(userId, keep) {
    const keepKey = keep ? keep.digest.toString('hex') : null;
    let n = 0;
    for (const [key, s] of this.byDigest) {
      if (s.userId === userId && key !== keepKey) {
        this.byDigest.delete(key);
        n++;
      }
    }
    return n;
  }

  /** Drop everything both clocks condemned more than REAP_GRACE_MS ago. Purely
   *  housekeeping — lookup() has been refusing these since the moment they
   *  expired. See the note on REAP_GRACE_MS for why it is not immediate. */
  sweep(now) {
    const t = now || Date.now();
    let n = 0;
    for (const [key, s] of this.byDigest) {
      if (t - s.createdAt > this.maxAgeMs + REAP_GRACE_MS ||
          t - s.lastSeen > this.idleMs + REAP_GRACE_MS) {
        this.byDigest.delete(key);
        n++;
      }
    }
    return n;
  }

  get size() { return this.byDigest.size; }

  /** Stop the sweep timer so the process can exit. */
  stop() {
    if (this._sweeper) { clearInterval(this._sweeper); this._sweeper = null; }
  }
}

Sessions.DEFAULT_IDLE_MS = DEFAULT_IDLE_MS;
Sessions.DEFAULT_MAX_AGE_MS = DEFAULT_MAX_AGE_MS;
Sessions.TOKEN_BYTES = TOKEN_BYTES;

module.exports = { Sessions };
