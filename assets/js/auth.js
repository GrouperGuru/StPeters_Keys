/* =============================================================================
 * auth.js — Accounts, the sign-in gate, and the Settings panel.
 *
 * Exposes window.Keys.Auth. Loaded BEFORE app.js so app.js can hand it the
 * boot decision.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * This app is static files opened straight from disk. There is no server, so
 * this is NOT an access-control boundary and must never be described as one.
 * Anyone holding these files can:
 *
 *   - open devtools and set the session key by hand,
 *   - edit this file to skip the check,
 *   - read the newsletter out of the saved .json or localStorage directly.
 *
 * What it genuinely does is keep the newsletter out of the way of whoever
 * wanders up to a shared office computer, and record who is working on the
 * issue. That is a real and useful thing; it is just not security. Every place
 * this surfaces in the UI says so, on purpose — a lock that overstates itself
 * is worse than no lock, because someone will put confidential information
 * behind it.
 *
 * The one part that IS done properly is password storage: PBKDF2-SHA256 with a
 * per-user random salt and 310,000 iterations (OWASP's floor for this KDF), so
 * a password reused elsewhere is not handed over by a glance at localStorage,
 * and an offline attack on the stored hash is expensive rather than instant.
 * `file://` is a secure context in every current browser, so crypto.subtle is
 * available; where it is not, the gate stands down entirely rather than fall
 * back to something weaker (see cryptoAvailable below).
 * ========================================================================== */
