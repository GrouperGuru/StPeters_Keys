#!/usr/bin/env node
/* =============================================================================
 * server/stop.js — stop the server, including copies started by hand.
 *
 *   node server/stop.js              stop every copy of THIS project's server
 *   node server/stop.js --dry-run    list what it would stop, and stop nothing
 *   node server/stop.js --help
 *
 * HOW IT DECIDES WHAT TO STOP
 *
 * It stops a process only if that process is running THIS checkout's
 * server/server.js, matched on the absolute resolved path with a Node binary
 * in front of it. The rule and the reasoning live in server/instances.js;
 * the short version is that a tool which signals processes has to be certain,
 * and "certain" cannot mean "the command line contained the word node".
 *
 * So, deliberately:
 *   - a server belonging to a DIFFERENT copy of the project is left running.
 *     Two checkouts on one machine do not interfere. Run this from the copy
 *     you mean.
 *   - nginx, Apache, `python -m http.server` and an editor's live-preview are
 *     never touched, even when one of them is the reason the app is
 *     misbehaving. Stopping somebody's web server is not this script's
 *     business; server/whats-serving.js will tell you if one is in the way.
 *
 * SIGTERM first, and the wait is not politeness: server.js uses that signal
 * to stop listening, let requests already in flight finish, and flush a
 * queued accounts write. Killing it outright can lose an account that was
 * just added. SIGKILL is used only after the grace period, and it says so.
 *
 * Nobody is signed out by this beyond the obvious: sessions are held in the
 * server's memory, so stopping it ends all of them. Newsletter content is not
 * affected — it lives in each browser and in whatever .json files people have
 * saved.
 * ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const inst = require('./instances.js');

const argv = process.argv.slice(2);
const WANT_HELP = argv.includes('--help') || argv.includes('-h');
const DRY_RUN = argv.includes('--dry-run') || argv.includes('-n');

const GRACE_MS = 8000;
const POLL_MS = 200;

function say(line) { console.log(line === undefined ? '' : line); }
const RULE = '─'.repeat(60);

function help() {
  say('');
  say('  node server/stop.js              stop this project\'s server');
  say('  node server/stop.js --dry-run    show what would be stopped');
  say('');
  say('  Start it again:  node server/start.js');
  say('  Who is serving:  node server/whats-serving.js');
  say('');
  say('  Only processes running');
  say('      ' + inst.SERVER_PATH);
  say('  are considered. Another web server on the same port is reported by');
  say('  whats-serving.js and is never stopped by this script.');
  say('');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

async function waitForExit(pids, ms) {
  const deadline = Date.now() + ms;
  let left = pids.slice();
  while (left.length && Date.now() < deadline) {
    await sleep(POLL_MS);
    left = left.filter((p) => alive(p));
  }
  return left;
}

function describe(p) {
  const bits = ['process ' + p.pid];
  if (p.local) bits.push('desktop copy (KEYS_LOCAL)');
  const port = (p.cmd.match(/KEYS_PORT[=\s]*(\d+)/i) || [])[1];
  if (port) bits.push('port ' + port);
  return '  ' + bits.join('  ·  ');
}

/* ========================================================================== */
async function main() {
  if (WANT_HELP) { help(); return 0; }

  const found = inst.findOurServers();

  if (found === null) {
    say('');
    say('Could not read this machine\'s process list, so there is no safe way');
    say('to tell which processes are the server.');
    say('');
    if (process.platform === 'win32') {
      say('This needs PowerShell on the PATH.');
    } else {
      say('This needs the `ps` command on the PATH.');
    }
    say('');
    /* A pid file alone is not enough to act on: isOurServer() cannot confirm
     * identity without the process table, and signalling an unverified PID is
     * exactly the mistake this script exists to avoid. */
    const rec = inst.readPidFile();
    if (rec) {
      say('A previous start recorded process ' + rec.pid + '. If you are sure');
      say('that is the server, stop it yourself:');
      say(process.platform === 'win32'
        ? '    taskkill /PID ' + rec.pid
        : '    kill ' + rec.pid);
      say('');
    }
    return 1;
  }

  if (found.length === 0) {
    say('');
    say('The server is not running.');
    /* A pid file with nothing behind it is a leftover from a crash, a reboot,
     * or a stop performed some other way. Tidying it silently is right: it is
     * this script's own bookkeeping, not the user's problem. */
    if (inst.readPidFile()) {
      inst.clearPidFile();
      say('(Cleared a stale record of an earlier run.)');
    }
    say('');
    say('If a page is still being served, it is something else — find out');
    say('what with:  node server/whats-serving.js');
    say('');
    return 0;
  }

  say('');
  say(found.length === 1 ? 'Found 1 server process:'
                         : 'Found ' + found.length + ' server processes:');
  found.forEach((p) => say(describe(p)));
  say('');

  if (DRY_RUN) {
    say('--dry-run: nothing was stopped.');
    say('');
    return 0;
  }

  /* --- SIGTERM ---------------------------------------------------------- */
  const signalled = [];
  found.forEach((p) => {
    try {
      process.kill(p.pid, 'SIGTERM');
      signalled.push(p.pid);
    } catch (e) {
      if (e && e.code === 'EPERM') {
        say('  process ' + p.pid + ': not permitted — it belongs to another');
        say('    user. Try again with sudo, or as the user that started it.');
      } else if (e && e.code === 'ESRCH') {
        /* Exited between the scan and the signal. Nothing to do. */
      } else {
        say('  process ' + p.pid + ': ' + (e && (e.code || e.message)));
      }
    }
  });

  if (signalled.length === 0) {
    say('');
    say('Nothing could be stopped.');
    say('');
    return 1;
  }

  say('Asked ' + signalled.length +
      (signalled.length === 1 ? ' process' : ' processes') +
      ' to stop, and waiting for in-flight requests to finish…');

  let stubborn = await waitForExit(signalled, GRACE_MS);

  /* --- SIGKILL, only for what is left ----------------------------------- */
  if (stubborn.length) {
    say('');
    say(stubborn.join(', ') + ' did not stop within ' + (GRACE_MS / 1000) +
        ' seconds. Forcing.');
    say('(An accounts write that was still queued may be lost — if somebody');
    say('was added in the last moment, check Settings once it is back up.)');
    stubborn.forEach((pid) => {
      try { process.kill(pid, 'SIGKILL'); } catch (e) {}
    });
    stubborn = await waitForExit(stubborn, 3000);
  }

  inst.clearPidFile();

  say('');
  if (stubborn.length) {
    say('Still running: ' + stubborn.join(', ') + '. Stop these by hand:');
    say(process.platform === 'win32'
      ? '    taskkill /F /PID ' + stubborn.join(' /PID ')
      : '    kill -9 ' + stubborn.join(' '));
    say('');
    return 1;
  }

  say('Stopped. Everyone signed in has been signed out, because sessions live');
  say('only in the server\'s memory. No newsletter content is affected.');
  say('');
  say('Start it again with:  node server/start.js');
  say('');
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('stop.js could not finish: ' + (e && e.message));
  process.exit(1);
});
