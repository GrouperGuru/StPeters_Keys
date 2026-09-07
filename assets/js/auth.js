/* =============================================================================
 * auth.js — Identity, the re-entry gate, and the Settings panel.
 *
 * Exposes window.Keys.Auth. Loaded BEFORE app.js so app.js can hand it the
 * boot decision.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * Accounts no longer live in this browser. They live on the Node server in
 * server/, behind the contract in docs/AUTH-API.md. Passwords are hashed there
 * (PBKDF2-HMAC-SHA256, 310,000 iterations, per-user salt), sessions are held
 * there, and both clocks — 5 minutes idle, 12 hours absolute — are enforced
 * there. This file never sees a hash, never stores an account, and is never
 * trusted about the time.
 *
 * That splits the app into two modes, decided by location.protocol:
 *
 *   served  (http: / https:)
 *     A REAL access-control boundary. The server will not hand out index.html
 *     or the application JavaScript without a valid `keys_sid` cookie. By the
 *     time this file runs, the visitor has already been let in — so there is
 *     no sign-in form on first paint. The gate exists for one job: when the
 *     session lapses mid-edit, put itself back up and sign the same person
 *     back in IN PLACE, without a reload, because the editor is holding an
 *     issue that nobody wants to retype.
 *
 *     What it does NOT do is encrypt anything. Over plain http:// the password
 *     and the newsletter cross the network in the clear. The notice below says
 *     exactly that, and Settings says it again, louder, when the host is not
 *     localhost.
 *
 *   offline (file:)
 *     No server, therefore no accounts, therefore NO GATE AT ALL. A local
 *     sign-in prompt here would protect nothing from someone who already has
 *     the files, and pretending otherwise is the failure mode this project
 *     keeps refusing. start(boot) calls boot() immediately. Settings still
 *     opens — it has other content — but says plainly where accounts live.
 *
 * Gone, deliberately, and not coming back:
 *   - crypto.subtle / PBKDF2 in the browser. Hashing is the server's job now.
 *   - the secure-context "degraded mode". It existed only because
 *     crypto.subtle is unavailable over plain http://; nothing here needs
 *     crypto.subtle any more, so the failure it worked around cannot happen.
 *   - resetAllAccounts(). A browser cannot wipe the server's accounts. See
 *     `node server/reset-accounts.js`.
 *
 * ASYNC WARNING: everything that touches an account now crosses a network.
 * users(), signOut(), removeUser(), hasAccounts(), diagnose() and checkIdle()
 * used to return synchronously and now return Promises. Each one says so at
 * its definition.
 * ========================================================================== */
