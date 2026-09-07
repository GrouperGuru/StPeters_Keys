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

  var ROLES = { admin: 1, user: 1 };

  var bootApp = null;        // handed over by app.js
  var started = false;

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
  function readSession() {
    var raw;
    try { raw = sessionStorage.getItem(SESSION_KEY); } catch (e) { raw = null; }
    if (!raw) return null;
    var s;
    try { s = JSON.parse(raw); } catch (e) { return null; }
    if (!s || typeof s !== 'object' || !s.userId) return null;
    if (!isFinite(Number(s.startedAt)) ||
        Date.now() - Number(s.startedAt) > SESSION_MAX_AGE_MS) {
      clearSession();
      return null;
    }
    // The account may have been deleted in another tab since sign-in.
    var user = findById(readStore(), s.userId);
    if (!user) { clearSession(); return null; }
    return publicUser(user);
  }

  function writeSession(user) {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        userId: user.id, startedAt: Date.now()
      }));
    } catch (e) {}
  }

  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
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
       * never cost anyone their newsletter), stand the gate down and say so. */
      if (!cryptoAvailable()) {
        showDegradedNotice();
        unlock();
        return;
      }

      var me = readSession();
      if (me) { unlock(); return; }
      showGate();
    }
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
    setGateError('');

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
  }

  function showDegradedNotice() {
    var el = $('#auth-degraded');
    if (el) el.hidden = false;
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
      closeSettings();
      // Reload rather than tear the app down by hand: it is the only way to
      // be sure no rendered newsletter is left behind the gate.
      global.location.reload();
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
      closeSettings();
      global.location.reload();
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
