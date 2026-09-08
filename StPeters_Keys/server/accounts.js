/* =============================================================================
 * accounts.js — the account store.
 *
 * Owns: password hashing and verification, the on-disk accounts file, name and
 * password validation, the roster, and the last-administrator rule.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * This IS the real thing. Unlike the browser-side store it replaces, nothing
 * here is reachable by whoever is sitting at the machine: the file lives on the
 * server at mode 0600, and the only way to ask it a question is through the API
 * in server.js, which is behind a session cookie.
 *
 * It is NOT a database. Everything lives in one JSON file held wholly in
 * memory, rewritten in full on every change. That is correct for a parish
 * newsletter with a handful of authors and would be wrong at a hundred times
 * the size; the moment this needs indexes or concurrent writers it needs
 * something else entirely, not a bigger version of this.
 *
 * It knows nothing about HTTP. It never reads a request, never writes a
 * response, and never decides who is allowed to call it — server.js does all
 * of that. Keeping the rules ("only an admin may…") in server.js and the facts
 * ("who is an admin") here is what stops the two drifting apart.
 *
 * -----------------------------------------------------------------------------
 * THE ONE RULE THAT MATTERS MOST
 *
 * accounts.json is written atomically — temp file, fsync, rename. A crash
 * halfway through a normal write would leave a truncated file, which on the
 * next start is an accounts file with no administrator in it and no setup token
 * to make a new one. That is a permanently locked-out parish. The rename dance
 * costs two syscalls and removes the failure mode entirely.
 * ========================================================================== */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const fsp = fs.promises;

/* OWASP's floor for PBKDF2-HMAC-SHA256, and deliberately the SAME number the
 * browser version used. Moving the hashing to the server must not quietly make
 * anything weaker; if these two ever diverge it should be because someone
 * raised this one. */
const ITERATIONS = 310000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

const MIN_PASSWORD = 8;

/* A password is a passphrase, not a payload. PBKDF2's cost barely moves with
 * input length, but there is no reason to hand an unauthenticated caller a
 * megabyte of HMAC either, and a limit here is one fewer thing to think about.
 * Sits well above anything a person will type or a password manager will make. */
const MAX_PASSWORD = 1024;

const MAX_NAME = 40;

/* Names go in a URL path (DELETE /api/users/:name), in a JSON document, and on
 * screen. This alphabet is safe in all three without escaping games, and it is
 * wide enough for "Fr. Michael O-Brien" — which is the actual requirement. */
const NAME_RE = /^[A-Za-z0-9 ._-]+$/;

const ROLES = { admin: 1, user: 1 };

const SCHEMA_VERSION = 1;

/* The setup token's alphabet: no I, O, 0, 1, U. Somebody is going to read this
 * off a terminal and type it into a phone, and "was that an oh or a zero" is a
 * support call. 16 characters from 27 symbols is ~76 bits, which is far beyond
 * anything guessable over the network even without the rate limiter. */
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTVWXYZ23456789';
const TOKEN_GROUPS = 4;
const TOKEN_GROUP_LEN = 4;

/* -----------------------------------------------------------------------------
 * Key derivation
 *
 * pbkdf2 (async) rather than pbkdf2Sync: 310,000 iterations is ~100ms, and the
 * synchronous call would stop the entire server dead for that long on every
 * sign-in. The async form runs on libuv's threadpool, so other requests carry
 * on being served while a password is being checked.
 * -------------------------------------------------------------------------- */
function pbkdf2(password, salt, iterations) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, KEY_BYTES, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** Compare two buffers without leaking, through timing, how far they matched.
 *
 *  timingSafeEqual THROWS on a length mismatch rather than returning false, so
 *  the length has to be checked first. That is fine here: every caller compares
 *  fixed-width digests whose length is public. */
function equalBytes(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* -----------------------------------------------------------------------------
 * Atomic persistence
 * -------------------------------------------------------------------------- */

/** fsync the directory itself, so the rename is durable and not just the file's
 *  contents. Without this a power cut can leave the old directory entry even
 *  though the new file is fully on disk. Best effort: some platforms and some
 *  filesystems refuse to open a directory for this, and that is not fatal. */
async function fsyncDir(dir) {
  let handle = null;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch (e) {
    /* Windows and a few network filesystems do not allow it. Nothing to do. */
  } finally {
    if (handle) { try { await handle.close(); } catch (e) {} }
  }
}

/** Write `data` to `file` so that `file` is either entirely the old contents or
 *  entirely the new ones, never a half of each. See the header comment for why
 *  this is the single most important function in this file. */
async function writeAtomic(file, data) {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    '.' + path.basename(file) + '.tmp-' + crypto.randomBytes(6).toString('hex')
  );

  let handle = null;
  try {
    /* 'wx' fails rather than clobbers if the name somehow already exists, and
     * the mode is set at CREATION — never create it world-readable and chmod it
     * afterwards, because that leaves a window where the hashes are readable. */
    handle = await fsp.open(tmp, 'wx', 0o600);
    /* umask can only take bits away, so belt and braces: assert the mode we
     * actually want rather than the one umask left us with. */
    await handle.chmod(0o600);
    await handle.writeFile(data, 'utf8');
    await handle.sync();          // the bytes are on the disk, not in a buffer
    await handle.close();
    handle = null;
    await fsp.rename(tmp, file);  // atomic within one filesystem
    await fsyncDir(dir);
  } finally {
    if (handle) { try { await handle.close(); } catch (e) {} }
    /* After a successful rename this is an ENOENT we do not care about; after a
     * failure it is the cleanup that stops temp files piling up. */
    try { await fsp.unlink(tmp); } catch (e) {}
  }
}

