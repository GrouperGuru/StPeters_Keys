#!/usr/bin/env node
/* =============================================================================
 * server/whats-serving.js — "the app says this is not its server. what is it?"
 *
 *   node server/whats-serving.js                  check the default port
 *   node server/whats-serving.js 8080 80 3000     check these ports too
 *   node server/whats-serving.js http://vm:8749/  check a full address
 *   node server/whats-serving.js 80 --host=keys.example.org
 *                                     ask port 80 as that named site, which is
 *                                     the only way to see what a name-based
 *                                     virtual host would really do
 *
 * WHAT THIS IS FOR
 *
 * The app puts up a panel reading "This is not the St. Peter's Keys server"
 * when the page was handed over by something that then answers 404 to every
 * /api/... request. That panel is right, and it is the app refusing to pretend
 * it can manage accounts when it cannot — but from the outside it looks
 * identical whether the real server is stopped, running on another port, or
 * running perfectly while a SECOND web server answers the address you typed.
 *
 * That last case is the confusing one and it is common on a machine where the
 * folder was once deployed as a plain static site: nginx or Apache is still
 * serving it on port 80, quite happily, and knows nothing about /api.
 *
 * This script asks each address what it is and says which of those it found.
 * It changes nothing. It is safe to run at any time.
 *
 * NOT a security tool: it only talks to addresses you name, and only over
 * plain HTTP(S) with no credentials.
 * ========================================================================== */
'use strict';

const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_PORT = Number(process.env.KEYS_PORT || 8749);
const ROOT = path.resolve(__dirname, '..');

/* ---------------------------------------------------------------------------
 * One request, no throwing. Everything is a result, including a refusal —
 * "nothing is listening" is an answer to the question being asked.
 * ------------------------------------------------------------------------ */
function ask(url, timeoutMs, hostHeader) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      resolve({ url, error: 'not a valid address' });
      return;
    }

    /* A Host header that differs from the address dialled is the whole point
     * of --host: it is how you ask "what would nginx do with a request for
     * keys.example.org?" while connecting to 127.0.0.1. Without it a
     * name-based virtual host answers as its default site and the reply tells
     * you nothing about the site you actually care about. */
    const headers = hostHeader ? { host: hostHeader } : undefined;

    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      headers,
      /* A self-signed certificate is a perfectly normal thing to find here and
       * is not what we are diagnosing. */
      rejectUnauthorized: false,
      timeout: timeoutMs || 4000
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => resolve({
        url,
        status: res.statusCode,
        headers: res.headers,
        body
      }));
    });

    req.on('timeout', () => { req.destroy(); resolve({ url, error: 'timed out' }); });
    req.on('error', (e) => resolve({ url, error: e.code || e.message }));
    req.end();
  });
}

/* Is this our server? Not "does it look like a web server" — does it answer
 * the one route only our server has, in the shape only our server sends?
 * A static host serving a stray file called api/auth/state would give 200 and
 * nonsense; the field check is what makes this positive evidence. */
async function identify(origin, hostHeader) {
  const root = await ask(origin + '/', 0, hostHeader);
  if (root.error) return { kind: 'silent', detail: root.error, root };

  const state = await ask(origin + '/api/auth/state', 0, hostHeader);
  if (!state.error && state.status === 200) {
    let data = null;
    try { data = JSON.parse(state.body); } catch (e) { data = null; }
    if (data && typeof data.mode === 'string' &&
        typeof data.signedIn === 'boolean' &&
        typeof data.hasAccounts === 'boolean') {
      return { kind: 'ours', state: data, root };
    }
    return { kind: 'impostor', detail: 'answered /api/auth/state, but not as the server does', root, state };
  }

  return {
    kind: 'other',
    detail: state.error ? state.error : 'HTTP ' + state.status + ' for /api/auth/state',
    server: root.headers && root.headers.server,
    servesApp: /St\.\s*Peter|id="page-stage"/i.test(root.body || ''),
    rootStatus: root.status,
    root,
    state
  };
}

function describeOurs(origin, st) {
  const lines = [];
  lines.push('  ✓ THIS IS the St. Peter’s Keys server.');
  lines.push('    mode        ' + st.mode + (st.mode === 'local'
    ? '   (the desktop app — no accounts, this machine only)' : ''));
  lines.push('    accounts    ' + (st.hasAccounts ? 'yes' : 'NONE YET — open ' + origin + '/setup'));
  lines.push('    signed in   ' + (st.signedIn ? 'yes, as ' + ((st.user || {}).name || '?') : 'no'));
  if (st.mode !== 'local') {
    lines.push('    encrypted   ' + (st.secure ? 'yes (https)' : 'NO — plain http'));
  }
  lines.push('');
  lines.push('    Use this address: ' + origin + '/');
  return lines.join('\n');
}