(function (global) {
  'use strict';

  var Keys = global.Keys = global.Keys || {};

  /* -------------------------------------------------------------------------
   * Mode
   *
   * http/https means a server answered, so there is one to authenticate
   * against. Everything else — file:, and oddities like blob: — means there
   * is not. Defaulting the unknown case to "offline" is the safe direction:
   * the worst outcome is that the app opens without a gate it could not have
   * enforced anyway, rather than hanging on requests nothing will answer.
   * ---------------------------------------------------------------------- */
  var MODE = (global.location.protocol === 'http:' ||
              global.location.protocol === 'https:') ? 'served' : 'offline';

  /* Server-enforced, and only ever a DEFAULT here: /api/auth/state reports the
   * real value and we adopt it, so the copy in the UI cannot drift away from
   * the number the server actually uses. */
  var IDLE_MS = 5 * 60 * 1000;

  var IDLE_WARN_MS = 30 * 1000;      // toast this long before we expect a drop

  /* Heartbeat economics. The old build ticked every 5 seconds against
   * sessionStorage, which was free; every tick now would be an HTTP request.
   *
   *   - the slow timer runs twice a minute and usually decides to do NOTHING,
   *   - a touch is sent at most once a minute, and only when there has been
   *     real user activity since the last one,
   *   - "am I still signed in?" is asked with GET /api/auth/state, never with
   *     touch, because touch would refresh the very session it is asking
   *     about and quietly defeat the idle timeout.
   */
  var HEARTBEAT_MS = 30 * 1000;
  var TOUCH_MIN_MS = 60 * 1000;
  var ACTIVITY_THROTTLE_MS = 1000;   // how often a mousemove may move the clock
  var STATE_CHECK_MIN_MS = 5 * 1000; // floor between two state probes

  var MIN_PASSWORD = 8;              // must match the server; see AUTH-API §5
  var MAX_NAME = 40;

  var bootApp = null;                // handed over by app.js
  var started = false;

  var me = null;                     // last known signed-in user, or null

  /* Survives `me` being cleared. When the session lapses we forget WHO was
   * signed in — correctly, because we no longer know — but the re-auth gate
   * still wants to put their name in the box so they only have to type a
   * password. Keeping the name is not keeping a session: it authorises
   * nothing, and the server re-checks both fields regardless. */
  var lastKnownName = '';
  var serverState = null;            // last successful GET /api/auth/state
  var stateReachable = null;         // null = not asked yet
  var hasAccountsCache = null;

  var heartbeatTimer = null;
  var lastActivityAt = Date.now();
  var lastTouchAt = 0;
  var lastStateCheckAt = 0;
  var idleWarned = false;
  var activityBound = false;
  var statePending = null;           // de-duplicate concurrent state probes

  var gateKind = null;               // null | 'boot' | 'reauth'
  var gateReturnFocus = null;
  var retryTimer = null;

  /* -------------------------------------------------------------------------
   * Copy that has to be true
   *
   * The old notice said "It is not a security barrier." In served mode that is
   * now false — it understates the protection, which is its own kind of lie —
   * and in offline mode there is no gate for it to describe. Two honest
   * replacements, each naming what it does and what it does not.
   * ---------------------------------------------------------------------- */
  function idleMinutes() { return Math.max(1, Math.round(IDLE_MS / 60000)); }

  function servedNotice() {
    return 'This is a real lock: the server will not send the newsletter — ' +
      'or the app that edits it — to anyone without a valid session, and it ' +
      'closes the session after ' + idleMinutes() + ' minutes without ' +
      'activity. What it does not do is encrypt anything. If you reached ' +
      'this page over a plain http:// address, your name, your password and ' +
      'the newsletter itself travel across the network in the clear, where ' +
      'anyone else on that network can read them — so use https://, or a ' +
      'network you trust.';
  }

  var OFFLINE_NOTICE =
    'This copy was opened straight from disk, so there is nothing to sign in ' +
    'to: accounts live on the server, and this file doesn’t have one. ' +
    'Anyone who can open these files can read the newsletter, so please ' +
    'don’t keep anything confidential in it.';

  var OFFLINE_SETTINGS_NOTE =
    'This copy was opened straight from disk (file://). There is no server ' +
    'here, so there are no accounts, nobody to sign in as, and nobody to ' +
    'add or remove. People, passwords and the sign-in gate all live on the ' +
    'server — open the app over http:// or https:// to manage them. ' +
    'Everything else in this dialog works as usual, and anyone who can open ' +
    'these files can read the newsletter.';

  var OFFLINE_API_ERROR =
    'There is no server to ask: this copy was opened from disk. Accounts ' +
    'live on the server — open the app over http:// or https:// instead.';

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

  /** localhost is the one plain-http case that is not on the wire at all. */
  function isLocalHost() {
    var h = global.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  }

  /** Server's word first (it knows whether IT is terminating TLS); the URL
   *  scheme only as a fallback for when we could not reach it. */
  function isSecureConnection() {
    if (serverState && typeof serverState.secure === 'boolean') {
      return serverState.secure;
    }
    return global.location.protocol === 'https:';
  }

  function shouldWarnPlainHttp() {
    return MODE === 'served' && !isSecureConnection() && !isLocalHost();
  }

  function toast(msg, kind) {
    try {
      if (Keys.App && Keys.App.toast) Keys.App.toast(msg, kind);
    } catch (e) {}
  }

  /* -------------------------------------------------------------------------
   * The wire
   *
   * Every non-GET carries Content-Type: application/json and a JSON body even
   * when it has nothing to say — the server's CSRF check REJECTS anything
   * else, because a cross-origin <form> cannot set that header without a
   * preflight it will not get. credentials:'same-origin' goes on every request
   * including GETs, or the session cookie is left at home.
   *
   * Resolves — never rejects — with { ok, status, data }. A dead server is a
   * normal outcome for this app, not an exception: the caller has to show the
   * person something either way, so one shape for both keeps the call sites
   * from growing a second error path they will forget to test.
   * ---------------------------------------------------------------------- */
  function request(method, path, body) {
    if (MODE !== 'served') {
      return Promise.resolve({
        ok: false, status: 0, offline: true,
        data: { error: OFFLINE_API_ERROR, code: 'OFFLINE' }
      });
    }

    var opts = {
      method: method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {}
    };
    if (method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body || {});
    }

    return fetch(path, opts).then(function (res) {
      if (res.status === 204) return { ok: true, status: 204, data: {} };
      return res.json().then(function (data) {
        return {
          ok: res.ok, status: res.status,
          data: (data && typeof data === 'object') ? data : {}
        };
      }, function () {
        /* A reply we cannot parse is usually the login page's HTML arriving
         * where JSON was expected — i.e. a proxy or a stale cache in the way.
         * Say which status it was; that is the part a person can act on. */
        return {
          ok: false, status: res.status,
          data: {
            error: 'The server sent a reply this app could not read ' +
                   '(HTTP ' + res.status + ').',
            code: 'BAD_REPLY'
          }
        };
      });
    }, function () {
      return {
        ok: false, status: 0, network: true,
        data: {
          error: 'Could not reach the server. It may have stopped, or the ' +
                 'network may be down. Your work is still here and still ' +
                 'being saved locally.',
          code: 'NETWORK'
        }
      };
    });
  }

  /** Turn a failed response into the { error, code } object every public
   *  method resolves with. The server's `error` strings are written to be
   *  shown to a person, so they are shown verbatim — inventing a friendlier
   *  sentence here only means the UI and the server disagree about what
   *  happened. */
  function failure(res) {
    var d = res.data || {};
    return {
      error: d.error || 'That did not work (HTTP ' + res.status + ').',
      code: d.code || null,
      status: res.status,
      retryAfterMs: isFinite(Number(d.retryAfterMs)) ? Number(d.retryAfterMs) : 0
    };
  }

  /* -------------------------------------------------------------------------
   * Server state
   * ---------------------------------------------------------------------- */

  /** GET /api/auth/state — the one endpoint that never requires auth, so it is
   *  also the only safe way to ask "am I still signed in?" without answering
   *  "yes" by the act of asking. Concurrent calls share one request. */
  function refreshState() {
    if (statePending) return statePending;

    statePending = request('GET', '/api/auth/state').then(function (res) {
      statePending = null;
      lastStateCheckAt = Date.now();

      if (!res.ok) {
        stateReachable = false;
        return { reachable: false, error: failure(res) };
      }

      stateReachable = true;
      serverState = res.data || {};
      me = serverState.signedIn ? (serverState.user || null) : null;
      if (me && me.name) lastKnownName = me.name;
      hasAccountsCache = !!serverState.hasAccounts;

      if (isFinite(Number(serverState.idleMs)) && Number(serverState.idleMs) > 0) {
        IDLE_MS = Number(serverState.idleMs);
        Auth.IDLE_MS = IDLE_MS;      // keep the published constant honest
        refreshNotices();            // the notice quotes this number
      }
      return { reachable: true, state: serverState };
    });

    return statePending;
  }

  function signedIn() { return MODE === 'served' && !!me; }

  /* -------------------------------------------------------------------------
   * Idle handling
   *
   * The server owns the clock. This side only decides WHEN to ask, and what to
   * do with a 401 — which is the important half, because the answer must never
   * be "reload" while an unsaved issue is on screen.
   * ---------------------------------------------------------------------- */

  /** Milliseconds since this tab last saw the user do anything. SYNCHRONOUS
   *  and deliberately local: it is an estimate of the server's idle clock, not
   *  a copy of it. Another tab, or any request this one made, may have
   *  refreshed the real thing more recently. */
  function idleFor() {
    if (!signedIn()) return Infinity;
    return Date.now() - lastActivityAt;
  }

  function noteActivity() {
    var now = Date.now();
    /* Measured BEFORE the clock is moved: "how long had they been gone when
     * they came back?" is a different question from "how long have they been
     * gone now", and only the first one is answerable after the assignment. */
    var wasIdle = now - lastActivityAt > IDLE_MS;

    if (now - lastActivityAt < ACTIVITY_THROTTLE_MS) return;
    lastActivityAt = now;
    idleWarned = false;

    if (!signedIn() || gateKind) return;

    if (wasIdle) {
      /* Back after longer than the server's budget. The first click is the
       * moment to find out, not thirty seconds into typing — and it must be a
       * question (state), never a touch, or coming back would silently renew
       * the session the absence was supposed to end. */
      verifyStillSignedIn(true);
      return;
    }

    /* Activity is the ONLY thing that justifies a touch. Rate-limited to once
     * a minute so a five-minute typing session costs five requests, not five
     * hundred. */
    if (now - lastTouchAt >= TOUCH_MIN_MS) touch();
  }

  /** POST /api/auth/touch. Keeps a session that is being USED but not making
   *  requests alive, and is how we learn promptly that it has been dropped. */
  function touch() {
    if (!signedIn() || gateKind) return Promise.resolve('skipped');
    lastTouchAt = Date.now();           // set BEFORE the request, so a slow or
                                        // failing one cannot start a storm

    return request('POST', '/api/auth/touch', {}).then(function (res) {
      if (res.ok) {
        if (res.data && res.data.user) me = res.data.user;
        return 'alive';
      }
      if (res.status === 401) { onDropped(res.data && res.data.code); return 'dropped'; }
      // 5xx, or the server went away: not proof of anything about the session.
      return 'unknown';
    });
  }

  /** Ask the server, read-only, whether this session still exists. Throttled,
   *  because visibilitychange and focus can both fire within a few ms of each
   *  other and neither is worth two round trips. */
  function verifyStillSignedIn(force) {
    if (MODE !== 'served' || gateKind) return Promise.resolve('skipped');
    var now = Date.now();
    if (!force && now - lastStateCheckAt < STATE_CHECK_MIN_MS) {
      return Promise.resolve('skipped');
    }
    var wasSignedIn = !!me;

    return refreshState().then(function (out) {
      if (!out.reachable) return 'unknown';
      if (wasSignedIn && !me) { onDropped(null); return 'dropped'; }
      if (!wasSignedIn && me) { syncIdentity(); return 'alive'; }
      return me ? 'alive' : 'signed out';
    });
  }

  /* THE point of this whole file.
   *
   * The session is gone, and the editor is holding an issue that may never
   * have been on disk. Reloading — which is what the old build did on idle —
   * would bounce to /login and take the tab with it. Instead: save, cover the
   * app with the gate that is already in the page, and sign the same person
   * back in on the spot. Nothing is torn down, nothing is re-rendered, and no
   * navigation happens. */
  function onDropped(code) {
    if (gateKind) return;               // already handling it
    me = null;
    stopHeartbeat();
    raiseGate('reauth', code);
  }

  /** The slow timer. Usually decides to do nothing at all. */
  function heartbeat() {
    if (!signedIn() || gateKind) return;

    var now = Date.now();
    var idle = now - lastActivityAt;

    if (idle < IDLE_MS) {
      /* Being used. Deliver any activity the once-a-minute throttle in
       * noteActivity() swallowed — otherwise someone who types one word and
       * then reads for four minutes is dropped despite having been here. */
      if (lastActivityAt > lastTouchAt && now - lastTouchAt >= TOUCH_MIN_MS) touch();

      if (idle > IDLE_MS - IDLE_WARN_MS && !idleWarned) {
        idleWarned = true;
        var secs = Math.max(5, Math.round((IDLE_MS - idle) / 1000));
        toast('You will be signed out in about ' + secs + ' seconds. Move ' +
              'the mouse or type to stay signed in. Nothing will be lost ' +
              'either way.', 'warn');
      }
      return;
    }

    /* Past the budget locally, so the server has very probably dropped us.
     * ASK — do not touch. A touch here would renew the session we are
     * enquiring about and turn the idle timeout into a perpetual motion
     * machine. */
    verifyStillSignedIn();
  }

  function startHeartbeat() {
    if (MODE !== 'served') return;
    watchActivity();
    stopHeartbeat();
    idleWarned = false;
    lastActivityAt = Date.now();
    heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  var ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel',
                         'scroll', 'focusin', 'input'];

  function watchActivity() {
    if (activityBound) return;
    activityBound = true;

    ACTIVITY_EVENTS.forEach(function (name) {
      document.addEventListener(name, noteActivity, { passive: true, capture: true });
    });

    /* A backgrounded tab has its timers throttled to a crawl, or stopped
     * outright if the machine slept — so the heartbeat above may not have run
     * for an hour. Coming back is therefore the moment to ask, before the
     * person starts typing into an editor whose session died while they were
     * elsewhere. This is a state probe, not a touch: returning to a tab is not
     * a reason to keep a lapsed session alive. */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) verifyStillSignedIn(true);
    });
    global.addEventListener('focus', function () { verifyStillSignedIn(); });
    global.addEventListener('online', function () { verifyStillSignedIn(true); });
  }

  /* -------------------------------------------------------------------------
   * Validation
   *
   * The server is the authority on both of these and will say no in its own
   * words. These exist only so the obvious mistakes are caught without a round
   * trip; they must never be MORE permissive than the server, or the UI
   * promises something the server then refuses.
   *
   * They carry the SAME `code` the server would have sent. A caller branching
   * on res.code must not have to care whether the rejection travelled to the
   * server or was caught here — that is exactly the sort of difference that
   * makes a UI behave one way on a fast network and another way on a slow one.
   * ---------------------------------------------------------------------- */
  function checkPasswordLocally(pw) {
    var s = String(pw == null ? '' : pw);
    if (s.length < MIN_PASSWORD) {
      return { code: 'WEAK_PASSWORD',
        error: 'Use at least ' + MIN_PASSWORD + ' characters. ' +
        'A short phrase you can remember beats a short jumble.' };
    }
    return { value: s };
  }

  function checkNameLocally(name) {
    var clean = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
    if (!clean) return { code: 'BAD_NAME', error: 'Enter a name.' };
    if (clean.length > MAX_NAME) {
      return { code: 'BAD_NAME',
        error: 'That name is too long (' + MAX_NAME + ' characters max).' };
    }
    return { value: clean };
  }

  /* =========================================================================
   * Public API
   *
   * PROMISES: users, signIn, signOut, addUser, removeUser, changePassword,
   * hasAccounts, diagnose and checkIdle all resolve rather than return. Only
   * currentUser(), isAdmin(), idleFor(), mode and IDLE_MS are synchronous, and
   * the first two answer from the last thing the server told us.
   * ====================================================================== */
  var Auth = {
    MIN_PASSWORD: MIN_PASSWORD,

    /** 'served' | 'offline'. Fixed at load from location.protocol. */
    mode: MODE,

    /** SYNCHRONOUS. The signed-in user as the server last described them, or
     *  null. Cached on purpose: the toolbar label and every role check would
     *  otherwise be a network call. It can be stale for at most one heartbeat,
     *  and nothing is authorised on the strength of it — the server re-checks
     *  every request regardless. */
    currentUser: function () { return me ? { name: me.name, role: me.role,
      createdAt: me.createdAt, lastSignInAt: me.lastSignInAt } : null; },

    /** SYNCHRONOUS, and a UI hint only. The server enforces admin-ness; this
     *  just decides whether to bother drawing the People section. */
    isAdmin: function () { return !!me && me.role === 'admin'; },

    /** ASYNC (was sync). Resolves { users: [...] } or { error, code }.
     *  Admin only — the server answers 403 NOT_ADMIN for everyone else, which
     *  is why the roster is not even requested unless isAdmin() says so. */
    users: function () {
      return request('GET', '/api/users').then(function (res) {
        if (!res.ok) return failure(res);
        return { users: Array.isArray(res.data.users) ? res.data.users : [] };
      });
    },

    /** ASYNC (unchanged). Resolves { user } or { error, code, retryAfterMs }.
     *  Used both by the boot gate and by in-place re-authentication. */
    signIn: function (name, password) {
      var n = checkNameLocally(name);
      if (n.error) return Promise.resolve(n);
      if (!String(password || '')) {
        return Promise.resolve({ error: 'Enter your password.' });
      }

      return request('POST', '/api/auth/signin', {
        name: n.value, password: String(password)
      }).then(function (res) {
        if (!res.ok) return failure(res);
        me = res.data.user || null;
        if (me && me.name) lastKnownName = me.name;
        hasAccountsCache = true;
        lastActivityAt = Date.now();
        lastTouchAt = Date.now();
        syncIdentity();
        return { user: Auth.currentUser() };
      });
    },

    /** ASYNC (was sync, and used to just drop a sessionStorage key).
     *  Destroys the session server-side and forgets who we were. It does NOT
     *  reload, and deliberately so: a rendered newsletter is still on screen
     *  when this resolves, so a caller that wants the screen cleared has to
     *  say so. The Sign out button in Settings does exactly that, by calling
     *  reloadCleanly() afterwards — the server then bounces the reload to
     *  /login, which is the only way to be certain nothing is left visible.
     *  Anything else calling this is responsible for the same. */
    signOut: function () {
      if (MODE !== 'served') {
        return Promise.resolve({ error: OFFLINE_API_ERROR, code: 'OFFLINE' });
      }
      return request('POST', '/api/auth/signout', {}).then(function (res) {
        /* 401 means the session was already gone — the desired end state, so
         * treat it as success rather than stranding someone on an error. */
        if (!res.ok && res.status !== 401) return failure(res);
        me = null;
        stopHeartbeat();
        return { signedOut: true };
      });
    },

    /** ASYNC (unchanged). Admin only; resolves { user } or { error, code }.
     *  409 NAME_TAKEN and 400 WEAK_PASSWORD/BAD_NAME arrive as the server's
     *  own sentences. */
    addUser: function (name, password, role) {
      var n = checkNameLocally(name);
      if (n.error) return Promise.resolve(n);
      var p = checkPasswordLocally(password);
      if (p.error) return Promise.resolve(p);

      return request('POST', '/api/users', {
        name: n.value, password: p.value,
        role: role === 'admin' ? 'admin' : 'user'
      }).then(function (res) {
        if (!res.ok) return failure(res);
        return { user: res.data.user };
      });
    },

    /** ASYNC (was sync) and now keyed by NAME, not by a local id — server
     *  accounts have no id, and DELETE /api/users/:name is the route.
     *  Resolves { removed, self } or { error, code }; 409 LAST_ADMIN is the
     *  server refusing to leave nobody able to manage accounts. */
    removeUser: function (name) {
      var n = checkNameLocally(name);
      if (n.error) return Promise.resolve(n);

      return request('DELETE', '/api/users/' + encodeURIComponent(n.value), {})
        .then(function (res) {
          if (!res.ok) return failure(res);
          if (res.data.self) { me = null; stopHeartbeat(); }
          return { removed: res.data.removed, self: !!res.data.self };
        });
    },

    /** ASYNC (unchanged). The server rotates the salt and invalidates this
     *  user's OTHER sessions, keeping this one — so there is nothing to do
     *  here afterwards except say it worked. */
    changePassword: function (currentPassword, newPassword) {
      var p = checkPasswordLocally(newPassword);
      if (p.error) return Promise.resolve(p);

      return request('POST', '/api/auth/password', {
        current: String(currentPassword == null ? '' : currentPassword),
        next: p.value
      }).then(function (res) {
        if (!res.ok) return failure(res);
        return { changed: true };
      });
    },

    /** ASYNC (was sync). Resolves true/false. Offline is always false: there
     *  is no store here to have accounts in. */
    hasAccounts: function () {
      if (MODE !== 'served') return Promise.resolve(false);
      if (typeof hasAccountsCache === 'boolean') {
        return Promise.resolve(hasAccountsCache);
      }
      return refreshState().then(function () { return !!hasAccountsCache; });
    },

    /* --- boot ------------------------------------------------------------ */

    /** app.js hands the boot function over rather than booting itself. In
     *  served mode that still matters: if the session died between the server
     *  sending this page and the script running, the newsletter is never
     *  built into the DOM behind the gate. */
    start: function (boot) {
      bootApp = boot;
      if (started) return;
      started = true;

      wire();

      if (MODE !== 'served') {
        /* No server, no accounts, no gate, no delay. */
        hideGateCompletely();
        bootNow();
        return;
      }

      refreshState().then(function (out) {
        if (!out.reachable) {
          /* The page itself was served, so the session was valid moments ago;
           * one failed request is not a reason to hold the newsletter hostage.
           * Boot, and let the heartbeat find out when the server returns. */
          try {
            global.console.warn('[St. Peter’s Keys] Could not reach ' +
              '/api/auth/state. Booting anyway — the server let this page ' +
              'through, so the session was valid. Account management will ' +
              'not work until the server answers again.');
          } catch (e) {}
          bootNow();
          startHeartbeat();
          return;
        }

        if (!me) {
          /* Rare, and worth handling: a back/forward-cache restore, or a page
           * that sat in a tab while the server restarted. The app has NOT
           * booted, so the safe move is the gate rather than the editor. */
          raiseGate('boot', hasAccountsCache ? null : 'NO_ACCOUNTS');
          return;
        }

        bootNow();
        startHeartbeat();
      });
    },

    /* --- diagnosis -------------------------------------------------------
     * ASYNC (was sync). For "why am I / am I not seeing a gate?", answered
     * from the console with the SERVER's view rather than a guess.
     * ------------------------------------------------------------------ */
    diagnose: function () {
      var base = {
        authLoaded: true,
        mode: MODE,
        protocol: global.location.protocol,
        host: global.location.host,
        secureConnection: isSecureConnection(),
        secureContext: !!global.isSecureContext,
        idleTimeoutMinutes: IDLE_MS / 60000,
        idleForMs: idleFor(),
        gateShowing: !!gateKind,
        gateKind: gateKind
      };

      if (MODE !== 'served') {
        base.server = null;
        base.signedIn = false;
        base.summary =
          'No gate, on purpose: this copy was opened from disk (file://), so ' +
          'there is no server to authenticate against and a local prompt ' +
          'would protect nothing from anyone holding these files. Accounts ' +
          'live on the server — open the app over http:// or https:// to ' +
          'sign in.';
        return Promise.resolve(base);
      }

      return refreshState().then(function (out) {
        base.signedIn = !!me;
        base.user = Auth.currentUser();
        base.server = out.reachable ? serverState : null;
        base.serverReachable = !!out.reachable;
        base.idleTimeoutMinutes = IDLE_MS / 60000;
        base.secureConnection = isSecureConnection();

        if (!out.reachable) {
          base.summary =
            'The server is not answering (' + (out.error && out.error.error) +
            '). The app is running on what was already loaded; sign-in, ' +
            'account management and the idle heartbeat will not work until ' +
            'it comes back.';
        } else if (!serverState.hasAccounts) {
          base.summary =
            'The server has no accounts yet. Open /setup with the one-time ' +
            'token printed in the server console (also in ' +
            'KEYS_DATA/setup-token.txt) to create the administrator.';
        } else if (me) {
          base.summary =
            'Signed in as ' + me.name +
            (me.role === 'admin' ? ' (administrator)' : '') + '. No gate is ' +
            'showing because the server accepted the session cookie and ' +
            'would not have sent this page otherwise. The gate will come ' +
            'back in place, without losing the issue, after ' +
            idleMinutes() + ' minutes without activity.';
        } else {
          base.summary =
            'The server does not recognise this session, so the gate should ' +
            'be up asking for a name and password. Nothing has been lost: ' +
            'signing in dismisses it without reloading.';
        }
        return base;
      });
    },

    /** ASYNC (was sync). Asks the server — every time, no throttle — whether
     *  this session still exists, raises the re-auth gate if it does not, and
     *  resolves with what it found: 'active' | 'warning' | 'expired' |
     *  'no session' | 'unknown' | 'offline'.
     *
     *  It ALWAYS makes the request rather than short-circuiting on the local
     *  clock, because that is the only thing that makes it useful as a test
     *  hook: a check that answers 'active' from a variable has verified
     *  nothing. Callers pay one round trip; the automatic paths use the
     *  throttled internals instead. */
    checkIdle: function () {
      if (MODE !== 'served') return Promise.resolve('offline');
      if (!me) return Promise.resolve('no session');

      return verifyStillSignedIn(true).then(function (verdict) {
        if (verdict === 'dropped' || !me) return 'expired';
        if (verdict === 'unknown') return 'unknown';
        return idleFor() > IDLE_MS - IDLE_WARN_MS ? 'warning' : 'active';
      });
    },

    /** SYNCHRONOUS. Milliseconds since this tab saw activity — an estimate of
     *  the server's idle clock, not a copy of it. */
    idleFor: idleFor,

    /** The server's idle budget. Starts at the documented default and is
     *  replaced by the real value from /api/auth/state. */
    IDLE_MS: IDLE_MS,

    /** REMOVED. Kept as a loud failure rather than deleted outright, because
     *  it was the documented recovery path and someone will type it into a
     *  console at exactly the wrong moment. A browser cannot wipe the
     *  server's accounts; pretending to would be the sort of comfortable lie
     *  this app is built to avoid. */
    resetAllAccounts: function () {
      throw new Error(
        'resetAllAccounts() is gone: accounts live on the server now and a ' +
        'browser cannot clear them. Run `node server/reset-accounts.js` on ' +
        'the machine running the server. It issues a fresh setup token and ' +
        'never touches the newsletter.');
    },

    /** REMOVED. First-run setup is a server page now (/setup) guarded by a
     *  one-time token, so that the administrator account cannot be claimed by
     *  whoever reaches the box first. */
    createFirstAdmin: function () {
      throw new Error(
        'createFirstAdmin() is gone: the first administrator is created at ' +
        '/setup with the one-time token the server prints on startup.');
    }
  };

  /* =========================================================================
   * The gate
   *
   * One overlay, two jobs:
   *
   *   'boot'   — the app has not started. Signing in boots it.
   *   'reauth' — the app IS running and holding an unsaved issue. Signing in
   *              dismisses the overlay and changes nothing else. No reload, no
   *              navigation, no re-render.
   * ====================================================================== */
  function gateEl() { return $('#auth-gate'); }

  function hideGateCompletely() {
    var gate = gateEl();
    if (gate) gate.hidden = true;
    document.body.classList.remove('is-locked', 'is-relocked');
    var app = $('#app');
    if (app) app.removeAttribute('inert');
  }

  /* The server says WHY it stopped recognising us, and there are three quite
   * different answers. Saying "you were idle for five minutes" after a server
   * restart is a small lie that costs a support conversation, because the
   * person knows perfectly well they were typing. The reassurance at the end
   * is the same in every case, and is the part that actually matters. */
  var SAFE = ' Your issue is still open behind this panel and has been ' +
             'saved — signing in puts you straight back where you were. ' +
             'Nothing is lost.';

  function reauthReason(code) {
    if (code === 'EXPIRED') {
      return 'This session reached its 12-hour limit, which applies however ' +
        'busy you have been.' + SAFE;
    }
    if (code === 'NO_SESSION') {
      return 'The server no longer has this session — it was most likely ' +
        'restarted, which signs everyone out.' + SAFE;
    }
    if (code === 'IDLE') {
      return 'The server closed this session after ' + idleMinutes() +
        ' minutes without activity.' + SAFE;
    }
    /* No code: we found out by asking /api/auth/state, which reports only
     * that we are not signed in. Do not guess at a reason we were not told. */
    return 'The server no longer recognises this session.' + SAFE;
  }

  function raiseGate(kind, code) {
    var gate = gateEl();
    if (!gate) {
      /* No markup to put up. A missing overlay must not mean a lost issue:
       * boot if we have not, and otherwise leave the app alone. */
      if (kind === 'boot') bootNow();
      return;
    }

    gateKind = kind;
    stopHeartbeat();

    if (kind === 'reauth') {
      /* Save BEFORE anything else. Everything below only moves pixels, but if
       * one of those steps threw, the issue would be behind a gate and not on
       * disk. Note that State.dirty is deliberately left alone: no navigation
       * is happening, so the beforeunload guard should keep protecting. */
      try { if (Keys.State && Keys.State.autosave) Keys.State.autosave(); } catch (e) {}

      /* A <dialog> opened with showModal() lives in the browser's TOP LAYER,
       * which is above every z-index there is — so an open Settings dialog
       * would sit on top of the gate, still interactive, while `inert` on
       * #app did nothing about it (it is outside #app). Close it. */
      try { closeSettings(); } catch (e) {}
    }

    /* Capture focus BEFORE setting inert: the moment #app goes inert the
     * browser blurs whatever was focused inside it, and activeElement becomes
     * <body>. */
    gateReturnFocus = (kind === 'reauth' && document.activeElement &&
                       document.activeElement !== document.body)
      ? document.activeElement : null;

    var firstRun = code === 'NO_ACCOUNTS';
    $('#auth-title').textContent = firstRun
      ? 'No accounts yet'
      : (kind === 'reauth' ? 'Sign in again' : 'Sign in to St. Peter’s Keys');

    $('#auth-lead').textContent = firstRun
      ? 'Nobody has an account on this server yet, so there is nothing to ' +
        'sign in to.'
      : 'Enter your name and password to carry on.';

    setGateNote(firstRun
      ? 'Open /setup and use the one-time token the server printed when it ' +
        'started (it is also in the server’s data folder, in ' +
        'setup-token.txt). That token is what stops the administrator ' +
        'account being claimed by whoever reaches this machine first.'
      : (kind === 'reauth' ? reauthReason(code) : ''));

    setGateError('');
    setGateBusy(false);
    clearRetryCountdown();

    var form = $('#auth-form');
    if (form) form.hidden = firstRun;      // nothing to submit before /setup

    /* is-locked blanks #app outright (display:none) and is right for 'boot',
     * where there is nothing in it yet. For 'reauth' the app must STAY laid
     * out — display:none would drop scroll positions, collapse the editor and
     * generally make signing back in feel like a reload, which is the one
     * thing this path exists to avoid. The gate's own background is opaque,
     * so the newsletter is covered either way. */
    document.body.classList.add(kind === 'reauth' ? 'is-relocked' : 'is-locked');
    gate.hidden = false;

    var app = $('#app');
    if (app) app.setAttribute('inert', '');

    var nameField = $('#auth-name');
    var pwField = $('#auth-password');
    /* lastKnownName, NOT me.name: by the time we get here onDropped() has
     * already set `me` to null, because we genuinely no longer know that this
     * session is valid. Reading me.name here left the box empty and the
     * person staring at "Enter a name." after typing only a password. */
    if (nameField) nameField.value = (kind === 'reauth') ? lastKnownName : '';
    if (pwField) pwField.value = '';

    if (!firstRun) {
      /* On re-auth the name is already right, so land on the password — the
       * person is trying to get back to a sentence they were halfway through
       * and should not have to tab past their own name. */
      setTimeout(function () {
        var target = (kind === 'reauth' && nameField && nameField.value)
          ? pwField : nameField;
        if (target) target.focus();
      }, 30);
    }
  }

  function releaseGate() {
    var kind = gateKind;
    gateKind = null;
    clearRetryCountdown();

    var gate = gateEl();
    if (gate) gate.hidden = true;
    document.body.classList.remove('is-locked', 'is-relocked');

    var app = $('#app');
    if (app) app.removeAttribute('inert');

    var pwField = $('#auth-password');
    if (pwField) pwField.value = '';

    /* Put the cursor back where it was. The element must still be in the
     * document — a re-render while the gate was up would have replaced it,
     * in which case focusing it does nothing useful and silently fails. */
    if (kind === 'reauth' && gateReturnFocus) {
      var back = gateReturnFocus;
      gateReturnFocus = null;
      setTimeout(function () {
        try {
          if (back.isConnected && typeof back.focus === 'function') back.focus();
        } catch (e) {}
      }, 0);
    }
    gateReturnFocus = null;
  }

  /** Boot the app once, and only once. */
  function bootNow() {
    hideGateCompletely();
    gateKind = null;
    if (bootApp) { var b = bootApp; bootApp = null; b(); }
    syncIdentity();
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

  /* 429 RATE_LIMITED. The server has already said what happened in its own
   * words, so this does not rewrite the message — it disables the button and
   * counts down, which is the part the person can actually use. Hammering
   * Enter during a doubling backoff only extends it. */
  function clearRetryCountdown() {
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    var btn = $('#auth-submit');
    if (btn && !gateKind) { btn.disabled = false; }
  }

  function startRetryCountdown(ms) {
    clearRetryCountdown();
    var until = Date.now() + Math.max(1000, ms);
    var btn = $('#auth-submit');

    function tick() {
      var left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        clearRetryCountdown();
        setGateNote('');
        if (btn) btn.disabled = false;
        return;
      }
      if (btn) btn.disabled = true;
      setGateNote('You can try again in ' + left +
                  (left === 1 ? ' second.' : ' seconds.'));
    }
    tick();
    retryTimer = setInterval(tick, 1000);
  }

  function onGateSubmit(e) {
    e.preventDefault();
    if (gateKind === null) return;

    var kind = gateKind;
    var name = $('#auth-name').value;
    var password = $('#auth-password').value;

    setGateError('');
    setGateBusy(true);

    Auth.signIn(name, password).then(function (res) {
      setGateBusy(false);

      if (res && res.error) {
        setGateError(res.error);
        if (res.code === 'RATE_LIMITED' && res.retryAfterMs) {
          startRetryCountdown(res.retryAfterMs);
        }
        var pw = $('#auth-password');
        if (pw) { pw.value = ''; pw.focus(); }
        return;
      }

      releaseGate();
      if (kind === 'boot') bootNow();
      startHeartbeat();
      syncIdentity();

      toast(kind === 'reauth'
        ? 'Signed back in as ' + res.user.name + '. Nothing was lost.'
        : 'Signed in as ' + res.user.name + '.', 'ok');
    }).catch(function () {
      setGateBusy(false);
      setGateError('Something went wrong signing in. Please try again.');
    });
  }

  /* =========================================================================
   * Settings
   * ====================================================================== */
  function settingsEl() { return $('#settings-dialog'); }

  function openSettings() {
    var dlg = settingsEl();
    if (!dlg) return;
    setSettingsMessage('');      // a fresh dialog, not last time's verdict
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

  function show(el, on) { if (el) el.hidden = !on; }

  /** Synchronous first paint from what we already know, then the roster is
   *  filled in when the server answers. The dialog must never sit blank
   *  waiting on a request. */
  /* NOTE: this deliberately does NOT clear #settings-message. Almost every
   * caller is "something happened, say so and redraw", and clearing here
   * silently ate the sentence they had just written — including the server's
   * own explanation of a refusal, which is the one message that matters most.
   * openSettings() clears it instead, which is the only moment a stale
   * verdict is genuinely unwanted. */
  function renderSettings() {
    var offline = MODE !== 'served';
    var admin = Auth.isAdmin();

    /* Plain http to something that is not this machine: the password and the
     * whole newsletter are readable by anyone on the network. Said here as
     * well as in the notice, because Settings is where passwords get typed. */
    var warnBox = $('#settings-insecure');
    if (warnBox) {
      if (shouldWarnPlainHttp()) {
        warnBox.textContent =
          'This connection is not encrypted. You reached ' +
          global.location.host + ' over plain http://, so your password — ' +
          'and everything in the newsletter — crosses the network in a form ' +
          'anyone else on it can read. Ask whoever runs the server for ' +
          'https://, or use this only on a network you trust.';
        warnBox.hidden = false;
      } else {
        warnBox.textContent = '';
        warnBox.hidden = true;
      }
    }

    /* "Signed in" is a heading that would be lying offline, where nobody is
     * and nobody can be. */
    var meHeading = $('#settings-me-h');
    if (meHeading) meHeading.textContent = offline ? 'Accounts' : 'Signed in';

    var whoEl = $('#settings-who');
    var roleEl = $('#settings-role');
    if (whoEl) {
      whoEl.textContent = offline ? 'Nobody — opened from disk'
                                  : (me ? me.name : 'Not signed in');
    }
    if (roleEl) {
      roleEl.textContent = offline ? ''
        : (me ? (me.role === 'admin' ? 'Administrator' : 'User') : '');
    }

    /* Offline: the dialog still opens, because it has other content, but
     * everything that would need a server is replaced by one honest note. */
    var offlineNote = $('#settings-offline');
    if (offlineNote) {
      offlineNote.textContent = offline ? OFFLINE_SETTINGS_NOTE : '';
      offlineNote.hidden = !offline;
    }
    show($('#settings-signout'), !offline);
    show($('#settings-password-section'), !offline);
    show($('#settings-account-section'), !offline);

    var people = $('#settings-people');
    var list = $('#settings-user-list');

    /* Requirement with history: a non-administrator must not merely have the
     * roster HIDDEN — they must never have it BUILT. An earlier version left
     * the whole people list, remove button per person and all, sitting in the
     * DOM of anyone who opened Settings. The server 403s GET /api/users for
     * them now, but that is a reason not to ask, not a reason to relax here:
     * the elements are not created either way. */
    if (list) list.innerHTML = '';
    show(people, !offline && admin);
    if (offline || !admin) return;

    Auth.users().then(function (res) {
      if (res.error) {
        if (afterServer(res)) return;
        /* 403 NOT_ADMIN here means our cached role is stale — someone
         * demoted this account since the page loaded. Believe the server,
         * drop the section, and re-read who we are. */
        if (res.code === 'NOT_ADMIN') {
          show(people, false);
          if (list) list.innerHTML = '';
          refreshState().then(function () { syncIdentity(); });
        }
        setSettingsMessage(res.error, 'err');
        return;
      }
      renderRoster(res.users || []);
    });
  }

  function renderRoster(users) {
    var list = $('#settings-user-list');
    if (!list) return;

    var onlyAdmin = users.filter(function (u) {
      return u && u.role === 'admin';
    }).length <= 1;

    list.innerHTML = users.map(function (u) {
      var isMe = me && String(u.name).toLowerCase() === String(me.name).toLowerCase();
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
            ' data-auth="remove" data-name="' + escAttr(u.name) + '"' +
            ' title="Remove ' + escAttr(u.name) + '"' +
            ' aria-label="Remove ' + escAttr(u.name) + '">&#10005;</button>') +
      '</li>';
    }).join('');
  }

  /** Every settings action that hits the network goes through here so the
   *  lapsed-session case is handled once: a session that dies in the middle
   *  of Settings is the same event as one that dies anywhere else, and must
   *  raise the re-auth gate rather than show a confusing error.
   *
   *  TRAP, and this one bit: the test for "the session is gone" is the CODE,
   *  never the status. `POST /api/auth/password` answers 401 BAD_CREDENTIALS
   *  when you mistype your current password — the session is perfectly fine —
   *  and an earlier version of this function read the 401 alone, threw the
   *  sign-in gate over the whole app and told the user nothing about the typo.
   *  Only IDLE, EXPIRED and NO_SESSION mean what this function is for. */
  function afterServer(res) {
    if (res && (res.code === 'IDLE' || res.code === 'EXPIRED' ||
                res.code === 'NO_SESSION')) {
      onDropped(res.code);
      return true;
    }
    return false;
  }

  function handleSettingsClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-auth]') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-auth');

    if (act === 'close') { closeSettings(); return; }

    if (act === 'signout') {
      btn.disabled = true;
      Auth.signOut().then(function (res) {
        btn.disabled = false;
        if (res.error) { setSettingsMessage(res.error, 'err'); return; }
        closeSettings();
        /* Reload rather than tear the app down by hand: the server will send
         * the reload to /login, which is the only way to be sure no rendered
         * newsletter is left on the screen. reloadCleanly saves first so
         * beforeunload cannot put up a prompt and block it. */
        reloadCleanly();
      });
      return;
    }

    if (act === 'remove') {
      var name = btn.getAttribute('data-name');
      if (!name) return;
      if (!global.confirm('Remove ' + name + '’s account?')) return;
      btn.disabled = true;
      Auth.removeUser(name).then(function (res) {
        if (afterServer(res)) return;
        if (res.error) {
          btn.disabled = false;
          /* 409 LAST_ADMIN: the roster we drew is out of date, so redraw it —
           * the "last admin" pill belongs where the button just was. */
          setSettingsMessage(res.error, 'err');
          if (res.code === 'LAST_ADMIN' || res.code === 'NO_SUCH_USER') renderSettings();
          return;
        }
        setSettingsMessage('Removed ' + res.removed.name + '.', 'ok');
        renderSettings();
      });
      return;
    }

    if (act === 'delete-self') {
      if (!me) return;
      if (!global.confirm('Delete your own account, ' + me.name + '?\n\n' +
          'The newsletter itself is not deleted.')) return;
      Auth.removeUser(me.name).then(function (res) {
        if (res.error) {
          /* Not disabled up front on a guess: only the server knows whether
           * this is the last administrator, and a button that is greyed out
           * for the wrong reason is worse than one that explains itself. */
          setSettingsMessage(res.error, 'err');
          return;
        }
        closeSettings();
        reloadCleanly();
      });
      return;
    }
  }

  function onAddUser(e) {
    e.preventDefault();
    var nameEl = $('#settings-new-name');
    var pwEl = $('#settings-new-password');
    var roleEl = $('#settings-new-role');
    var submit = $('#settings-add-form button[type="submit"]');

    if (submit) submit.disabled = true;
    Auth.addUser(nameEl.value, pwEl.value, roleEl.value).then(function (res) {
      if (submit) submit.disabled = false;
      if (afterServer(res)) return;
      if (res.error) {
        setSettingsMessage(res.error, 'err');
        /* 409 NAME_TAKEN: leave the name in the box so it can be edited
         * rather than retyped, and put the cursor in it. */
        if (res.code === 'NAME_TAKEN') nameEl.focus();
        if (res.code === 'NOT_ADMIN') renderSettings();
        return;
      }
      nameEl.value = '';
      pwEl.value = '';
      roleEl.value = 'user';
      setSettingsMessage('Added ' + res.user.name + '.', 'ok');
      renderSettings();
    });
  }

  function onChangePassword(e) {
    e.preventDefault();
    var curEl = $('#settings-current-password');
    var nextEl = $('#settings-next-password');
    var againEl = $('#settings-next-password-2');

    if (nextEl.value !== againEl.value) {
      setSettingsMessage('Those two passwords are not the same.', 'err');
      againEl.focus();
      return;
    }

    Auth.changePassword(curEl.value, nextEl.value).then(function (res) {
      if (afterServer(res)) return;
      if (res.error) { setSettingsMessage(res.error, 'err'); return; }
      curEl.value = '';
      nextEl.value = '';
      againEl.value = '';
      setSettingsMessage('Password changed. Anyone signed in as you ' +
        'somewhere else has been signed out; this window stays open.', 'ok');
    });
  }

  /* -------------------------------------------------------------------------
   * Shared
   * ---------------------------------------------------------------------- */

  /* The newsletter is autosaved continuously, but `beforeunload` still puts up
   * the browser's "leave site?" prompt whenever State.dirty is set — which
   * would BLOCK a deliberate reload. Persist first, then clear the flag so the
   * unload is silent. Nothing is lost: autosave writes the whole document. */
  function reloadCleanly() {
    try {
      if (Keys.State) {
        Keys.State.autosave();
        Keys.State.dirty = false;
      }
    } catch (e) {}
    global.location.reload();
  }

  /** Show who is signed in, in the toolbar button's label. */
  function syncIdentity() {
    var btn = $('[data-act="settings"]');
    if (!btn) return;
    var label = (MODE !== 'served')
      ? 'Settings — opened from disk, no accounts'
      : (me
        ? 'Settings — signed in as ' + me.name +
          (me.role === 'admin' ? ' (administrator)' : '')
        : 'Settings');
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
  }

  /** Fill both notices with the copy that is true for this mode. Called again
   *  when the server tells us its real idle timeout, because the served
   *  notice quotes that number. */
  function refreshNotices() {
    var text = MODE === 'served' ? servedNotice() : OFFLINE_NOTICE;
    $$('.auth-notice, .set-notice').forEach(function (el) {
      el.textContent = text;
    });
  }

  /* -------------------------------------------------------------------------
   * Wiring
   * ---------------------------------------------------------------------- */
  function wire() {
    var gateForm = $('#auth-form');
    if (gateForm) gateForm.addEventListener('submit', onGateSubmit);

    refreshNotices();

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

  Keys.Auth = Auth;
})(window);
