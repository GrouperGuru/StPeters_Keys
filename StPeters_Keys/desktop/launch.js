#!/usr/bin/env node
/* =============================================================================
 * desktop/launch.js — the desktop app's one moving part.
 *
 * Started by desktop/StPeters-Keys.command (macOS) or
 * desktop/StPeters-Keys.bat (Windows), both of which exist only to find a
 * usable Node and then run this file. Everything after that is here:
 *
 *   1. start server/server.js with KEYS_LOCAL=1,
 *   2. wait until it is really listening, and learn which port it got,
 *   3. open the URL in the default browser,
 *   4. keep the two processes' lives tied together, so closing the window
 *      stops the server and the server stopping closes the window.
 *
 * Usage:
 *   node desktop/launch.js [--port N] [--no-browser]
 *
 * WHAT THIS IS NOT: it is not a second copy of the application. There is one
 * server in this repository and one app; the desktop version is that same
 * server with authentication switched off and the listener nailed to
 * 127.0.0.1. See the LOCAL MODE comment at the top of server/server.js for why
 * the loopback binding is not negotiable.
 *
 * No dependencies, deliberately — same rule as the rest of the project. Only
 * node:child_process, node:http, node:path, node:fs, node:os.
 * ========================================================================== */
'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

/* Must match the line server.js prints in local mode. */
const READY_PREFIX = '[keys] KEYS-LOCAL-READY ';

/* Not 8749. That is the served version's port, and someone running both — a
 * parish secretary trying the desktop copy on the machine that also serves the
 * real one — should not have the two fight over a socket. server.js walks
 * upward from here if this one is busy and tells us where it landed. */
const DEFAULT_PORT = 8750;

const MIN_NODE_MAJOR = 20;

/* How long to wait for "listening". A cold start is milliseconds; this is the
 * budget for a machine paging Node in from a spinning disk under load. */
const READY_TIMEOUT_MS = 30000;

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_JS = path.join(REPO_ROOT, 'server', 'server.js');
const INDEX_HTML = path.join(REPO_ROOT, 'index.html');

/* ---------------------------------------------------------------------------
 * Talking to a person, not a log
 *
 * Whoever reads this output double-clicked an icon. Every line has to make
 * sense to them, which mostly means: say what happened, and say what to do.
 * ------------------------------------------------------------------------ */
function say(line) { console.log(line == null ? '' : String(line)); }
function rule() { say('─'.repeat(64)); }

function fatal(lines, code) {
  say('');
  rule();
  for (const line of [].concat(lines)) say('  ' + line);
  rule();
  say('');
  process.exitCode = (code == null ? 1 : code);
}

/* ---------------------------------------------------------------------------
 * Arguments
 * ------------------------------------------------------------------------ */
