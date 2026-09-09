#!/usr/bin/env node
/* =============================================================================
 * server/start.js — start the server, and make first-run setup unmissable.
 *
 *   node server/start.js                 start in this terminal (Ctrl-C stops)
 *   node server/start.js --background    start detached, logging to a file
 *   node server/start.js --help
 *
 * Every environment variable server.js understands works here unchanged and is
 * passed straight through: KEYS_PORT, KEYS_HOST, KEYS_DATA, KEYS_IDLE_MS,
 * KEYS_TLS_CERT, KEYS_TLS_KEY, KEYS_TRUST_PROXY, KEYS_LOCAL.
 *
 * WHAT THIS ADDS OVER `node server/server.js`
 *
 * 1. On a machine with no accounts yet it repeats the one-time setup token and
 *    the /setup address as the LAST thing on screen, after the server has
 *    settled. Started as a service, or on a chatty terminal, the token
 *    otherwise scrolls past among the startup lines and the warnings — and it
 *    is the single thing a new deployment cannot proceed without.
 *
 * 2. It prints every address the server can actually be reached at, not only
 *    "localhost". This is not decoration: a server bound to 0.0.0.0 prints
 *    "localhost" for itself, and somebody browsing from another machine then
 *    has to work out the right host on their own. Reaching for the wrong
 *    address is what produces the app's "this is not the St. Peter's Keys
 *    server" panel, which reads like a broken install and is not one.
 *
 * 3. It refuses to start a second copy on a port that already answers, and
 *    says which script to run instead, rather than leaving an EADDRINUSE
 *    stack trace to be interpreted.
 *
 * On any run after the first there is nothing to catch, so it does none of
 * that and simply starts the server.
 *
 * WHAT THIS IS NOT: a service manager. It does not restart on crash, rotate
 * logs or survive a reboot. For a machine that must come back up on its own,
 * use the systemd unit in server/README.md — this exists for starting the
 * thing by hand and for the first five minutes of a new deployment.
 * ========================================================================== */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const HERE = __dirname;
const SERVER = path.join(HERE, 'server.js');
const ROOT = path.resolve(HERE, '..');

const { pidFilePath, writePidFile, readPidFile, isOurServer } =
  require('./instances.js');

const argv = process.argv.slice(2);
const WANT_HELP = argv.includes('--help') || argv.includes('-h');
const BACKGROUND = argv.includes('--background') || argv.includes('--detach');

/* Mirrors server.js so the messages here name the same numbers it will use.
 * Kept deliberately dumb — one `||` per variable, no cleverness — because a
 * start script that disagrees with the server about the port is worse than no
 * start script at all. */
const PORT = Number(process.env.KEYS_PORT || 8749);
const DATA_DIR = process.env.KEYS_DATA || path.join(HERE, 'data');
const LOCAL = /^(1|true|yes|on)$/i.test(String(process.env.KEYS_LOCAL || ''));
const TLS = !!(process.env.KEYS_TLS_CERT && process.env.KEYS_TLS_KEY);
const SCHEME = TLS ? 'https' : 'http';
const HOST_REQUESTED = process.env.KEYS_HOST || '';

const LOG_FILE = path.join(os.tmpdir(), 'stpeters-keys-server.log');

const RULE = '─'.repeat(60);

function say(line) { console.log(line === undefined ? '' : line); }

function help() {
  say('');
  say('  node server/start.js               start here, Ctrl-C stops it');
  say('  node server/start.js --background  start detached, log to a file');
  say('');
  say('  Stop it again:   node server/stop.js');
  say('  Who is serving:  node server/whats-serving.js');
  say('');
  say('  All KEYS_* environment variables are passed through. For example:');
  say('      KEYS_PORT=9000 node server/start.js');
  say('');
}

/* ---------------------------------------------------------------------------
 * Is this the first run?
 *
 * Asked of accounts.json, not of the server's output. Scraping stdout for the
 * banner would mean this script quietly stops working the day somebody
 * rewords it — and the failure would be silent, which is the worst kind: the
 * token would print, nobody would notice, and the deployment would look
 * mysteriously stuck. The file is the fact; the banner is a presentation of it.
 * ------------------------------------------------------------------------ */
function hasAccounts() {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'accounts.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.users) && parsed.users.length > 0;
  } catch (e) {
    /* Missing is the ordinary first-run case. Unreadable or corrupt is NOT
     * treated as "no accounts": server.js refuses to start on a corrupt
     * accounts file, on purpose, and this script must not talk anybody into
     * expecting a setup token it will never see. */
    if (e && e.code === 'ENOENT') return false;
    return null;
  }
}

