#!/usr/bin/env node
/* =============================================================================
 * reset-accounts.js — the documented way back in.
 *
 * Deletes accounts.json and issues a fresh setup token, so the next visit to
 * /setup creates a new administrator. Run it on the server:
 *
 *     node server/reset-accounts.js
 *     node server/reset-accounts.js --yes     (skip the confirmation)
 *     KEYS_DATA=/var/lib/keys node server/reset-accounts.js
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * This IS the answer to "the only administrator has left the parish and nobody
 * knows the password". Every lock needs one, and a lock whose recovery path is
 * undocumented does not have fewer ways in — it has the same ways in, found by
 * someone else, later. Writing it down means it can be reasoned about: this one
 * requires shell access to the machine, which is a strictly higher bar than
 * knowing a password, and it leaves an obvious trace.
 *
 * It is NOT a back door, because it opens nothing. It destroys the accounts
 * rather than revealing them; whoever runs it has to then set up a new
 * administrator from scratch, in front of everybody, and every existing session
 * dies with the accounts file. Somebody who could run this could already read
 * accounts.json, edit server.js, or simply read the newsletter off the disk.
 *
 * It NEVER touches newsletter content. The newsletter lives in the browser's
 * localStorage and in whatever .json files people have saved; this script only
 * knows about KEYS_DATA, and only about two files in it.
 *
 * It is NOT reachable over the network, and the browser can no longer do this
 * at all — Keys.Auth.resetAllAccounts is gone, because a page cannot be allowed
 * to wipe the server's accounts and pretending otherwise would have been a lie.
 * ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { Accounts } = require('./accounts.js');

const fsp = fs.promises;

const DATA_DIR = process.env.KEYS_DATA
  ? path.resolve(process.env.KEYS_DATA)
  : path.join(__dirname, 'data');

const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const TOKEN_FILE = path.join(DATA_DIR, 'setup-token.txt');

const assumeYes = process.argv.slice(2).some(
  (a) => a === '--yes' || a === '-y' || a === '--force'
);

function rule() { return '─'.repeat(60); }

/** Ask on the terminal. Returns a promise for the typed line.
 *
 *  Deliberately not using node:readline — this file, like everything else in
 *  the project, sticks to the handful of modules the contract allows, and a
 *  raw stdin read is six lines. */
function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding('utf8');
    const onData = (chunk) => {
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      resolve(String(chunk).trim());
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

/** Who is about to be deleted. Names and roles only — this file holds password
 *  hashes and this script must not print them, not even to a console the
 *  operator is already looking at. Terminal scrollback gets pasted into tickets. */
async function describeExisting() {
  let raw;
  try {
    raw = await fsp.readFile(ACCOUNTS_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const data = JSON.parse(raw);
    const users = (data && Array.isArray(data.users)) ? data.users : [];
    return users.map((u) => ({
      name: String((u && u.name) || '(unnamed)'),
      role: (u && u.role === 'admin') ? 'administrator' : 'user'
    }));
  } catch (e) {
    /* A corrupt file is exactly the situation this script exists for — the
     * server refuses to start on one. Report it and carry on to the delete. */
    return 'unreadable';
  }
}

async function main() {
  console.log('');
  console.log(rule());
  console.log('  RESET ACCOUNTS — St. Peter’s Keys');
  console.log('  Data directory   ' + DATA_DIR);
  console.log(rule());

  const existing = await describeExisting();

  if (existing === null) {
    console.log('');
    console.log('  There is no accounts file at ' + ACCOUNTS_FILE + '.');
    console.log('  Nothing to delete — issuing a setup token anyway.');
  } else if (existing === 'unreadable') {
    console.log('');
    console.log('  The accounts file exists but is not readable JSON. That is');
    console.log('  what this script is for; it will be removed.');
  } else {
    console.log('');
    console.log('  This will delete ' + existing.length + ' account(s):');
    for (const u of existing) console.log('    · ' + u.name + '  (' + u.role + ')');
    console.log('');
    console.log('  The newsletter itself is NOT touched. Everyone signed in');
    console.log('  will be signed out the next time the server restarts.');
  }

  if (!assumeYes && existing !== null) {
    console.log('');
    const answer = await ask('  Type DELETE to confirm: ');
    if (answer !== 'DELETE') {
      console.log('');
      console.log('  Nothing was changed.');
      console.log('');
      process.exit(1);
    }
  }

  await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });

  try {
    await fsp.unlink(ACCOUNTS_FILE);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  /* A fresh token, not the old one. The old token — if there even is one — may
   * have been passed around when the server was first deployed, and this is
   * precisely the moment to invalidate it. */
  const token = Accounts.generateToken();
  await Accounts.writeAtomic(TOKEN_FILE, token + '\n');

  console.log('');
  console.log(rule());
  console.log('  Accounts deleted. A fresh setup token has been issued.');
  console.log('');
  console.log('  Token  ' + token);
  console.log('  Saved  ' + TOKEN_FILE);
  console.log('');
  console.log('  Restart the server, then open /setup and use that token to');
  console.log('  create the new administrator account.');
  console.log(rule());
  console.log('');
}

main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('');
  console.error('  Could not reset accounts: ' +
    (err && err.message ? err.message : err));
  console.error('  Check that you can write to ' + DATA_DIR + '.');
  console.error('');
  process.exit(1);
});