(function (global) {
  'use strict';

  var Keys = global.Keys = global.Keys || {};

  var ACCOUNTS_KEY = 'stpeters.keys.accounts.v1';
  var SESSION_KEY = 'stpeters.keys.session.v1';
  var SCHEMA_VERSION = 1;

  /* OWASP Password Storage Cheat Sheet's floor for PBKDF2-HMAC-SHA256.
   * Measured at ~45ms on the reference machine — imperceptible on sign-in,
   * but it multiplies the cost of an offline dictionary attack by 310,000. */
  var ITERATIONS = 310000;
  var KEY_BITS = 256;
  var SALT_BYTES = 16;

  var MIN_PASSWORD = 8;
  var MAX_NAME = 40;

  /* An absolute ceiling on a session, on top of sessionStorage clearing when
   * the tab closes. A browser left open overnight on an office machine should
   * not still be signed in in the morning. */
  var SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

  /* ---------------------------------------------------------------------------
   * Idle timeout
   *
   * Five minutes of INACTIVITY, not five minutes of wall clock. The point of
   * this lock is the office machine somebody walked away from, and a hard
   * five-minute cap would throw an author out in the middle of typing an
   * article — which is both useless and the fastest way to get the whole
   * feature switched off. Any pointer, key, scroll or focus resets it.
   *
   * To make it an absolute cap instead, stop calling noteActivity() from the
   * listeners in watchActivity() — nothing else needs to change.
   *
   * `lastSeen` on the session (not an in-memory clock) is the source of truth,
   * so the timeout survives a reload and is still enforced when a background
   * tab has had its timers throttled. Writes are throttled to one every few
   * seconds, so the stored value can lag real activity by up to
   * TOUCH_THROTTLE_MS — five seconds of conservatism against a five-minute
   * budget, which is the right direction to be wrong in.
   * ------------------------------------------------------------------------ */
  var IDLE_MS = 5 * 60 * 1000;
  var IDLE_WARN_MS = 30 * 1000;     // warn this long before signing out
  var IDLE_TICK_MS = 5000;
  var TOUCH_THROTTLE_MS = 5000;

  /* Why the last sign-out happened, so the gate can say so. One-shot. */
  var REASON_KEY = 'stpeters.keys.signout-reason.v1';

  var ROLES = { admin: 1, user: 1 };

  var bootApp = null;        // handed over by app.js
  var started = false;
  var idleTimer = null;
  var idleWarned = false;
  var activityBound = false;

  /* -------------------------------------------------------------------------
   * Small helpers
   * ---------------------------------------------------------------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function escText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) {
    return escText(s).replace(/"/g, '&quot;');
  }

  /** Is real key derivation available? Requires a secure context, which
   *  `file://` and `https://` are and plain `http://` is not. */
  function cryptoAvailable() {
    return !!(global.crypto && global.crypto.subtle &&
              global.crypto.getRandomValues);
  }

  function randomBytes(n) {
    var out = new Uint8Array(n);
    global.crypto.getRandomValues(out);
    return out;
  }

  function toBase64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return global.btoa(s);
  }

  function fromBase64(b64) {
    var s;
    try { s = global.atob(String(b64 || '')); } catch (e) { return new Uint8Array(0); }
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  /** Compare without leaking, through timing, how much of the hash matched.
   *  Irrelevant against someone sitting at the machine, but it costs three
   *  lines and stops this being cited as an example of how to do it. */
  function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  function uid() {
    return 'u-' + Date.now().toString(36) + '-' +
      toBase64(randomBytes(6)).replace(/[^a-z0-9]/gi, '').slice(0, 8);
  }

  /* -------------------------------------------------------------------------
   * Key derivation
   * ---------------------------------------------------------------------- */
  function deriveBits(password, salt, iterations) {
    var enc = new TextEncoder();
    return global.crypto.subtle
      .importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits'])
      .then(function (key) {
        return global.crypto.subtle.deriveBits({
          name: 'PBKDF2',
          salt: salt,
          iterations: iterations,
          hash: 'SHA-256'
        }, key, KEY_BITS);
      })
      .then(function (bits) { return new Uint8Array(bits); });
  }

  /* -------------------------------------------------------------------------
   * Account store
   *
   * localStorage is the only place to put this, and it is readable by anyone
   * at the machine — hence the hashing above, and hence the honesty in the UI.
   * ---------------------------------------------------------------------- */
  function readStore() {
    var raw;
    try { raw = localStorage.getItem(ACCOUNTS_KEY); } catch (e) { raw = null; }
    if (!raw) return { version: SCHEMA_VERSION, users: [] };

    var data;
    try { data = JSON.parse(raw); } catch (e) { data = null; }

    /* A hand-edited or corrupt store must not brick the app. Anything that is
     * not a usable record is dropped rather than trusted; if that leaves no
     * accounts at all, the gate falls back to first-run setup, which is the
     * safe direction to fail (it asks for a NEW password rather than letting
     * anyone in). */
    if (!data || typeof data !== 'object' || !Array.isArray(data.users)) {
      return { version: SCHEMA_VERSION, users: [] };
    }
    var users = data.users.filter(function (u) {
      return u && typeof u === 'object' && !Array.isArray(u) &&
        typeof u.name === 'string' && u.name.trim() &&
        typeof u.salt === 'string' && typeof u.hash === 'string' &&
        ROLES[u.role] === 1 &&
        isFinite(Number(u.iterations)) && Number(u.iterations) > 0;
    }).map(function (u) {
      return {
        id: String(u.id || uid()),
        name: String(u.name).slice(0, MAX_NAME),
        role: u.role,
        salt: String(u.salt),
        hash: String(u.hash),
        iterations: Math.min(Math.max(Math.trunc(Number(u.iterations)), 1), 5000000),
        createdAt: typeof u.createdAt === 'string' ? u.createdAt : null
      };
    });
    return { version: SCHEMA_VERSION, users: users };
  }

  function writeStore(store) {
    try {
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(store));
      return true;
    } catch (e) {
      return false;
    }
  }

  function findByName(store, name) {
    var wanted = String(name || '').trim().toLowerCase();
    for (var i = 0; i < store.users.length; i++) {
      if (store.users[i].name.toLowerCase() === wanted) return store.users[i];
    }
    return null;
  }

  function findById(store, id) {
    for (var i = 0; i < store.users.length; i++) {
      if (store.users[i].id === id) return store.users[i];
    }
    return null;
  }

  function adminCount(store) {
    return store.users.filter(function (u) { return u.role === 'admin'; }).length;
  }

  /** Public shape of a user: never the salt or the hash. */
  function publicUser(u) {
    if (!u) return null;
    return { id: u.id, name: u.name, role: u.role, createdAt: u.createdAt };
  }

  /* -------------------------------------------------------------------------
   * Session
   * ---------------------------------------------------------------------- */
  function rawSession() {
    var raw;
    try { raw = sessionStorage.getItem(SESSION_KEY); } catch (e) { raw = null; }
    if (!raw) return null;
    var s;
    try { s = JSON.parse(raw); } catch (e) { return null; }
    if (!s || typeof s !== 'object' || !s.userId) return null;
    return s;
  }

  /** Milliseconds since the session was last active, or Infinity if there
   *  isn't one. A missing/garbled `lastSeen` counts as expired rather than
   *  fresh — failing towards "sign in again" is the safe direction. */
  function idleFor(s) {
    s = s || rawSession();
    if (!s) return Infinity;
    var seen = Number(s.lastSeen);
    if (!isFinite(seen)) return Infinity;
    return Date.now() - seen;
  }

  function readSession() {
    var s = rawSession();
    if (!s) return null;

    if (!isFinite(Number(s.startedAt)) ||
        Date.now() - Number(s.startedAt) > SESSION_MAX_AGE_MS) {
      clearSession();
      return null;
    }
    /* Enforced HERE as well as on the timer, so a tab that was asleep — or one
     * reopened after the timers stopped running at all — is still signed out
     * on the way back in rather than only after the next tick. */
    if (idleFor(s) > IDLE_MS) {
      setSignOutReason('idle');
      clearSession();
      return null;
    }
    // The account may have been deleted in another tab since sign-in.
    var user = findById(readStore(), s.userId);
    if (!user) { clearSession(); return null; }
    return publicUser(user);
  }

  function writeSession(user) {
    var now = Date.now();
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        userId: user.id, startedAt: now, lastSeen: now
      }));
    } catch (e) {}
  }

  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  function setSignOutReason(reason) {
    try { sessionStorage.setItem(REASON_KEY, reason); } catch (e) {}
  }

  /** Read and consume the reason — it must show once, not on every reload. */
  function takeSignOutReason() {
    var r = null;
    try {
      r = sessionStorage.getItem(REASON_KEY);
      sessionStorage.removeItem(REASON_KEY);
    } catch (e) {}
    return r;
  }

  /* -------------------------------------------------------------------------
   * Idle watch
   * ---------------------------------------------------------------------- */

  /** Record that the user is still here. Throttled — this runs on mousemove.
   *
   *  The throttle is measured against the STORED `lastSeen`, not a separate
   *  in-memory "last written" clock. With two clocks they can drift apart
   *  (anything that writes the session without going through here desyncs
   *  them), and then a genuine burst of activity gets swallowed by a throttle
   *  that thinks it only just wrote. One clock cannot disagree with itself. */
  function noteActivity() {
    var now = Date.now();
    if (idleWarned) idleWarned = false;
    var s = rawSession();
    if (!s) return;
    if (now - Number(s.lastSeen || 0) < TOUCH_THROTTLE_MS) return;
    s.lastSeen = now;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {}
  }

  /** The check the timer runs. Exposed so tests can wind `lastSeen` back and
   *  run the real thing, rather than the timeout having to be shortened for
   *  them — a constant that only tests use is a constant nobody verifies. */
  function checkIdle() {
    var s = rawSession();
    if (!s) { stopIdleWatch(); return 'no session'; }

    var idle = idleFor(s);
    if (idle > IDLE_MS) { expireNow(); return 'expired'; }

    if (idle > IDLE_MS - IDLE_WARN_MS) {
      if (!idleWarned) {
        idleWarned = true;
        var secs = Math.max(5, Math.round((IDLE_MS - idle) / 1000));
        if (Keys.App && Keys.App.toast) {
          Keys.App.toast('You will be signed out in about ' + secs +
            ' seconds. Move the mouse or type to stay signed in.', 'warn');
        }
      }
      return 'warning';
    }
    return 'active';
  }

  /** Sign out because the session went idle, then hand the tab back to the
   *  gate. Reloading is how the manual Sign out works too, and it is the only
   *  way to be certain no rendered newsletter is left behind the gate. */
  function expireNow() {
    stopIdleWatch();
    setSignOutReason('idle');
    clearSession();
    reloadCleanly();
  }

  /* The newsletter is autosaved continuously, but `beforeunload` still puts up
   * the browser's "leave site?" prompt whenever State.dirty is set — which
   * would BLOCK this reload and leave the tab signed in with the newsletter on
   * screen, exactly the situation the timeout exists to prevent. Persist
   * first, then clear the flag so the unload is silent. Nothing is lost:
   * autosave writes the whole document, and boot restores it. */
  function reloadCleanly() {
    try {
      if (Keys.State) {
        Keys.State.autosave();
        Keys.State.dirty = false;
      }
    } catch (e) {}
    global.location.reload();
  }

  var ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel',
                         'scroll', 'focusin', 'input'];

  function watchActivity() {
    if (activityBound) return;
    activityBound = true;
    ACTIVITY_EVENTS.forEach(function (name) {
      document.addEventListener(name, noteActivity, { passive: true, capture: true });
    });
    // Coming back to a backgrounded tab must be re-checked at once: its timers
    // may have been throttled to a crawl while it was hidden.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkIdle();
    });
    global.addEventListener('focus', function () { checkIdle(); });
  }

  function startIdleWatch() {
    watchActivity();
    stopIdleWatch();
    idleWarned = false;
    idleTimer = setInterval(checkIdle, IDLE_TICK_MS);
  }

  function stopIdleWatch() {
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  }

  /* -------------------------------------------------------------------------
   * Validation
   * ---------------------------------------------------------------------- */
  function checkName(store, name, exceptId) {
    var clean = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
    if (!clean) return { error: 'Enter a name.' };
    if (clean.length > MAX_NAME) {
      return { error: 'That name is too long (' + MAX_NAME + ' characters max).' };
    }
    var existing = findByName(store, clean);
    if (existing && existing.id !== exceptId) {
      return { error: 'Someone is already called “' + clean + '”.' };
    }
    return { value: clean };
  }

  function checkPassword(pw) {
    var s = String(pw == null ? '' : pw);
    if (s.length < MIN_PASSWORD) {
      return { error: 'Use at least ' + MIN_PASSWORD + ' characters. ' +
        'A short phrase you can remember beats a short jumble.' };
    }
    return { value: s };
  }

  /* -------------------------------------------------------------------------
   * Account operations
   *
   * Every one of these re-reads the store and re-checks the caller's role.
   * Not because that stops anyone — nothing here can — but because the rules
   * then live in one place and the UI cannot drift away from them.
   * ---------------------------------------------------------------------- */
  function createUser(store, name, password, role) {
    var salt = randomBytes(SALT_BYTES);
    return deriveBits(password, salt, ITERATIONS).then(function (bits) {
      var user = {
        id: uid(),
        name: name,
        role: role,
        salt: toBase64(salt),
        hash: toBase64(bits),
        iterations: ITERATIONS,
        createdAt: new Date().toISOString()
      };
      store.users.push(user);
      if (!writeStore(store)) {
        throw new Error('This browser will not let the app save accounts.');
      }
      return user;
    });
  }

  var Auth = {
    MIN_PASSWORD: MIN_PASSWORD,
    ITERATIONS: ITERATIONS,
    ACCOUNTS_KEY: ACCOUNTS_KEY,
    SESSION_KEY: SESSION_KEY,

    cryptoAvailable: cryptoAvailable,

    hasAccounts: function () { return readStore().users.length > 0; },

    /** Everyone, without secrets. Ordered admins first, then by name. */
    users: function () {
      return readStore().users.map(publicUser).sort(function (a, b) {
        if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    },

    currentUser: function () { return readSession(); },

    isAdmin: function () {
      var me = readSession();
      return !!me && me.role === 'admin';
    },

    /** First run. The first account is always an administrator, and its
     *  password is chosen here — the app ships with NO default account and no
     *  built-in password, because a documented default is a real hole even in
     *  a lock this modest. */
    createFirstAdmin: function (name, password) {
      var store = readStore();
      if (store.users.length) {
        return Promise.resolve({ error: 'Accounts already exist. Sign in instead.' });
      }
      var n = checkName(store, name);
      if (n.error) return Promise.resolve(n);
      var p = checkPassword(password);
      if (p.error) return Promise.resolve(p);

      return createUser(store, n.value, p.value, 'admin').then(function (user) {
        writeSession(user);
        return { user: publicUser(user) };
      }).catch(function (e) {
        return { error: e.message || 'Could not create that account.' };
      });
    },

    signIn: function (name, password) {
      var store = readStore();
      var user = findByName(store, name);

      /* Derive even when the name is unknown, against the same cost, so a
       * wrong NAME and a wrong PASSWORD take the same time and the reply
       * cannot be used to enumerate who has an account. */
      var salt = user ? fromBase64(user.salt) : randomBytes(SALT_BYTES);
      var iterations = user ? user.iterations : ITERATIONS;

      return deriveBits(password, salt, iterations).then(function (bits) {
        if (!user) return { error: 'That name and password do not match.' };
        if (!timingSafeEqual(bits, fromBase64(user.hash))) {
          return { error: 'That name and password do not match.' };
        }
        writeSession(user);
        return { user: publicUser(user) };
      }).catch(function () {
        return { error: 'Could not check that password in this browser.' };
      });
    },

    signOut: function () { clearSession(); },

    /** Admin only. */
    addUser: function (name, password, role) {
      if (!Auth.isAdmin()) {
        return Promise.resolve({ error: 'Only an administrator can add people.' });
      }
      var store = readStore();
      var n = checkName(store, name);
      if (n.error) return Promise.resolve(n);
      var p = checkPassword(password);
      if (p.error) return Promise.resolve(p);
      var r = ROLES[role] === 1 ? role : 'user';

      return createUser(store, n.value, p.value, r).then(function (user) {
        return { user: publicUser(user) };
      }).catch(function (e) {
        return { error: e.message || 'Could not add that person.' };
      });
    },

    /** An administrator may remove anyone; anyone may remove themselves.
     *
     *  The last administrator can never be removed, by either route. Without
     *  that guard an issue could be left with accounts but no one able to
     *  manage them, and the only way out would be clearing browser storage —
     *  which also throws away the newsletter. */
    removeUser: function (id) {
      var me = readSession();
      if (!me) return { error: 'Sign in first.' };
      var store = readStore();
      var target = findById(store, id);
      if (!target) return { error: 'That person no longer has an account.' };

      var isSelf = target.id === me.id;
      if (!isSelf && me.role !== 'admin') {
        return { error: 'Only an administrator can remove other people.' };
      }
      if (target.role === 'admin' && adminCount(store) <= 1) {
        return { error: isSelf
          ? 'You are the only administrator. Make someone else an ' +
            'administrator first, or nobody will be able to manage accounts.'
          : 'That is the only administrator, so it cannot be removed.' };
      }

      store.users = store.users.filter(function (u) { return u.id !== target.id; });
      if (!writeStore(store)) {
        return { error: 'This browser will not let the app save accounts.' };
      }
      if (isSelf) clearSession();
      return { removed: publicUser(target), self: isSelf };
    },

    /** Changing your own password. Requires the current one, so someone who
     *  walks up to an unlocked screen cannot lock the real user out. */
    changePassword: function (currentPassword, newPassword) {
      var me = readSession();
      if (!me) return Promise.resolve({ error: 'Sign in first.' });
      var p = checkPassword(newPassword);
      if (p.error) return Promise.resolve(p);

      var store = readStore();
      var user = findById(store, me.id);
      if (!user) return Promise.resolve({ error: 'Your account no longer exists.' });

      return deriveBits(currentPassword, fromBase64(user.salt), user.iterations)
        .then(function (bits) {
          if (!timingSafeEqual(bits, fromBase64(user.hash))) {
            return { error: 'That is not your current password.' };
          }
          var salt = randomBytes(SALT_BYTES);
          return deriveBits(p.value, salt, ITERATIONS).then(function (next) {
            user.salt = toBase64(salt);
            user.hash = toBase64(next);
            user.iterations = ITERATIONS;
            if (!writeStore(store)) {
              return { error: 'This browser will not let the app save accounts.' };
            }
            return { changed: true };
          });
        });
    },

    /* --- boot ------------------------------------------------------------ */

    /** app.js hands the boot function over rather than booting itself, so the
     *  newsletter is never rendered — never even in the DOM — while locked. */
    start: function (boot) {
      bootApp = boot;
      if (started) return;
      started = true;

      wire();

      /* No secure context means no key derivation. Rather than fall back to a
       * weaker hash (dishonest) or refuse to run (a lock this modest must
       * never cost anyone their newsletter), stand the gate down and say so.
       *
       * It must SAY so somewhere a person will actually see. The first version
       * of this un-hid a notice that lived inside the gate and then hid the
       * gate, so the explanation was never visible and the app simply opened
       * with no sign-in at all — indistinguishable from the feature being
       * broken. Now the gate stays up carrying only the explanation. */
      if (!cryptoAvailable()) {
        showDegradedGate();
        return;
      }

      var me = readSession();
      if (me) { unlock(); return; }
      showGate();
    },

    /* --- diagnosis -------------------------------------------------------
     * For "why am I not being asked to create an administrator?". Every way
     * that can happen is here, in one call, so it can be answered from the
     * console on a server instead of guessed at.
     * ------------------------------------------------------------------ */
    diagnose: function () {
      var storage;
      try {
        localStorage.setItem('__keys_probe', '1');
        localStorage.removeItem('__keys_probe');
        storage = 'ok';
      } catch (e) {
        storage = 'BLOCKED (' + e.name + ')';
      }

      var why = null;
      if (!cryptoAvailable()) {
        why = 'Accounts are OFF: crypto.subtle is unavailable, because this ' +
          'page is not in a secure context. Serve it over https://, open the ' +
          'file directly, or reach it on localhost.';
      } else if (storage !== 'ok') {
        why = 'Accounts cannot be saved: this browser is blocking storage.';
      } else if (readStore().users.length === 0) {
        why = 'No accounts yet — the gate should be showing first-time setup.';
      } else if (readSession()) {
        why = 'Already signed in, so there is nothing to prompt for. ' +
          'Sign out from Settings to see the gate.';
      } else {
        why = 'Accounts exist and nobody is signed in — the gate should be ' +
          'showing the sign-in form.';
      }

      return {
        summary: why,
        authLoaded: true,
        secureContext: !!global.isSecureContext,
        protocol: global.location.protocol,
        host: global.location.hostname,
        cryptoSubtle: !!(global.crypto && global.crypto.subtle),
        localStorage: storage,
        accounts: readStore().users.length,
        signedIn: !!readSession(),
        idleTimeoutMinutes: IDLE_MS / 60000
      };
    },

    /** Wipe every account so the next load runs first-time setup again.
     *
     *  The documented recovery path for "nobody can get in any more" — a
     *  forgotten administrator password, or a half-configured deployment.
     *  It is not a hole: anyone who can call this can already clear the same
     *  key from the browser's storage panel. It does NOT touch the newsletter. */
    resetAllAccounts: function () {
      try { localStorage.removeItem(ACCOUNTS_KEY); } catch (e) {}
      clearSession();
      try { sessionStorage.removeItem(REASON_KEY); } catch (e) {}
      return 'All accounts cleared. Reload the page to create the ' +
             'administrator account again. The newsletter is untouched.';
    },

    /* Exposed so tests can run the real idle check after winding the clock
     * back, rather than waiting five minutes or shortening the timeout. */
    checkIdle: checkIdle,
    idleFor: function () { return idleFor(); },
    IDLE_MS: IDLE_MS
  };

  /* -------------------------------------------------------------------------
   * The gate
   * ---------------------------------------------------------------------- */
  var HONEST_NOTICE =
    'This keeps the newsletter out of the way on a shared computer. ' +
    'It is not a security barrier — anyone who can open these files can ' +
    'still read the newsletter, so please don’t keep anything ' +
    'confidential in it.';

  function gateEl() { return $('#auth-gate'); }

  /** Put the gate up carrying only the "accounts are off here" explanation
   *  and a way through, so a misconfigured deployment is loud rather than
   *  silently featureless. */
  function showDegradedGate() {
    var gate = gateEl();
    if (!gate) { unlock(); return; }

    $('#auth-degraded').hidden = false;
    $('#auth-form').hidden = true;
    $('#auth-title').textContent = 'Accounts are switched off';
    $('#auth-lead').textContent = '';
    setGateError('');

    document.body.classList.add('is-locked');
    gate.hidden = false;
    var app = $('#app');
    if (app) app.setAttribute('inert', '');

    // Also leave the diagnosis in the console: on a server the person fixing
    // this is usually looking at devtools, not at the screen.
    try {
      global.console.warn('[St. Peter’s Keys] ' + Auth.diagnose().summary);
    } catch (e) {}
  }

  function showGate() {
    var gate = gateEl();
    if (!gate) { unlock(); return; }

    var firstRun = !Auth.hasAccounts();
    $('#auth-title').textContent = firstRun
      ? 'Set up St. Peter’s Keys'
      : 'Sign in to St. Peter’s Keys';
    $('#auth-lead').textContent = firstRun
      ? 'Nobody has an account yet. Create the administrator account — ' +
        'it is the one that can add and remove everyone else.'
      : 'Enter your name and password to open the newsletter.';
    $('#auth-submit').textContent = firstRun ? 'Create account' : 'Sign in';
    $('#auth-confirm-field').hidden = !firstRun;
    $('#auth-confirm').required = firstRun;
    $('#auth-hint').textContent = firstRun
      ? 'At least ' + MIN_PASSWORD + ' characters. A phrase you will remember ' +
        'is better than something short and clever.'
      : '';

    /* Say why they are back here, once. Being dropped to a sign-in screen with
     * no explanation reads as a fault rather than a timeout. */
    var reason = takeSignOutReason();
    setGateNote(reason === 'idle'
      ? 'You were signed out after ' + Math.round(IDLE_MS / 60000) +
        ' minutes without activity. Your newsletter was saved.'
      : '');
    setGateError('');

    stopIdleWatch();
    document.body.classList.add('is-locked');
    gate.hidden = false;
    var app = $('#app');
    if (app) app.setAttribute('inert', '');
    $('#auth-name').value = '';
    $('#auth-password').value = '';
    $('#auth-confirm').value = '';
    setTimeout(function () { $('#auth-name').focus(); }, 30);
  }

  function setGateError(msg) {
    var box = $('#auth-error');
    if (!box) return;
    box.textContent = msg || '';
    box.hidden = !msg;
  }

  function setGateNote(msg) {
    var box = $('#auth-note');
    if (!box) return;
    box.textContent = msg || '';
    box.hidden = !msg;
  }

  function setGateBusy(on) {
    var btn = $('#auth-submit');
    if (btn) {
      btn.disabled = !!on;
      btn.setAttribute('aria-busy', on ? 'true' : 'false');
    }
  }

  function unlock() {
    var gate = gateEl();
    if (gate) gate.hidden = true;
    document.body.classList.remove('is-locked');
    var app = $('#app');
    if (app) app.removeAttribute('inert');
    if (bootApp) { var b = bootApp; bootApp = null; b(); }
    syncIdentity();
    // Only run the idle clock for a real session. In degraded mode there is
    // nobody signed in and nothing to sign out of.
    if (readSession()) startIdleWatch();
  }

  function onGateSubmit(e) {
    e.preventDefault();
    var firstRun = !Auth.hasAccounts();
    var name = $('#auth-name').value;
    var password = $('#auth-password').value;

    if (firstRun && password !== $('#auth-confirm').value) {
      setGateError('Those two passwords are not the same.');
      $('#auth-confirm').focus();
      return;
    }

    setGateError('');
    setGateBusy(true);
    var work = firstRun ? Auth.createFirstAdmin(name, password)
                        : Auth.signIn(name, password);

    work.then(function (res) {
      setGateBusy(false);
      if (res && res.error) {
        setGateError(res.error);
        $('#auth-password').value = '';
        $('#auth-password').focus();
        return;
      }
      unlock();
      startIdleWatch();
      if (Keys.App && Keys.App.toast) {
        Keys.App.toast(firstRun
          ? 'Administrator account created. Welcome, ' + res.user.name + '.'
          : 'Signed in as ' + res.user.name + '.', 'ok');
      }
    }).catch(function () {
      setGateBusy(false);
      setGateError('Something went wrong. Please try again.');
    });
  }

  /* -------------------------------------------------------------------------
   * Settings
   * ---------------------------------------------------------------------- */
  function settingsEl() { return $('#settings-dialog'); }

  function openSettings() {
    var dlg = settingsEl();
    if (!dlg) return;
    renderSettings();
    if (typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function closeSettings() {
    var dlg = settingsEl();
    if (!dlg) return;
    if (typeof dlg.close === 'function' && dlg.open) dlg.close();
    else dlg.removeAttribute('open');
  }

  function setSettingsMessage(msg, kind) {
    var box = $('#settings-message');
    if (!box) return;
    box.textContent = msg || '';
    box.hidden = !msg;
    box.className = 'set-msg' + (kind ? ' set-msg--' + kind : '');
  }

  function renderSettings() {
    var me = Auth.currentUser();
    var admin = Auth.isAdmin();

    $('#settings-who').textContent = me ? me.name : 'Not signed in';
    $('#settings-role').textContent = me
      ? (me.role === 'admin' ? 'Administrator' : 'User') : '';

    // Only administrators get the people section at all.
    $('#settings-people').hidden = !admin;

    var list = $('#settings-user-list');
    if (list && !admin) {
      /* Not merely hidden — not built. Hiding the section would still leave
       * the whole roster, and a remove button per person, sitting in the DOM
       * of someone who may not use them. Nothing here is a security boundary,
       * but there is no reason to render a control that only ever refuses. */
      list.innerHTML = '';
    } else if (list) {
      var users = Auth.users();
      var onlyAdmin = users.filter(function (u) {
        return u.role === 'admin';
      }).length <= 1;

      list.innerHTML = users.map(function (u) {
        var isMe = me && u.id === me.id;
        var locked = u.role === 'admin' && onlyAdmin;
        return '<li class="set-user">' +
          '<span class="set-user-name">' + escText(u.name) +
            (isMe ? ' <span class="set-user-you">(you)</span>' : '') + '</span>' +
          '<span class="set-user-role">' +
            (u.role === 'admin' ? 'Administrator' : 'User') + '</span>' +
          (locked
            ? '<span class="set-user-note" title="The last administrator ' +
              'cannot be removed, or nobody could manage accounts.">' +
              'last admin</span>'
            : '<button type="button" class="ed-btn ed-btn--icon ed-btn--danger"' +
              ' data-auth="remove" data-id="' + escAttr(u.id) + '"' +
              ' title="Remove ' + escAttr(u.name) + '"' +
              ' aria-label="Remove ' + escAttr(u.name) + '">&#10005;</button>') +
        '</li>';
      }).join('');
    }

    // "Delete my account" is offered to everyone, but not when it would
    // strip the last administrator.
    var delBtn = $('#settings-delete-self');
    if (delBtn && me) {
      var users2 = Auth.users();
      var lastAdmin = me.role === 'admin' && users2.filter(function (u) {
        return u.role === 'admin';
      }).length <= 1;
      delBtn.disabled = lastAdmin;
      delBtn.title = lastAdmin
        ? 'You are the only administrator. Make someone else an administrator ' +
          'first.'
        : 'Delete your own account';
    }

    setSettingsMessage('');
  }

  function handleSettingsClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-auth]') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-auth');

    if (act === 'close') { closeSettings(); return; }

    if (act === 'signout') {
      Auth.signOut();
      stopIdleWatch();
      closeSettings();
      // Reload rather than tear the app down by hand: it is the only way to
      // be sure no rendered newsletter is left behind the gate. reloadCleanly
      // persists first so `beforeunload` cannot put up a prompt and block it.
      reloadCleanly();
      return;
    }

    if (act === 'remove') {
      var id = btn.getAttribute('data-id');
      var user = Auth.users().filter(function (u) { return u.id === id; })[0];
      if (!user) return;
      if (!global.confirm('Remove ' + user.name + '’s account?')) return;
      var res = Auth.removeUser(id);
      if (res.error) { setSettingsMessage(res.error, 'err'); return; }
      renderSettings();
      setSettingsMessage('Removed ' + res.removed.name + '.', 'ok');
      return;
    }

    if (act === 'delete-self') {
      var me = Auth.currentUser();
      if (!me) return;
      if (!global.confirm('Delete your own account, ' + me.name + '?\n\n' +
          'The newsletter itself is not deleted.')) return;
      var out = Auth.removeUser(me.id);
      if (out.error) { setSettingsMessage(out.error, 'err'); return; }
      stopIdleWatch();
      closeSettings();
      reloadCleanly();
      return;
    }
  }

  function onAddUser(e) {
    e.preventDefault();
    var name = $('#settings-new-name').value;
    var pw = $('#settings-new-password').value;
    var role = $('#settings-new-role').value;

    Auth.addUser(name, pw, role).then(function (res) {
      if (res.error) { setSettingsMessage(res.error, 'err'); return; }
      $('#settings-new-name').value = '';
      $('#settings-new-password').value = '';
      $('#settings-new-role').value = 'user';
      renderSettings();
      setSettingsMessage('Added ' + res.user.name + '.', 'ok');
    });
  }

  function onChangePassword(e) {
    e.preventDefault();
    var cur = $('#settings-current-password').value;
    var next = $('#settings-next-password').value;
    var again = $('#settings-next-password-2').value;

    if (next !== again) {
      setSettingsMessage('Those two passwords are not the same.', 'err');
      return;
    }
    Auth.changePassword(cur, next).then(function (res) {
      if (res.error) { setSettingsMessage(res.error, 'err'); return; }
      $('#settings-current-password').value = '';
      $('#settings-next-password').value = '';
      $('#settings-next-password-2').value = '';
      setSettingsMessage('Password changed.', 'ok');
    });
  }

  /** Show who is signed in, in the toolbar button's label. */
  function syncIdentity() {
    var btn = $('[data-act="settings"]');
    if (!btn) return;
    var me = Auth.currentUser();
    var label = me
      ? 'Settings — signed in as ' + me.name +
        (me.role === 'admin' ? ' (administrator)' : '')
      : 'Settings';
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
  }

  /* -------------------------------------------------------------------------
   * Wiring
   * ---------------------------------------------------------------------- */
  function wire() {
    var gateForm = $('#auth-form');
    if (gateForm) gateForm.addEventListener('submit', onGateSubmit);

    var gate = gateEl();
    if (gate) {
      gate.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-auth]') : null;
        if (btn && btn.getAttribute('data-auth') === 'continue') unlock();
      });
    }

    $$('.auth-notice, .set-notice').forEach(function (el) {
      if (!el.textContent.trim()) el.textContent = HONEST_NOTICE;
    });

    var dlg = settingsEl();
    if (dlg) {
      dlg.addEventListener('click', function (e) {
        // A click that lands on the <dialog> itself hit the backdrop.
        if (e.target === dlg) { closeSettings(); return; }
        handleSettingsClick(e);
      });
    }

    var addForm = $('#settings-add-form');
    if (addForm) addForm.addEventListener('submit', onAddUser);

    var pwForm = $('#settings-password-form');
    if (pwForm) pwForm.addEventListener('submit', onChangePassword);

    document.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-act="settings"]') : null;
      if (btn) openSettings();
    });

    syncIdentity();
  }

  /* Exposed for the settings UI and tools/verify.js. */
  Auth.openSettings = openSettings;
  Auth.closeSettings = closeSettings;
  Auth.HONEST_NOTICE = HONEST_NOTICE;

  Keys.Auth = Auth;
})(window);