function readTokenFile() {
  try {
    const t = fs.readFileSync(path.join(DATA_DIR, 'setup-token.txt'), 'utf8').trim();
    return t || null;
  } catch (e) {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * Addresses this server can be reached at
 * ------------------------------------------------------------------------ */
function reachableHosts() {
  /* An explicit KEYS_HOST is the only address it will answer on, so listing
   * anything else would be a lie. */
  if (LOCAL) return ['127.0.0.1'];
  if (HOST_REQUESTED && HOST_REQUESTED !== '0.0.0.0' && HOST_REQUESTED !== '::') {
    return [HOST_REQUESTED];
  }

  const out = ['localhost'];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    (ifaces[name] || []).forEach((ni) => {
      if (ni.internal) return;
      if (ni.family !== 'IPv4' && ni.family !== 4) return;
      if (out.indexOf(ni.address) === -1) out.push(ni.address);
    });
  });
  return out;
}

function urlsFor(port) {
  return reachableHosts().map((h) => SCHEME + '://' + h + ':' + port + '/');
}

/* ---------------------------------------------------------------------------
 * Is something already on the port?
 * ------------------------------------------------------------------------ */
function portAnswers(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeoutMs || 1200);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host || '127.0.0.1');
  });
}

/* ---------------------------------------------------------------------------
 * The first-run summary
 * ------------------------------------------------------------------------ */
function firstRunBanner(port, token) {
  const lines = [];
  lines.push('');
  lines.push(RULE);
  lines.push('  FIRST RUN — create the administrator account now');
  lines.push('');
  if (token) {
    lines.push('  Token   ' + token);
  } else {
    lines.push('  Token   (could not read it — see the lines above, or run');
    lines.push('           cat "' + path.join(DATA_DIR, 'setup-token.txt') + '")');
  }
  lines.push('');
  lines.push('  Open one of these and paste the token in:');
  urlsFor(port).forEach((u) => lines.push('      ' + u + 'setup'));
  lines.push('');
  lines.push('  Whoever does this first becomes the administrator, so do it');
  lines.push('  now rather than leaving the address open — that is what the');
  lines.push('  token is for. It stops working the moment the account exists.');
  lines.push(RULE);
  lines.push('');
  return lines.join('\n');
}

function readyBanner(port) {
  const lines = [];
  lines.push('');
  lines.push(RULE);
  lines.push(LOCAL ? '  Ready — desktop copy, this machine only'
                   : '  Ready — sign in at:');
  urlsFor(port).forEach((u) => lines.push('      ' + u));
  if (!LOCAL && !TLS) {
    const remote = reachableHosts().filter((h) => h !== 'localhost');
    if (remote.length) {
      lines.push('');
      lines.push('  Not encrypted. Passwords cross the network in the clear on');
      lines.push('  every address above except localhost.');
    }
  }
  lines.push('');
  lines.push('  Stop it with:  node server/stop.js');
  lines.push(RULE);
  lines.push('');
  return lines.join('\n');
}