function describeOther(origin, info) {
  const lines = [];
  lines.push('  ✗ Something IS answering here, but it is not our server.');
  lines.push('    ' + origin + '/ answered HTTP ' + info.rootStatus +
             ', and /api/auth/state gave ' + info.detail + '.');
  if (info.server) lines.push('    It identifies itself as: ' + info.server);
  if (info.servesApp) {
    lines.push('');
    lines.push('    It is serving THIS FOLDER as plain files — that is why the app');
    lines.push('    loads and then says it is not its server. Almost always nginx,');
    lines.push('    Apache, or an editor’s live-preview left over from when this');
    lines.push('    was a static site.');
    lines.push('');
    lines.push('    Fix it one of two ways:');
    lines.push('      • stop that web server and use the address');
    lines.push('        "node server/server.js" prints, or');
    lines.push('      • keep it and make it a reverse proxy to our server —');
    lines.push('        see server/README.md, which has an nginx example.');
  } else {
    lines.push('');
    lines.push('    It is not serving this app at all — some other site is on this');
    lines.push('    port. Our server needs a port of its own.');
  }
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);

  /* Anything that looks like an address is checked as given; bare numbers are
   * ports on this machine. */
  const targets = [];
  let hostHeader = null;
  for (const a of args) {
    const h = /^--host=(.+)$/.exec(a);
    if (h) {
      hostHeader = h[1];
      continue;
    }
    if (/^https?:\/\//i.test(a)) {
      targets.push(a.replace(/\/+$/, ''));
    } else if (/^\d+$/.test(a)) {
      targets.push('http://127.0.0.1:' + a);
    } else {
      console.log('Ignoring "' + a + '": not a port number or an http address.');
    }
  }
  if (targets.length === 0) {
    targets.push('http://127.0.0.1:' + DEFAULT_PORT);
    /* The ports a second web server actually turns up on. Checked only when
     * the user named nothing, so this never surprises anybody. */
    [80, 8080, 8000, 3000, 5500, 8750].forEach((p) => {
      if (p !== DEFAULT_PORT) targets.push('http://127.0.0.1:' + p);
    });
  }

  console.log('');
  console.log('St. Peter’s Keys — what is answering?');
  console.log('files here: ' + ROOT);
  if (hostHeader) {
    /* Said out loud: a reply that depends on a header you cannot see in the
     * address is otherwise baffling to read back later. */
    console.log('asking as:  Host: ' + hostHeader);
  }
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    console.log('WARNING: no index.html next to server/ — is this the right folder?');
  }
  console.log('');

  let foundOurs = null;
  let foundStatic = null;

  for (const origin of targets) {
    const info = await identify(origin, hostHeader);
    if (info.kind === 'silent') {
      /* Only worth a line when the user asked about it specifically. */
      if (args.length) console.log(origin + '\n  – nothing listening (' + info.detail + ')\n');
      continue;
    }
    console.log(origin);
    if (info.kind === 'ours') {
      console.log(describeOurs(origin, info.state));
      if (!foundOurs) foundOurs = origin;
    } else if (info.kind === 'impostor') {
      console.log('  ✗ Answers /api/auth/state, but not in the shape the server');
      console.log('    sends. Something is sitting in front of it, or another app');
      console.log('    happens to use that path.');
    } else {
      console.log(describeOther(origin, info));
      if (info.servesApp && !foundStatic) foundStatic = origin;
    }
    console.log('');
  }

  console.log('────────────────────────────────────────────────────────────');
  if (foundOurs && foundStatic) {
    console.log('BOTH are running. The app works at');
    console.log('    ' + foundOurs + '/');
    console.log('and the panel you saw came from');
    console.log('    ' + foundStatic + '/');
    console.log('Use the first address, or stop the second server.');
  } else if (foundOurs) {
    console.log('The server is running. Open ' + foundOurs + '/');
    console.log('');
    console.log('If the app still says "this is not the St. Peter’s Keys server",');
    console.log('the address in your browser is not this one. The panel now names');
    console.log('the address it probed — compare it with the line above. From');
    console.log('another machine, replace 127.0.0.1 with this machine’s name or');
    console.log('IP address, and make sure the server was NOT started with');
    console.log('KEYS_HOST=127.0.0.1 (which accepts local connections only).');
  } else if (foundStatic) {
    console.log('Our server is NOT running — but another web server is serving');
    console.log('this folder as plain files, which is exactly what produces that');
    console.log('panel. Start ours with "node server/server.js" and use the');
    console.log('address it prints, or put that other server in front of it as a');
    console.log('reverse proxy (server/README.md has an nginx example).');
  } else {
    console.log('Nothing is answering on any address checked.');
    console.log('Start the server:   node server/server.js');
    console.log('It prints the address to use, and on a fresh machine a one-time');
    console.log('setup token for creating the administrator account.');
    console.log('');
    console.log('Checking a different port or machine:');
    console.log('    node server/whats-serving.js 8080');
    console.log('    node server/whats-serving.js http://the-vm:8749/');
  }
  console.log('');
}

main().catch((e) => {
  console.error('whats-serving.js could not finish: ' + (e && e.message));
  process.exit(1);
});