/* -----------------------------------------------------------------------------
 * The store
 * -------------------------------------------------------------------------- */
class Accounts {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'accounts.json');
    this.tokenFile = path.join(dataDir, 'setup-token.txt');
    this.users = [];
    this.setupToken = null;

    /* Every save goes through this one promise chain, so two overlapping
     * requests cannot interleave their read-modify-write and lose one of the
     * two changes. The whole store is held in memory and rewritten in full,
     * so serialising the writes is all the concurrency control needed. */
    this._writeQueue = Promise.resolve();
  }

  /* --- lifecycle -------------------------------------------------------- */

  async load() {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });

    let raw = null;
    try {
      raw = await fsp.readFile(this.file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.users = [];
      return;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      /* The browser version dropped a corrupt store and fell back to first-run
       * setup, because there the worst case was a lost local password. Here it
       * is not: falling back would mean an unreadable accounts file silently
       * becomes "this box has no administrator", and the next person to reach
       * /setup with the token becomes one. Refuse to start instead, and say
       * exactly which file and exactly how to recover. Failing closed and loud
       * beats failing open and quiet. */
      throw new Error(
        'accounts.json is not valid JSON (' + this.file + '): ' + e.message +
        '\nRefusing to start rather than treat this as "no accounts exist".' +
        '\nRestore it from a backup, or run: node server/reset-accounts.js'
      );
    }

    const list = (data && Array.isArray(data.users)) ? data.users : [];
    const kept = [];
    const dropped = [];
    for (const u of list) {
      if (this._isUsableRecord(u)) kept.push(this._normaliseRecord(u));
      else dropped.push(u && typeof u.name === 'string' ? u.name : '(unnamed)');
    }
    this.users = kept;

    if (dropped.length) {
      /* Names, never hashes. Loud because a dropped record could be the only
       * administrator, and a silent one would look like the account had simply
       * never existed. */
      console.warn('[keys] accounts.json: ignored ' + dropped.length +
        ' unusable record(s): ' + dropped.join(', '));
    }
  }

  _isUsableRecord(u) {
    return !!u && typeof u === 'object' && !Array.isArray(u) &&
      typeof u.name === 'string' && u.name.trim() !== '' &&
      typeof u.salt === 'string' && typeof u.hash === 'string' &&
      ROLES[u.role] === 1 &&
      Number.isFinite(Number(u.iterations)) && Number(u.iterations) > 0;
  }

  _normaliseRecord(u) {
    return {
      id: typeof u.id === 'string' && u.id ? u.id : crypto.randomUUID(),
      name: String(u.name).slice(0, MAX_NAME),
      role: u.role,
      salt: String(u.salt),
      hash: String(u.hash),
      iterations: Math.min(Math.max(Math.trunc(Number(u.iterations)), 1), 10000000),
      createdAt: Number.isFinite(Number(u.createdAt)) ? Number(u.createdAt) : Date.now(),
      lastSignInAt: Number.isFinite(Number(u.lastSignInAt)) ? Number(u.lastSignInAt) : null
    };
  }

  save() {
    const snapshot = JSON.stringify({
      version: SCHEMA_VERSION,
      users: this.users
    }, null, 2) + '\n';

    this._writeQueue = this._writeQueue
      .catch(() => {})                 // one failed write must not wedge the queue
      .then(() => writeAtomic(this.file, snapshot));
    return this._writeQueue;
  }

  /* --- the roster ------------------------------------------------------- */

  get count() { return this.users.length; }

  hasAccounts() { return this.users.length > 0; }

  adminCount() {
    return this.users.filter((u) => u.role === 'admin').length;
  }

  /** Uniqueness is case-insensitive — "Ryan" and "ryan" are the same person as
   *  far as anyone reading a roster is concerned, and two of them would be a
   *  permanent source of "why can't I sign in". Display keeps the original. */
  findByName(name) {
    const wanted = String(name == null ? '' : name).trim().toLowerCase();
    if (!wanted) return null;
    return this.users.find((u) => u.name.toLowerCase() === wanted) || null;
  }

  findById(id) {
    return this.users.find((u) => u.id === id) || null;
  }

  /** The public shape, exactly as docs/AUTH-API.md §4 defines it. Password
   *  material has no route out of this module other than by editing this
   *  function, which is the point of it being the only projection anyone uses. */
  publicUser(u) {
    if (!u) return null;
    return {
      name: u.name,
      role: u.role,
      createdAt: u.createdAt,
      lastSignInAt: u.lastSignInAt
    };
  }

  /** Everyone, without secrets. Administrators first, then alphabetical —
   *  the same order the browser roster used, so the Settings panel does not
   *  need to re-sort. */
  roster() {
    return this.users
      .map((u) => this.publicUser(u))
      .sort((a, b) => {
        if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  /* --- validation -------------------------------------------------------
   * These return { value } or { code, error }, never throw, and never look at
   * who is asking. server.js turns the code into a status.
   * -------------------------------------------------------------------- */

  checkName(name, exceptId) {
    const clean = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
    if (!clean) {
      return { code: 'BAD_NAME', error: 'Enter a name.' };
    }
    if (clean.length > MAX_NAME) {
      return {
        code: 'BAD_NAME',
        error: 'That name is too long (' + MAX_NAME + ' characters at most).'
      };
    }
    if (!NAME_RE.test(clean)) {
      return {
        code: 'BAD_NAME',
        error: 'Names can use letters, numbers, spaces, full stops, hyphens ' +
               'and underscores.'
      };
    }
    const existing = this.findByName(clean);
    if (existing && existing.id !== exceptId) {
      return {
        code: 'NAME_TAKEN',
        error: 'Someone is already called “' + clean + '”.'
      };
    }
    return { value: clean };
  }

  checkPassword(pw) {
    const s = typeof pw === 'string' ? pw : '';
    if (s.length < MIN_PASSWORD) {
      return {
        code: 'WEAK_PASSWORD',
        error: 'Use at least ' + MIN_PASSWORD + ' characters. A short phrase ' +
               'you can remember beats a short jumble.'
      };
    }
    if (s.length > MAX_PASSWORD) {
      return {
        code: 'WEAK_PASSWORD',
        error: 'That password is longer than ' + MAX_PASSWORD + ' characters.'
      };
    }
    return { value: s };
  }

  /* --- passwords -------------------------------------------------------- */

  async hashPassword(password) {
    const salt = crypto.randomBytes(SALT_BYTES);
    const key = await pbkdf2(password, salt, ITERATIONS);
    return {
      salt: salt.toString('base64'),
      hash: key.toString('base64'),
      iterations: ITERATIONS
    };
  }

  /** Does `password` belong to `user`?
   *
   *  `user` may be null, and that case is the whole reason this signature looks
   *  the way it does. A wrong NAME and a wrong PASSWORD must cost the same
   *  amount of time, or the response time alone tells an attacker which parish
   *  names have accounts — and those names are, by their nature, guessable.
   *  So when there is no such user we still derive a key at the same cost
   *  against a throwaway salt and still run the comparison, then return false.
   *  Do not "optimise" the null check to an early return. */
  async verifyPassword(user, password) {
    const pw = typeof password === 'string' ? password : '';

    const salt = user
      ? Buffer.from(user.salt, 'base64')
      : crypto.randomBytes(SALT_BYTES);
    const iterations = user ? user.iterations : ITERATIONS;
    const expected = user
      ? Buffer.from(user.hash, 'base64')
      : crypto.randomBytes(KEY_BYTES);

    let derived;
    try {
      derived = await pbkdf2(pw, salt, iterations);
    } catch (e) {
      return false;
    }
    const same = equalBytes(derived, expected);
    /* `user &&` last, after the constant-cost work is already done. */
    return !!user && same;
  }

  /* --- mutations --------------------------------------------------------
   * Each of these persists before returning, so a caller that has been told
   * "created" can rely on it having survived a crash one line later.
   * -------------------------------------------------------------------- */

  /** Returns { user } or { code, error }.
   *
   *  The union return is not decoration: hashing takes ~100ms, and the name
   *  has to be re-checked on the far side of that wait. Two administrators
   *  adding "Michael" in the same breath would BOTH have passed checkName
   *  before either finished hashing, and the loser would push a duplicate that
   *  findByName can never reach again — an account that exists in the file,
   *  shows in the roster, and cannot be signed into or deleted. */
  async createUser(name, password, role) {
    const material = await this.hashPassword(password);

    const clash = this.findByName(name);
    if (clash) {
      return {
        code: 'NAME_TAKEN',
        error: 'Someone is already called “' + name + '”.'
      };
    }

    const user = {
      id: crypto.randomUUID(),
      name: name,
      role: ROLES[role] === 1 ? role : 'user',
      salt: material.salt,
      hash: material.hash,
      iterations: material.iterations,
      createdAt: Date.now(),
      lastSignInAt: null
    };
    this.users.push(user);
    await this.save();
    return { user: user };
  }

  /** Wait for every queued write to land. Called on shutdown so a save issued
   *  a millisecond before SIGTERM is not lost to process.exit. */
  flush() {
    return this._writeQueue.catch(() => {});
  }

  async noteSignIn(user) {
    user.lastSignInAt = Date.now();
    await this.save();
  }

  /** Would removing this user leave the parish with nobody who can manage
   *  accounts? The browser version guarded this because the only way out was
   *  clearing browser storage; here the only way out is SSH plus
   *  reset-accounts.js, which also signs everybody out. Still worth avoiding. */
  wouldStripLastAdmin(user) {
    return user.role === 'admin' && this.adminCount() <= 1;
  }

  async removeUser(user) {
    this.users = this.users.filter((u) => u.id !== user.id);
    await this.save();
    return user;
  }

  /** Change a password and rotate the salt with it.
   *
   *  Rotating matters: reusing the old salt would mean the new hash and the old
   *  one were made with the same input material, so anyone holding a copy of
   *  the file from before the change gets a free confirmation of whether the
   *  password actually changed. A new salt makes the two rows unrelatable. */
  async setPassword(user, password) {
    const material = await this.hashPassword(password);
    user.salt = material.salt;
    user.hash = material.hash;
    user.iterations = material.iterations;
    await this.save();
  }

  /* --- the setup token --------------------------------------------------
   * See docs/AUTH-API.md §6. The token exists so the administrator account
   * cannot be claimed by whoever reaches the box first on a shared network:
   * without it, "clone it onto a VM" and "walk up and become the admin" are
   * the same act.
   * -------------------------------------------------------------------- */

  static generateToken() {
    const groups = [];
    for (let g = 0; g < TOKEN_GROUPS; g++) {
      let out = '';
      for (let i = 0; i < TOKEN_GROUP_LEN; i++) {
        /* randomInt, not randomBytes % length: the modulo of a byte over a
         * 31-symbol alphabet is very slightly biased, and there is a correct
         * primitive right here. */
        out += TOKEN_ALPHABET[crypto.randomInt(TOKEN_ALPHABET.length)];
      }
      groups.push(out);
    }
    return groups.join('-');
  }

  /** Make sure a setup token exists iff there are no accounts.
   *
   *  An existing token file is REUSED rather than replaced on every start. An
   *  administrator who wrote the token down and then restarted the service
   *  should not find it silently invalidated — that reads as a broken product,
   *  and the pressure it creates is "just take the token check out". The token
   *  is already unguessable; rotating it per restart buys nothing. */
  async ensureSetupToken() {
    if (this.hasAccounts()) {
      this.setupToken = null;
      await this.clearSetupTokenFile();
      return null;
    }

    let existing = null;
    try {
      existing = (await fsp.readFile(this.tokenFile, 'utf8')).trim();
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }

    if (existing && /^[A-Z0-9-]{8,64}$/.test(existing)) {
      this.setupToken = existing;
      return existing;
    }

    this.setupToken = Accounts.generateToken();
    await writeAtomic(this.tokenFile, this.setupToken + '\n');
    return this.setupToken;
  }

  /** Constant-time, and shape-insensitive: somebody typing the token off a
   *  terminal will get the case or the dashes wrong, and that is not an attack.
   *  Hashing both sides first means the comparison is fixed-width whatever the
   *  caller sent, so a wrong LENGTH costs the same as a wrong CHARACTER. */
  checkSetupToken(presented) {
    if (!this.setupToken) return false;
    const norm = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const a = crypto.createHash('sha256').update(norm(presented)).digest();
    const b = crypto.createHash('sha256').update(norm(this.setupToken)).digest();
    return equalBytes(a, b);
  }

  async consumeSetupToken() {
    this.setupToken = null;
    await this.clearSetupTokenFile();
  }

  async clearSetupTokenFile() {
    try {
      await fsp.unlink(this.tokenFile);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}

Accounts.ITERATIONS = ITERATIONS;
Accounts.MIN_PASSWORD = MIN_PASSWORD;
Accounts.MAX_NAME = MAX_NAME;
Accounts.SCHEMA_VERSION = SCHEMA_VERSION;
Accounts.writeAtomic = writeAtomic;
Accounts.equalBytes = equalBytes;

module.exports = { Accounts };