/* ========================================================================== */
async function main() {
  if (WANT_HELP) { help(); return 0; }

  if (!fs.existsSync(SERVER)) {
    say('Cannot find ' + SERVER);
    say('start.js has to stay in the server/ folder, next to server.js.');
    return 1;
  }

  /* --- already running? ------------------------------------------------- */
  const existing = readPidFile();
  if (existing && isOurServer(existing.pid)) {
    say('');
    say('The server is already running (process ' + existing.pid + ').');
    if (existing.port) say('Started on port ' + existing.port + '.');
    say('');
    say('  Stop it first:  node server/stop.js');
    say('  Or check it:    node server/whats-serving.js');
    say('');
    return 1;
  }

  const probeHost = (HOST_REQUESTED && HOST_REQUESTED !== '0.0.0.0' &&
                     HOST_REQUESTED !== '::') ? HOST_REQUESTED : '127.0.0.1';
  /* Refusing a busy port is right for the shared server, where the port is
   * chosen deliberately and landing on a different one silently would be
   * worse than stopping. It is WRONG in local mode: there the server walks
   * upward by design, precisely because somebody double-clicking a launcher
   * cannot be asked to go and free a socket. So the guard applies to served
   * mode only, and the walked port is read back from the log afterwards. */
  if (!LOCAL && await portAnswers(PORT, probeHost)) {
    say('');
    say('Something is already answering on ' + probeHost + ':' + PORT + ', so');
    say('the server would not be able to listen there.');
    say('');
    say('  Find out what it is:  node server/whats-serving.js ' + PORT);
    say('  Stop our server:      node server/stop.js');
    say('  Or use another port:  KEYS_PORT=8750 node server/start.js');
    say('');
    return 1;
  }

  /* --- first run? ------------------------------------------------------- */
  /* Local mode has no accounts, ever, and issues no setup token — so there is
   * no such thing as a first run there. Without this guard the missing
   * accounts.json reads as "brand new deployment" and the desktop copy gets a
   * banner promising a token that will never be printed, pointing at a file in
   * server/data that local mode deliberately never creates. Confidently wrong
   * instructions are worse than none. */
  const accounts = LOCAL ? true : hasAccounts();
  const firstRun = !LOCAL && accounts === false;
  if (accounts === null) {
    say('');
    say('WARNING: ' + path.join(DATA_DIR, 'accounts.json') + ' exists but could');
    say('not be read. The server will very likely refuse to start and tell you');
    say('so below. node server/reset-accounts.js is the way back.');
    say('');
  }

  /* --- background ------------------------------------------------------- */
  if (BACKGROUND) {
    const log = fs.openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: process.env,
      detached: true,
      stdio: ['ignore', log, log]
    });
    child.unref();
    fs.closeSync(log);

    /* Give it long enough to fall over on a bad port or a corrupt accounts
     * file, so "started" is not reported for a process that has already gone. */
    await new Promise((r) => setTimeout(r, 1500));

    /* Which port did it ACTUALLY get? In local mode the server walks upward
     * when its port is busy, so the port asked for and the port in use can
     * differ — and then probing KEYS_PORT would report a healthy server as
     * dead. The log is where it says what it landed on. */
    let livePort = PORT;
    try {
      const tail = fs.readFileSync(LOG_FILE, 'utf8').slice(-4000);
      const m = tail.match(/:\/\/[^\s/]+:(\d{2,5})\//g);
      if (m && m.length) {
        const last = m[m.length - 1].match(/:(\d{2,5})\//);
        if (last) livePort = Number(last[1]);
      }
    } catch (e) { /* no log yet; PORT is the best guess */ }

    let up = await portAnswers(livePort, probeHost, 2000);
    if (!up && livePort !== PORT) up = await portAnswers(PORT, probeHost, 1200);
    if (!up) {
      say('');
      say('The server was started in the background but is not answering on');
      say(probeHost + ':' + livePort + '. The reason will be in:');
      say('    ' + LOG_FILE);
      say('');
      return 1;
    }

    writePidFile(child.pid, livePort);
    say('');
    say('Started in the background as process ' + child.pid + '.');
    say('Log:  ' + LOG_FILE);
    if (livePort !== PORT) {
      say('Port ' + PORT + ' was busy, so it is on ' + livePort + '.');
    }
    if (firstRun) say(firstRunBanner(livePort, readTokenFile()));
    else say(readyBanner(livePort));
    return 0;
  }

  /* --- foreground ------------------------------------------------------- */
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe']
  });

  /* Everything the server says is passed through untouched and in order. This
   * script adds to its output; it never replaces or filters it, because the
   * warnings it prints — no TLS, most of all — are not this script's to
   * suppress. */
  let sawToken = null;
  let actualPort = PORT;
  let settled = false;

  const scan = (chunk) => {
    const s = String(chunk);
    /* Belt to accounts.json's braces: if the banner is there, take the token
     * from it, since it is the live value and the file could in principle be a
     * stale leftover. Matches the token's SHAPE, not the word "Token", so a
     * reworded banner still works. */
    const m = s.match(/\b([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})\b/);
    if (m) sawToken = m[1];

    /* The server walks upward if its port is busy, so the port it ENDED on is
     * the one to print. */
    const p = s.match(/:\/\/[^\s/]+:(\d{2,5})\//);
    if (p) actualPort = Number(p[1]);

    if (!settled && /is being served|FIRST-RUN SETUP/.test(s)) {
      settled = true;
      /* After the server's own startup block has finished printing. */
      setTimeout(() => {
        if (firstRun) process.stdout.write(firstRunBanner(actualPort, sawToken || readTokenFile()));
        else process.stdout.write(readyBanner(actualPort));
        writePidFile(child.pid, actualPort);
      }, 250);
    }
  };

  child.stdout.on('data', (c) => { process.stdout.write(c); scan(c); });
  child.stderr.on('data', (c) => { process.stderr.write(c); scan(c); });

  /* Ctrl-C, and a stop.js that signals this wrapper rather than the server,
   * both have to reach the child — otherwise the wrapper exits and leaves an
   * orphaned server holding the port, which is the exact mess this script is
   * meant to prevent. */
  let forwarding = false;
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
    process.on(sig, () => {
      if (forwarding) return;
      forwarding = true;
      try { child.kill(sig === 'SIGHUP' ? 'SIGTERM' : sig); } catch (e) {}
    });
  });

  return await new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      try { require('./instances.js').clearPidFile(child.pid); } catch (e) {}
      if (signal) { say(''); say('Server stopped (' + signal + ').'); resolve(0); }
      else resolve(code === null ? 1 : code);
    });
    child.on('error', (e) => {
      say('Could not start the server: ' + (e && e.message));
      resolve(1);
    });
  });
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('start.js could not finish: ' + (e && e.message));
  process.exit(1);
});