function parseArgs(argv) {
  const out = { port: null, browser: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-browser') { out.browser = false; continue; }
    if (a === '--port') { out.port = Number(argv[++i]); continue; }
    if (a.startsWith('--port=')) { out.port = Number(a.slice(7)); continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    say('[launch] ignoring unrecognised option "' + a + '".');
  }
  return out;
}

function choosePort(args) {
  const candidates = [args.port, Number(process.env.KEYS_PORT), DEFAULT_PORT];
  for (const n of candidates) {
    if (Number.isFinite(n) && n >= 1 && n <= 65535) return Math.trunc(n);
  }
  return DEFAULT_PORT;
}

/* ---------------------------------------------------------------------------
 * Readiness
 *
 * Two signals, and both are wanted. The stdout marker is how the port is
 * learned (server.js may have walked upward from the one we asked for). The
 * HTTP probe is what proves the socket actually answers — a marker printed by
 * a process that then died at once would otherwise send us to open a browser
 * on nothing, and "the app didn't open" is the least diagnosable of all
 * failures.
 * ------------------------------------------------------------------------ */
function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url + 'api/auth/state', { timeout: 4000 }, (res) => {
      res.resume();                     // drain, or the socket is held open
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntilAnswering(url, deadline) {
  while (Date.now() < deadline) {
    if (await probe(url)) return true;
    await sleep(200);
  }
  return false;
}

/* ---------------------------------------------------------------------------
 * The browser
 *
 * The DEFAULT browser, whichever that is. Nothing here launches a particular
 * one: the person's own choice is also the one their bookmarks, their zoom
 * level and their printer settings live in, and printing is what this
 * application is for.
 * ------------------------------------------------------------------------ */
function openBrowser(url) {
  let cmd;
  let args;
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    /* start is a cmd builtin, not a program, hence cmd /c. The empty "" is the
     * window TITLE argument: without it, start treats a quoted URL as the
     * title and opens nothing at all — a classic, and silent. */
    cmd = process.env.COMSPEC || 'cmd.exe';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';                   // Linux is not a target, but it costs
    args = [url];                       // one line to not be broken there
  }

  try {
    const child = spawn(cmd, args, {
      stdio: 'ignore',
      detached: true,
      windowsVerbatimArguments: process.platform === 'win32'
    });
    child.on('error', () => {
      say('[launch] could not open a browser automatically. Open this ' +
        'address yourself:');
      say('[launch]   ' + url);
    });
    child.unref();
  } catch (e) {
    say('[launch] could not open a browser automatically. Open this address ' +
      'yourself:');
    say('[launch]   ' + url);
  }
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------ */
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    say('St. Peter’s Keys — desktop launcher');
    say('');
    say('  node desktop/launch.js [--port N] [--no-browser]');
    say('');
    say('Starts the newsletter on 127.0.0.1 with no sign-in and opens it in');
    say('your browser. Close this window, or press Ctrl-C, to stop it.');
    return;
  }

  /* A backstop, not the real check: the .command and .bat both refuse to run
   * an old Node before they get here. This catches the case where somebody
   * runs this file directly with whatever `node` they happen to have. */
  const major = Number(String(process.versions.node).split('.')[0]);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    fatal([
      'This needs Node.js ' + MIN_NODE_MAJOR + ' or newer, and this is ' +
        'Node ' + process.versions.node + '.',
      '',
      'Double-click StPeters-Keys.command (Mac) or StPeters-Keys.bat',
      '(Windows) instead — they will offer to install a current Node for you.'
    ], 3);
    return;
  }

  for (const [file, what] of [[SERVER_JS, 'server/server.js'],
                              [INDEX_HTML, 'index.html']]) {
    if (!fs.existsSync(file)) {
      fatal([
        'Cannot find ' + what + '.',
        '',
        'This launcher has to sit in the desktop/ folder of the St. Peter’s',
        'Keys project, next to server/ and index.html. If you copied just',
        'the launcher somewhere else, copy the whole folder instead.'
      ], 1);
      return;
    }
  }

  const port = choosePort(args);

  /* KEYS_HOST is answered here rather than left to the server's refusal,
   * because the desktop user did not set it and would have no idea what the
   * refusal meant. Overriding it is safe in exactly one direction — towards
   * loopback — and that is the direction this goes. The server checks again
   * regardless, and would refuse if this ever became wrong. */
  const env = Object.assign({}, process.env, {
    KEYS_LOCAL: '1',
    KEYS_HOST: '127.0.0.1',
    KEYS_PORT: String(port)
  });
  if (process.env.KEYS_HOST && process.env.KEYS_HOST !== '127.0.0.1') {
    say('[launch] ignoring KEYS_HOST="' + process.env.KEYS_HOST + '": the ' +
      'desktop version has no sign-in, so it only ever listens on 127.0.0.1.');
  }

  say('[launch] starting St. Peter’s Keys on this computer only…');

  const child = spawn(process.execPath, [SERVER_JS], {
    cwd: REPO_ROOT,
    env: env,
    stdio: ['ignore', 'pipe', 'pipe'],
    /* No detach: this process is the desktop app's lifetime. When the window
     * closes, both go. */
    windowsHide: false
  });

  let readyUrl = null;
  let childExited = false;
  let childCode = null;

  /* The server's own output is the user's only window into what happened, so
   * it is forwarded verbatim rather than swallowed. The READY line is the one
   * exception: it is plumbing, and is consumed rather than shown. */
  let stdoutTail = '';
  const onStdout = (chunk) => {
    stdoutTail += chunk;
    const lines = stdoutTail.split(/\r?\n/);
    stdoutTail = lines.pop();
    for (const line of lines) {
      if (line.startsWith(READY_PREFIX)) {
        readyUrl = line.slice(READY_PREFIX.length).trim();
        continue;
      }
      say(line);
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', onStdout);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { process.stderr.write(chunk); });

  child.on('error', (err) => {
    childExited = true;
    fatal([
      'Could not start the newsletter server: ' + err.message,
      '',
      'Node.js is installed (this launcher is running under it), so this is',
      'more likely a permissions or antivirus problem than a missing Node.'
    ], 1);
  });

  child.on('exit', (code, signal) => {
    childExited = true;
    childCode = (code == null ? 1 : code);
    if (signal) say('[launch] the server stopped (' + signal + ').');
  });

  /* --- lives tied together, from the first moment there is a child --------
   * Registered HERE rather than after the app is up, because the gap between
   * spawning the server and the browser opening is exactly where somebody
   * gives up and closes the window — and a signal arriving in that gap must
   * still take the server with it. A Ctrl-C would reach the child anyway
   * (same process group), but a plain `kill` of this process would not, and
   * would leave a server listening with nobody watching it.
   *
   * SIGHUP is the closed Terminal window, and on Windows it is what Node
   * raises when the console window is closed; SIGBREAK is Ctrl-Break there.
   * 'exit' is the catch-all for a path nobody thought of.
   *
   * What none of this can see is the BROWSER closing, and nothing here
   * pretends otherwise: a closed tab is not a quit signal, and treating it as
   * one would end somebody's session on a mistaken ⌘W. The server's own hour
   * of silence covers that case — see LOCAL_IDLE_EXIT_MS in
   * server/server.js.
   * -------------------------------------------------------------------- */
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    say('');
    say('[launch] stopping (' + signal + ')…');
    stopChild(child);
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(sig, () => stop(sig)); } catch (e) { /* not on this OS */ }
  }
  process.on('exit', () => { try { child.kill('SIGKILL'); } catch (e) {} });

  /* --- wait for it to be up ---------------------------------------------- */
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!readyUrl && !childExited && Date.now() < deadline) {
    await sleep(100);
  }

  if (childExited) {
    /* The server said why on its way out — its refusals are written to be
     * read — so do not bury that under a second explanation. */
    fatal([
      'The newsletter server stopped before it was ready.',
      'Its own message is just above; that is the one to read.'
    ], childCode || 1);
    return;
  }

  if (!readyUrl) {
    stopChild(child);
    fatal([
      'The newsletter server did not come up within ' +
        Math.round(READY_TIMEOUT_MS / 1000) + ' seconds.',
      '',
      'Nothing is broken on your machine as far as this can tell. Try again;',
      'if it keeps happening, run this from a terminal to see the full output:',
      '  node "' + path.join(REPO_ROOT, 'desktop', 'launch.js') + '"'
    ], 1);
    return;
  }

  const answering = await waitUntilAnswering(readyUrl, Date.now() + 10000);
  if (!answering) {
    stopChild(child);
    fatal([
      'The newsletter server started but is not answering at ' + readyUrl,
      '',
      'Something on this machine — a firewall or a security product — may be',
      'blocking connections to 127.0.0.1. You can still work offline: open',
      INDEX_HTML,
      'in your browser (see desktop/README.md for what that costs you).'
    ], 1);
    return;
  }

  /* --- it is up ---------------------------------------------------------- */
  say('');
  rule();
  say('  St. Peter’s Keys is running on this computer.');
  say('');
  say('    ' + readyUrl);
  say('');
  say('  No sign-in: this copy is for whoever is sitting here, and it is not');
  say('  reachable from any other machine.');
  say('');
  say('  Leave this window open while you work. To stop: close it, or press');
  say('  Ctrl-C. Your newsletter is saved in the browser as you type.');
  rule();
  say('');

  if (args.browser) openBrowser(readyUrl);
  else say('[launch] --no-browser: not opening one. The address is above.');

  /* And the other direction: if the server dies, this window has nothing left
   * to do, so it goes too rather than sitting there looking like a running
   * application. */
  await new Promise((resolve) => {
    if (childExited) return resolve();
    child.on('exit', () => resolve());
  });

  say('[launch] St. Peter’s Keys has stopped. You can close this window.');
}

/** Ask, then insist. SIGTERM lets server.js flush and print "stopped."; the
 *  timer is there because a process that ignores SIGTERM must not turn the
 *  closing of a window into a hang. */
function stopChild(child) {
  try { child.kill('SIGTERM'); } catch (e) {}
  const t = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch (e) {}
  }, 5000);
  if (typeof t.unref === 'function') t.unref();
}

main().catch((err) => {
  fatal([
    'The launcher itself failed: ' + (err && err.message ? err.message : err),
    '',
    'This is a bug. The technical details:',
    String(err && err.stack ? err.stack : err)
  ], 1);
});
