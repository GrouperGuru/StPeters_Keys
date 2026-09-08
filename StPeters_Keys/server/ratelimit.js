/* =============================================================================
 * ratelimit.js — sign-in backoff. docs/AUTH-API.md §8.
 *
 * Owns: counting failed sign-ins per (IP, name) and deciding how long the next
 * attempt has to wait.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * This is a brake on password guessing. Five attempts are free — that is the
 * "I have three passwords and I always try them in the wrong order" budget,
 * and anything smaller generates support calls rather than security. After
 * that the wait doubles from one second, so the sixth attempt costs a second,
 * the tenth costs sixteen, and a script that wanted a dictionary through here
 * would need years. It gives up and forgets after fifteen quiet minutes, so a
 * person who was locked out at lunchtime is not still locked out at three.
 *
 * It is NOT a defence against a distributed attacker, and it is NOT a general
 * request limiter. The key includes the client IP, so a botnet with a thousand
 * addresses gets a thousand separate five-attempt budgets. What actually stops
 * that is the 310,000-iteration PBKDF2 in accounts.js, which makes every
 * attempt expensive for the SERVER too — which is precisely why guessing is
 * throttled here before the hash is ever computed.
 *
 * It is also NOT persistent. A restart forgives everybody. On a parish server
 * that restarts once a month that is fine; if this ever needs to survive a
 * restart it needs a real store, not a bigger Map.
 *
 * -----------------------------------------------------------------------------
 * WHY (IP, NAME) AND NOT JUST ONE OF THEM
 *
 * Keying on the name alone lets anyone lock a specific person out of their own
 * account from anywhere — a denial of service with a one-line script. Keying on
 * the IP alone means the whole parish hall shares one budget behind a single
 * NAT address, and one person fat-fingering their password five times locks out
 * everybody else. The pair is the only version that is neither.
 * ========================================================================== */
'use strict';

/* Five attempts before the brake engages at all. */
const FREE_ATTEMPTS = 5;

/* The first penalty, then double each time. */
const BASE_DELAY_MS = 1000;

/* The ceiling. Beyond five minutes the extra wait buys nothing an attacker
 * notices and only makes an honest lockout feel permanent. */
const MAX_DELAY_MS = 5 * 60 * 1000;

/* Forget a quiet key entirely after this long. Also what stops the Map growing
 * without bound. */
const DECAY_MS = 15 * 60 * 1000;

const SWEEP_INTERVAL_MS = 60 * 1000;

class RateLimit {
  constructor(options) {
    const opts = options || {};
    this.freeAttempts = opts.freeAttempts != null ? opts.freeAttempts : FREE_ATTEMPTS;
    this.baseDelayMs = opts.baseDelayMs || BASE_DELAY_MS;
    this.maxDelayMs = opts.maxDelayMs || MAX_DELAY_MS;
    this.decayMs = opts.decayMs || DECAY_MS;

    /* key -> { fails, lastAt, nextAllowedAt } */
    this.entries = new Map();

    this._sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (typeof this._sweeper.unref === 'function') this._sweeper.unref();
  }

  /** The key for a (client, account) pair.
   *
   *  The name is lowercased because account names are compared
   *  case-insensitively everywhere else; if it were not, "RYAN" and "ryan"
   *  would be two independent five-attempt budgets for the same account, and
   *  the limiter could be walked around by holding down shift.
   *
   *  The separator is a NUL rather than a space because a name may contain
   *  spaces: with " " between them, ("10.0.0.1 bob", "smith") and
   *  ("10.0.0.1", "bob smith") are the same key. A NUL cannot appear in either
   *  half — NAME_RE in accounts.js forbids it — so the pair is unambiguous. */
  static key(ip, name) {
    return String(ip || '?') + '\u0000' + String(name == null ? '' : name).trim().toLowerCase();
  }

  /** May this key attempt a sign-in right now?
   *  Returns { limited: false } or { limited: true, retryAfterMs }. */
  check(key, now) {
    const t = now || Date.now();
    const e = this.entries.get(key);
    if (!e) return { limited: false };

    if (t - e.lastAt > this.decayMs) {
      this.entries.delete(key);
      return { limited: false };
    }
    if (e.nextAllowedAt > t) {
      return { limited: true, retryAfterMs: e.nextAllowedAt - t };
    }
    return { limited: false };
  }

  /** Record a failed attempt and set the next allowed time.
   *
   *  With FREE_ATTEMPTS = 5: the fifth failure is the first one that carries a
   *  penalty, so attempts one to five are answered immediately and the SIXTH is
   *  the one that gets 429. That is the behaviour the contract describes as
   *  "5 free attempts, then a doubling delay from 1s". */
  fail(key, now) {
    const t = now || Date.now();
    let e = this.entries.get(key);

    if (!e || t - e.lastAt > this.decayMs) {
      e = { fails: 0, lastAt: t, nextAllowedAt: 0 };
      this.entries.set(key, e);
    }

    e.fails += 1;
    e.lastAt = t;

    if (e.fails >= this.freeAttempts) {
      const steps = e.fails - this.freeAttempts;
      /* Math.min BEFORE the shift, not after: 2 ** 40 is a finite number but
       * an absurd one, and clamping the exponent as well as the product keeps
       * this away from anywhere Infinity could appear. */
      const delay = Math.min(
        this.baseDelayMs * Math.pow(2, Math.min(steps, 30)),
        this.maxDelayMs
      );
      e.nextAllowedAt = t + delay;
      return { retryAfterMs: delay, fails: e.fails };
    }
    return { retryAfterMs: 0, fails: e.fails };
  }

  /** A correct password wipes the slate for that pair. Somebody who has just
   *  proved who they are should not still be carrying a penalty from the three
   *  typos it took to get there. */
  succeed(key) {
    this.entries.delete(key);
  }

  sweep(now) {
    const t = now || Date.now();
    let n = 0;
    for (const [key, e] of this.entries) {
      if (t - e.lastAt > this.decayMs) { this.entries.delete(key); n++; }
    }
    return n;
  }

  get size() { return this.entries.size; }

  stop() {
    if (this._sweeper) { clearInterval(this._sweeper); this._sweeper = null; }
  }
}

RateLimit.FREE_ATTEMPTS = FREE_ATTEMPTS;
RateLimit.BASE_DELAY_MS = BASE_DELAY_MS;
RateLimit.MAX_DELAY_MS = MAX_DELAY_MS;
RateLimit.DECAY_MS = DECAY_MS;

module.exports = { RateLimit };
