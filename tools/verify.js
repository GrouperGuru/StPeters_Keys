#!/usr/bin/env node
/* =============================================================================
 * tools/verify.js — Automated checks for St. Peter's Keys.
 *
 *   node tools/verify.js            run all checks
 *   node tools/verify.js --shots    also write page screenshots to tools/out/
 *   node tools/verify.js --pdf      also export a PDF and check page geometry
 *
 * Requires Playwright. The harness lives outside the app so the app itself
 * stays dependency-free.
 * ========================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');

const PLAYWRIGHT_DIR = process.env.KEYS_PLAYWRIGHT ||
  '/private/tmp/claude-503/-Users-ringalsbe-Desktop-Personal-StPeters-Keys/236b9624-4aa3-41c1-81f1-70a5d7cc31d3/scratchpad/verify/node_modules';
const { chromium } = require(path.join(PLAYWRIGHT_DIR, 'playwright'));

const ROOT = path.resolve(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'index.html');
const OUT = path.join(__dirname, 'out');

const WANT_SHOTS = process.argv.includes('--shots');
const WANT_PDF = process.argv.includes('--pdf');

let pass = 0;
const failures = [];
const warnings = [];

function ok(name, detail) {
  pass++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? '  \x1b[90m' + detail + '\x1b[0m' : ''}`);
}
function fail(name, detail) {
  failures.push({ name, detail });
  console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`);
}
function warn(name, detail) {
  warnings.push({ name, detail });
  console.log(`  \x1b[33m! ${name}\x1b[0m${detail ? '  \x1b[90m' + detail + '\x1b[0m' : ''}`);
}
function check(name, cond, detail) {
  cond ? ok(name, typeof cond === 'string' ? cond : detail) : fail(name, detail);
}
function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/* ---------------------------------------------------------------------------
 * NO SIGN-IN HELPER, AND THAT IS THE POINT.
 *
 * The bulk of this suite runs on file://, which auth.js calls "offline" mode:
 * there is no server to authenticate against, so there is no gate and boot()
 * is called immediately. Nothing to drive, nothing to wait for.
 *
 * The rule the old helper's comment protected still stands and is now enforced
 * in the served suite instead: there is deliberately NO test bypass in the
 * shipped code, and this harness must not add one. The served checks below
 * spawn the real server, walk the real /setup page, and sign in through the
 * real forms and the real API — never by writing a cookie or a session key by
 * hand. A harness that installed a back door would leave the one path every
 * user takes untested on every run.
 * ------------------------------------------------------------------------ */

/* ---------------------------------------------------------------------------
 * Served-mode plumbing.
 *
 * These checks need a REAL server on a REAL port. Ports come from 8780-8799,
 * one per server so a socket left in TIME_WAIT by an earlier server cannot
 * collide with a later one, and every process spawned here is recorded so it
 * can be stopped again. Nothing else on this machine is ever signalled: the
 * harness kills only what it started.
 * ------------------------------------------------------------------------ */
const { spawn } = require('child_process');
const os = require('os');
const http = require('http');

const SERVER_JS = path.join(ROOT, 'server', 'server.js');
const PORT_BASE = 8780;
let nextPort = PORT_BASE;
const spawned = [];          // every child this run created, and nothing else

function startServer(env, opts) {
  /* `opts.port` lets a caller take a socket from a range of its own — the two
   * sections at the end of this file use 8850-8869 — instead of the shared
   * counter below. */
  const port = (opts && opts.port) || nextPort++;
  if (!(opts && opts.port) && port > 8799) {
    throw new Error('ran out of ports in the 8780-8799 range');
  }

  // A fresh KEYS_DATA every time: these checks are about first-run behaviour
  // as much as anything, and an inherited accounts.json would skip it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-verify-'));

  const proc = spawn(process.execPath, [SERVER_JS], {
    env: Object.assign({}, process.env, {
      KEYS_PORT: String(port), KEYS_HOST: '127.0.0.1', KEYS_DATA: dir
    }, env || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });

  const server = {
    proc, dir, port,
    base: 'http://127.0.0.1:' + port,
    log: () => log,
    stopped: false,
    stop() {
      if (this.stopped) return Promise.resolve();
      this.stopped = true;
      // Only ever this PID, and only ever one we spawned ourselves.
      try { proc.kill('SIGTERM'); } catch (e) {}
      return new Promise(r => {
        const done = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} r(); }, 3000);
        proc.on('exit', () => { clearTimeout(done); r(); });
      }).then(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });
    }
  };
  spawned.push(server);
  return server;
}

async function stopAllServers() {
  for (const s of spawned) await s.stop();
}

/** One raw HTTP request, resolving rather than rejecting so a check can assert
 *  on a refusal as easily as on a success. `cookie` is passed explicitly: this
 *  helper holds no jar, so an unauthenticated probe cannot accidentally borrow
 *  a session from a previous one — which is the whole thing several of the
 *  access-control checks below are trying to prove. */
function req(server, method, urlPath, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const headers = Object.assign({}, o.headers || {});
    let body = null;
    if (o.json !== undefined) {
      body = Buffer.from(JSON.stringify(o.json), 'utf8');
      if (headers['Content-Type'] === undefined) {
        headers['Content-Type'] = 'application/json';
      }
      headers['Content-Length'] = body.length;
    }
    if (headers['Content-Type'] === null) delete headers['Content-Type'];
    if (o.cookie) headers['Cookie'] = o.cookie;
    if (o.origin !== null && method !== 'GET' && method !== 'HEAD') {
      headers['Origin'] = o.origin || server.base;
    }

    const r = http.request({
      host: '127.0.0.1', port: server.port, method,
      path: urlPath, headers
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({
          status: res.statusCode, headers: res.headers, text, json,
          cookie: sessionCookieFrom(res.headers['set-cookie'])
        });
      });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message, text: '', json: null }));
    if (body) r.write(body);
    r.end();
  });
}

function sessionCookieFrom(setCookie) {
  if (!setCookie) return null;
  for (const c of setCookie) {
    if (c.startsWith('keys_sid=')) return c.split(';')[0];
  }
  return null;
}

/** The session cookie a browser context is holding, as Playwright describes it
 *  — so its attributes (HttpOnly, SameSite, Secure) can be asserted on, not
 *  only its value. */
async function sessionCookieObj(ctx, base) {
  const all = await ctx.cookies(base);
  return all.filter(c => c.name === 'keys_sid')[0] || null;
}

/** Wait until the server answers its one never-authenticated route. */
async function waitForServer(server, timeoutMs) {
  const until = Date.now() + (timeoutMs || 15000);
  for (;;) {
    const res = await req(server, 'GET', '/api/auth/state');
    if (res.status === 200) return true;
    if (Date.now() > until) return false;
    await new Promise(r => setTimeout(r, 120));
  }
}

/** The whole accounts file, parsed. Read straight off the disk on purpose: the
 *  point of the storage checks is what an attacker with the file would find. */
function readAccountsFile(server) {
  const file = path.join(server.dir, 'accounts.json');
  const raw = fs.readFileSync(file, 'utf8');
  return {
    raw, file,
    mode: fs.statSync(file).mode & 0o777,
    data: JSON.parse(raw)
  };
}

/* ---------------------------------------------------------------------------
 * A SECOND port range, 8850-8869, for the two sections at the end of this file
 * — the wrong-server panel and local mode. Kept apart from 8780-8799 above so
 * that a static file server, a desktop-mode server and the served checks'
 * own sockets cannot collide, and so a socket left in TIME_WAIT by one of
 * them cannot be handed to another. Everything spawned here is recorded and
 * stopped like everything else: only ever our own PIDs.
 * ------------------------------------------------------------------------ */
const EXTRA_PORT_BASE = 8850;
let nextExtraPort = EXTRA_PORT_BASE;
function extraPort() {
  if (nextExtraPort > 8869) {
    throw new Error('ran out of ports in the 8850-8869 range');
  }
  return nextExtraPort++;
}

/** `python3 -m http.server` on the repository root — not a stub, but the exact
 *  misconfiguration reported from the field: something that hands over
 *  index.html and every asset with 200 and then answers 404, in HTML, to every
 *  /api/ path. Bound to loopback so a check cannot publish the repository to
 *  the network on its way past. */
function startStaticServer() {
  const port = extraPort();
  const proc = spawn('python3',
    ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });

  const server = {
    proc, port, dir: null,
    base: 'http://127.0.0.1:' + port,
    log: () => log,
    stopped: false,
    stop() {
      if (this.stopped) return Promise.resolve();
      this.stopped = true;
      try { proc.kill('SIGTERM'); } catch (e) {}
      return new Promise(r => {
        const done = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} r(); }, 3000);
        proc.on('exit', () => { clearTimeout(done); r(); });
      });
    }
  };
  spawned.push(server);
  return server;
}

/** Wait until something answers `GET /` — the static server has no API route
 *  to poll, which is the entire point of it. */
async function waitForStatic(server, timeoutMs) {
  const until = Date.now() + (timeoutMs || 15000);
  for (;;) {
    const res = await req(server, 'GET', '/');
    if (res.status === 200) return true;
    if (Date.now() > until) return false;
    await new Promise(r => setTimeout(r, 120));
  }
}

/** Start the server and wait for it to STOP, reporting how it went. Used for
 *  the local-mode interlock, where the whole assertion is that the process
 *  refuses to run: it is never registered as a long-lived child because it
 *  ends by itself, and it is killed if it somehow does not. */
function startServerExpectingExit(env, timeoutMs) {
  const port = extraPort();
  const proc = spawn(process.execPath, [SERVER_JS], {
    /* No KEYS_DATA and no KEYS_HOST of our own: the refusal has to be decided
     * by what the caller sets, and the data directory must be left at its
     * default so "local mode creates nothing" can be checked afterwards. */
    env: Object.assign({}, process.env,
      { KEYS_PORT: String(port), KEYS_DATA: undefined, KEYS_HOST: undefined },
      env || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });

  return new Promise((resolve) => {
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch (e) {}
    }, timeoutMs || 8000);
    proc.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, log, port, timedOut });
    });
  });
}

/** Every address one of our own processes is listening on, as the operating
 *  system sees it — `127.0.0.1:8858` or `*:8858`. null if lsof is unavailable,
 *  which is a warning rather than a failure: the check that matters is asked a
 *  second way, over TCP. */
function listeningAddresses(pid) {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n')
      .map(l => (l.match(/TCP\s+(\S+)\s+\(LISTEN\)/) || [])[1])
      .filter(Boolean);
  } catch (e) {
    return null;
  }
}

/** Can anything be connected to at host:port? Resolves 'connected', or the
 *  error code ('ECONNREFUSED' when nothing is listening). */
function tcpProbe(host, port, timeoutMs) {
  const net = require('net');
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (e) {}
      resolve(v);
    };
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs || 2000);
    sock.on('connect', () => done('connected'));
    sock.on('timeout', () => done('ETIMEDOUT'));
    sock.on('error', (e) => done(e.code || 'error'));
  });
}

/** This machine's own address on the network — the one an unauthenticated
 *  server on 0.0.0.0 would be reachable at from every other machine, and
 *  therefore the most important value the interlock has to refuse. */
function lanAddress() {
  const nics = os.networkInterfaces();
  for (const name of Object.keys(nics)) {
    for (const a of nics[name] || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * In-page helper: WCAG contrast between an element's text and whatever is
 * actually painted behind it. Walks up for the first non-transparent
 * background, because most chrome elements paint nothing themselves.
 * ------------------------------------------------------------------------ */
const CONTRAST_HELPERS = `
  const __parts = s => (String(s).match(/[\\d.]+/g) || []).map(Number);
  const __rgb   = s => __parts(s).slice(0, 3);
  const __alpha = s => { const p = __parts(s); return p.length > 3 ? p[3] : 1; };
  const __lum = ([r, g, b]) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const __contrast = (fg, bg) => {
    const a = __lum(fg), b = __lum(bg);
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
  };
  const __bgBehind = el => {
    let n = el;
    while (n && n.nodeType === 1) {
      const c = getComputedStyle(n).backgroundColor;
      if (__alpha(c) > 0.01) return __rgb(c);
      n = n.parentElement;
    }
    return [255, 255, 255];
  };
`;

/* ---------------------------------------------------------------------------
 * In-page helper, injected as a string. Measures how far any content escapes
 * its page, with the stage transform and page visibility neutralised so all
 * four pages can be measured in one pass.
 * ------------------------------------------------------------------------ */
const OVERFLOW_PROBE = `(() => {
  const stage = document.getElementById('page-stage');
  const papers = Array.from(document.querySelectorAll('#page-stage .paper'));
  const savedStage = stage ? stage.style.transform : '';
  const saved = papers.map(p => ({
    v: p.style.visibility, t: p.style.transform,
    z: p.style.zIndex, o: p.style.opacity, cls: p.className
  }));
  if (stage) stage.style.transform = 'none';
  papers.forEach(p => {
    p.style.visibility = 'visible';
    p.style.transform = 'none';
    p.style.opacity = '1';
    p.classList.remove('is-hidden');
  });

  const EPS = 1.0;
  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      s += '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.');
    }
    const b = el.getAttribute && el.getAttribute('data-bind');
    if (b) s += '[data-bind="' + b + '"]';
    const iso = el.getAttribute && el.getAttribute('data-iso');
    if (iso) s += '[data-iso="' + iso + '"]';
    return s;
  };

  const report = papers.map(p => {
    const pr = p.getBoundingClientRect();
    const flow = p.querySelector('.paper-flow');
    const fr = flow ? flow.getBoundingClientRect() : pr;
    let worst = 0, worstSel = null, worstEdge = null;
    let flowWorst = 0, flowSel = null;

    p.querySelectorAll('.paper-flow *').forEach(el => {
      if (el.classList && el.classList.contains('paper-shade')) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;

      const edges = {
        bottom: r.bottom - pr.bottom, right: r.right - pr.right,
        top: pr.top - r.top, left: pr.left - r.left
      };
      for (const k in edges) {
        if (edges[k] > worst) { worst = edges[k]; worstSel = describe(el); worstEdge = k; }
      }
      const fEdges = {
        bottom: r.bottom - fr.bottom, right: r.right - fr.right,
        top: fr.top - r.top, left: fr.left - r.left
      };
      for (const k in fEdges) {
        if (fEdges[k] > flowWorst) { flowWorst = fEdges[k]; flowSel = describe(el); }
      }
    });

    // Clipped content: scroll extent beyond the client box, but ONLY on
    // elements that actually clip. On an overflow:visible element the overflow
    // is still rendered (a tall glyph's descender routinely pushes
    // scrollHeight past clientHeight), so flagging those is a false positive.
    let clipped = [];
    p.querySelectorAll('.paper-flow, [data-fit], .fit, .fit-inner, .cal-cell, .slip')
      .forEach(el => {
        const cs = getComputedStyle(el);
        const clipsY = cs.overflowY !== 'visible';
        const clipsX = cs.overflowX !== 'visible';
        if (!clipsY && !clipsX) return;
        const dy = clipsY ? el.scrollHeight - el.clientHeight : 0;
        const dx = clipsX ? el.scrollWidth - el.clientWidth : 0;
        if (dy > EPS || dx > EPS) clipped.push({ sel: describe(el), dy, dx });
      });

    return {
      page: Number(p.getAttribute('data-page')),
      orientation: p.getAttribute('data-orientation'),
      w: Math.round(pr.width), h: Math.round(pr.height),
      worst: +worst.toFixed(2), worstSel, worstEdge,
      flowWorst: +flowWorst.toFixed(2), flowSel,
      clipped: clipped.slice(0, 6),
      fitOverflowing: p.querySelectorAll('.is-overflowing').length +
                      (p.classList.contains('is-overflowing') ? 1 : 0)
    };
  });

  if (stage) stage.style.transform = savedStage;
  papers.forEach((p, i) => {
    p.style.visibility = saved[i].v; p.style.transform = saved[i].t;
    p.style.zIndex = saved[i].z; p.style.opacity = saved[i].o;
    p.className = saved[i].cls;
  });
  return report;
})()`;

async function main() {
  if (WANT_SHOTS || WANT_PDF) fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(e.message));

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  /* file:// is offline mode: no server, no accounts, no gate. auth.js calls
   * boot() straight away, so the app is simply here. Everything to do with
   * accounts is exercised against the real server in its own sections at the
   * end of this file. */

  /* ---------------------------------------------------------------- boot -- */
  section('Boot');
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('\n      '));
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 6).join('\n      '));

  const modules = await page.evaluate(() => {
    const K = window.Keys || {};
    return {
      names: Object.keys(K),
      missing: ['State', 'Fit', 'Flip', 'Calendar', 'Slips', 'Render', 'Editor', 'App']
        .filter(n => !K[n])
    };
  });
  check('all 8 modules registered on window.Keys', modules.missing.length === 0,
    'missing: ' + modules.missing.join(', '));

  const counts = await page.evaluate(() => ({
    papers: document.querySelectorAll('#page-stage .paper').length,
    sections: document.querySelectorAll('#editor-scroll .ed-section').length,
    rt: document.querySelectorAll('#editor-scroll .rt[data-path]').length,
    thumbs: document.querySelectorAll(
      '#thumb-rail .thumb:not(.thumb--add)').length,
    addPageBtn: document.querySelectorAll('#thumb-rail .thumb--add').length,
    landscape: document.querySelectorAll('#page-stage .paper[data-orientation="landscape"]').length
  }));
  check('4 pages rendered', counts.papers === 4, 'got ' + counts.papers);
  check('4 editor sections', counts.sections === 4, 'got ' + counts.sections);
  check('page 4 is landscape', counts.landscape === 1, 'got ' + counts.landscape);
  check('thumbnail rail built', counts.thumbs === 4, 'got ' + counts.thumbs);
  check('the rail offers an add-page shortcut', counts.addPageBtn === 1,
    'got ' + counts.addPageBtn);

  const railLabels = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#thumb-rail .thumb')];
    return items.map(t => {
      const lab = t.querySelector('.thumb-label');
      const cs = getComputedStyle(lab);
      return {
        text: lab.textContent.trim(),
        title: t.getAttribute('title'),
        // scrollWidth > clientWidth means the caption is being cut off.
        truncated: lab.scrollWidth > lab.clientWidth + 1,
        overlapsNext: false,
        right: t.getBoundingClientRect().right,
        left: t.getBoundingClientRect().left
      };
    });
  });
  check('the announcements page is captioned "Announcements"',
    railLabels[1] && railLabels[1].text === 'Announcements',
    'got "' + (railLabels[1] || {}).text + '"');
  check('no rail caption is truncated',
    railLabels.every(l => !l.truncated),
    JSON.stringify(railLabels.filter(l => l.truncated).map(l => l.text)));
  check('the caption matches the thumbnail tooltip',
    railLabels[1] && railLabels[1].title === 'Announcements',
    `label="${(railLabels[1] || {}).text}" title="${(railLabels[1] || {}).title}"`);
  ok('editor bound fields', counts.rt + ' rich-text fields');

  /* --------------------------------------------------------- default view-- */
  section('Default view');
  const collapsed = await page.evaluate(() => {
    const secs = Array.from(document.querySelectorAll('#editor-scroll .ed-section'));
    return {
      total: secs.length,
      open: secs.filter(s => s.classList.contains('is-open'))
        .map(s => s.getAttribute('data-section')),
      ariaExpanded: secs.map(s => {
        const h = s.querySelector('.ed-head');
        return h ? h.getAttribute('aria-expanded') : null;
      }),
      // A collapsed body must genuinely be out of the layout and tab order.
      bodiesVisible: secs.filter(s => {
        const b = s.querySelector('.ed-body');
        return b && getComputedStyle(b).display !== 'none';
      }).length
    };
  });
  check('every editor section starts collapsed', collapsed.open.length === 0,
    'open: ' + collapsed.open.join(', '));
  check('collapsed sections report aria-expanded=false',
    collapsed.ariaExpanded.every(v => v === 'false'),
    JSON.stringify(collapsed.ariaExpanded));
  check('collapsed section bodies are not rendered', collapsed.bodiesVisible === 0,
    collapsed.bodiesVisible + ' visible');

  const opened = await page.evaluate(async () => {
    const sec = document.querySelector('#editor-scroll .ed-section[data-section="page2"]');
    sec.querySelector('.ed-head').click();
    window.Keys.State.set('masthead.motto', 'PERSISTED MOTTO');
    window.Keys.State.autosave();
    await new Promise(r => setTimeout(r, 200));
    return sec.classList.contains('is-open');
  });
  check('a section opens when its header is clicked', opened === true);

  // A reload restores the CONTENT but must return to the collapsed view.
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);
  const reloaded = await page.evaluate(() => ({
    open: Array.from(document.querySelectorAll('#editor-scroll .ed-section'))
      .filter(s => s.classList.contains('is-open'))
      .map(s => s.getAttribute('data-section')),
    motto: window.Keys.State.get('masthead.motto')
  }));
  check('sections are collapsed again after a reload', reloaded.open.length === 0,
    'open: ' + reloaded.open.join(', '));
  check('a reload still restores the saved content',
    reloaded.motto === 'PERSISTED MOTTO', 'motto=' + reloaded.motto);

  // Opening a section must survive a structural change (add/remove a row).
  const keptOpen = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 320));
    const sec = document.querySelector('#editor-scroll .ed-section[data-section="page1"]');
    sec.querySelector('.ed-head').click();
    await wait();
    document.querySelector(
      '[data-act="list-add"][data-list="thisWeek.rows"]').click();
    await wait();
    const now = document.querySelector(
      '#editor-scroll .ed-section[data-section="page1"]');
    return {
      stillOpen: now.classList.contains('is-open'),
      others: Array.from(document.querySelectorAll('#editor-scroll .ed-section'))
        .filter(s => s.classList.contains('is-open'))
        .map(s => s.getAttribute('data-section'))
    };
  });
  check('an open section stays open across a structural change',
    keptOpen.stillOpen === true && keptOpen.others.length === 1,
    'open: ' + keptOpen.others.join(', '));

  // A clean slate for the theme checks below: no saved document, no saved
  // theme choice. Nothing account-shaped lives in localStorage any more.
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);

  /* ---------------------------------------------------------------- theme-- */
  section('Light / dark theme');
  const themeInit = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    hasAttr: document.documentElement.hasAttribute('data-theme'),
    btn: !!document.querySelector('[data-act="theme"]')
  }));
  check('a theme is resolved on <html> before the app boots',
    themeInit.hasAttr && /^(light|dark)$/.test(themeInit.attr || ''),
    'data-theme=' + themeInit.attr);
  check('the toggle button exists', themeInit.btn === true);

  const themeToggle = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 240));
    const key = window.Keys.App.THEME_KEY;
    const btn = document.querySelector('[data-act="theme"]');
    const read = () => {
      const paper = document.querySelector('#page-stage .paper');
      return {
        theme: document.documentElement.getAttribute('data-theme'),
        rail: getComputedStyle(document.getElementById('editor-pane')).backgroundColor,
        bar: getComputedStyle(document.getElementById('toolbar')).backgroundColor,
        paper: getComputedStyle(paper).backgroundColor,
        paperInk: getComputedStyle(paper).color,
        label: btn.getAttribute('aria-label'),
        pressed: btn.getAttribute('aria-pressed'),
        moon: getComputedStyle(btn.querySelector('.tb-ico-moon')).display,
        sun: getComputedStyle(btn.querySelector('.tb-ico-sun')).display,
        stored: localStorage.getItem(key)
      };
    };
    window.Keys.App.applyTheme('light', true); await wait();
    const light = read();
    btn.click(); await wait();
    const dark = read();
    btn.click(); await wait();
    const back = read();
    return { light, dark, back };
  });

  const { light: lt, dark: dk, back: bk } = themeToggle;
  check('the button toggles between the two themes',
    lt.theme === 'light' && dk.theme === 'dark' && bk.theme === 'light',
    `${lt.theme} -> ${dk.theme} -> ${bk.theme}`);
  check('the chrome actually repaints in dark',
    lt.rail !== dk.rail && lt.bar !== dk.bar,
    `rail ${lt.rail} vs ${dk.rail}`);
  check('the paper stays white with black ink in both themes',
    lt.paper === dk.paper && /^rgb\(255,\s*255,\s*255\)$/.test(dk.paper) &&
    lt.paperInk === dk.paperInk,
    `paper light=${lt.paper} dark=${dk.paper}; ink ${lt.paperInk}/${dk.paperInk}`);
  check('the icon shows the theme the button switches to',
    lt.moon !== 'none' && lt.sun === 'none' &&
    dk.sun !== 'none' && dk.moon === 'none',
    `light moon=${lt.moon} sun=${lt.sun} | dark moon=${dk.moon} sun=${dk.sun}`);
  check('the accessible label names the action, not the state',
    /switch to dark/i.test(lt.label) && /switch to light/i.test(dk.label),
    `light="${lt.label}" dark="${dk.label}"`);
  check('the theme button is not a stuck pressed toggle',
    lt.pressed === null && dk.pressed === null,
    `aria-pressed light=${lt.pressed} dark=${dk.pressed}`);
  check('the choice is persisted', dk.stored === 'dark' && bk.stored === 'light',
    `dark=${dk.stored} back=${bk.stored}`);

  /* Pressed toolbar buttons in dark mode.
   *
   * The zoom button reads "Fit" and is pressed by default, so its label is on
   * screen constantly — it was rendering as near-black navy on dark navy and
   * only became legible on hover. Measured, not eyeballed: a pressed control
   * has to clear AA at rest, and must not depend on hover to be readable. */
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => window.Keys.App.applyTheme(t, false), theme);
    await page.waitForTimeout(200);

    const rest = await page.evaluate(`(() => {${CONTRAST_HELPERS}
      const label = document.getElementById('zoom-label');
      const btn = document.querySelector('[data-act="zoom-fit"]');
      // Bold is only pressed when bold is on at the caret, so force the state
      // to measure the style rather than waiting for the right selection.
      const bold = document.querySelector('#format-group .tb-btn[data-fmt="bold"]');
      const wasBold = bold.getAttribute('aria-pressed');
      bold.setAttribute('aria-pressed', 'true');
      const boldRatio = __contrast(__rgb(getComputedStyle(bold).color), __bgBehind(bold));
      bold.setAttribute('aria-pressed', wasBold == null ? 'false' : wasBold);
      return {
        pressed: btn.getAttribute('aria-pressed'),
        text: label.textContent.trim(),
        color: getComputedStyle(label).color,
        ratio: __contrast(__rgb(getComputedStyle(label).color), __bgBehind(label)),
        boldRatio: boldRatio
      };
    })()`);

    // Same measurement with the pointer over the button.
    await page.hover('[data-act="zoom-fit"]');
    await page.waitForTimeout(150);
    const hovered = await page.evaluate(`(() => {${CONTRAST_HELPERS}
      const label = document.getElementById('zoom-label');
      return {
        color: getComputedStyle(label).color,
        ratio: __contrast(__rgb(getComputedStyle(label).color), __bgBehind(label))
      };
    })()`);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(100);

    check(`[${theme}] the zoom button is pressed and reads "Fit"`,
      rest.pressed === 'true' && rest.text === 'Fit',
      `pressed=${rest.pressed} text="${rest.text}"`);
    check(`[${theme}] the "Fit" label clears AA contrast at rest`,
      rest.ratio >= 4.5,
      `ratio=${rest.ratio.toFixed(2)}:1 color=${rest.color}`);
    check(`[${theme}] "Fit" is no darker at rest than on hover`,
      rest.ratio >= hovered.ratio - 0.05,
      `rest=${rest.ratio.toFixed(2)} (${rest.color}) hover=${hovered.ratio.toFixed(2)} (${hovered.color})`);
    check(`[${theme}] a pressed formatting button is legible too`,
      rest.boldRatio >= 4.5, `ratio=${rest.boldRatio.toFixed(2)}:1`);
  }

  await page.evaluate(() => { window.Keys.App.applyTheme('dark', true); });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
  const themeAfterReload = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    rail: getComputedStyle(document.getElementById('editor-pane')).backgroundColor
  }));
  check('the theme survives a reload', themeAfterReload.theme === 'dark',
    'got ' + themeAfterReload.theme);

  // With no saved choice, follow the OS.
  const sysCtx = await browser.newContext({
    viewport: { width: 1400, height: 950 }, colorScheme: 'dark'
  });
  const sysPage = await sysCtx.newPage();
  await sysPage.goto(URL, { waitUntil: 'load' });
  await sysPage.waitForTimeout(700);
  const sysPick = await sysPage.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    errors: 0
  }));
  check('with no saved choice the OS preference is followed',
    sysPick.theme === 'dark', 'got ' + sysPick.theme);
  // An explicit Light choice must beat a dark OS.
  const sysOverride = await sysPage.evaluate(async () => {
    window.Keys.App.applyTheme('light', true);
    await new Promise(r => setTimeout(r, 200));
    return document.documentElement.getAttribute('data-theme');
  });
  await sysPage.reload({ waitUntil: 'load' });
  await sysPage.waitForTimeout(700);
  const sysOverrideKept = await sysPage.evaluate(() =>
    document.documentElement.getAttribute('data-theme'));
  check('an explicit Light choice beats a dark OS, even after reload',
    sysOverride === 'light' && sysOverrideKept === 'light',
    `immediate=${sysOverride} afterReload=${sysOverrideKept}`);
  await sysCtx.close();

  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);

  /* -------------------------------------------------- sticky rail headers -- */
  section('Section titles stay put while the rail scrolls');
  const stickyHead = await page.evaluate(`(async () => {${CONTRAST_HELPERS}
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const scroller = document.getElementById('editor-scroll');
    const sections = [...document.querySelectorAll('#editor-scroll .ed-section')];
    sections.forEach(s => s.classList.remove('is-open'));
    const sec = sections[0];
    sec.classList.add('is-open');
    const head = sec.querySelector('.ed-head');
    const closedHead = sections[1].querySelector('.ed-head');

    // .ed-head transitions its background, and getComputedStyle mid-transition
    // reports the START value — measuring the opacity immediately would read
    // the transparent closed-state colour and be wrong about it.
    await wait(400);

    // Force layout, then measure without smooth scrolling in the way.
    void scroller.offsetHeight;
    const prevBehavior = scroller.style.scrollBehavior;
    scroller.style.scrollBehavior = 'auto';

    const portTop = scroller.getBoundingClientRect().top;
    const scrollable = scroller.scrollHeight - scroller.clientHeight;
    const restTop = head.getBoundingClientRect().top;

    const distance = Math.min(320, scrollable);
    scroller.scrollTop = distance;
    void scroller.offsetHeight;
    const pinned = head.getBoundingClientRect();
    const bg = getComputedStyle(head).backgroundColor;

    // All the way down: the header must leave with its own section rather
    // than pinning to the top of the whole rail forever.
    scroller.scrollTop = scrollable;
    void scroller.offsetHeight;
    const atEnd = head.getBoundingClientRect();
    const secAtEnd = sec.getBoundingClientRect();

    scroller.scrollTop = 0;
    scroller.style.scrollBehavior = prevBehavior;

    return {
      scrollable,
      distance,
      portTop,
      restTop,
      pinnedTop: pinned.top,
      pinnedBottom: pinned.bottom,
      headBg: bg,
      headBgAlpha: __alpha(bg),
      position: getComputedStyle(head).position,
      closedPosition: getComputedStyle(closedHead).position,
      sectionOverflow: getComputedStyle(sec).overflow,
      atEndTop: atEnd.top,
      atEndBottom: atEnd.bottom,
      secBottomAtEnd: secAtEnd.bottom,
      secTopAtEnd: secAtEnd.top
    };
  })()`);

  check('the rail actually scrolls with a section open',
    stickyHead.scrollable > 120, 'scrollable=' + stickyHead.scrollable);
  check('an open section header is sticky',
    stickyHead.position === 'sticky', 'position=' + stickyHead.position);
  // The clip that used to be on .ed-section would silently kill sticky.
  check('.ed-section does not trap the header in its own scrollport',
    stickyHead.sectionOverflow === 'visible',
    'overflow=' + stickyHead.sectionOverflow);
  check('the header pins to the top of the rail once scrolled past',
    Math.abs(stickyHead.pinnedTop - stickyHead.portTop) <= 1.5,
    `head=${stickyHead.pinnedTop.toFixed(1)} port=${stickyHead.portTop.toFixed(1)}`);
  // Without sticky it would have travelled up by the full scroll distance.
  check('it would otherwise have scrolled off the top',
    stickyHead.restTop - stickyHead.distance < stickyHead.portTop - 1,
    `rest=${stickyHead.restTop.toFixed(1)} - ${stickyHead.distance} < port=${stickyHead.portTop.toFixed(1)}`);
  check('the pinned header is fully opaque, so fields cannot show through',
    stickyHead.headBgAlpha >= 0.99, 'background=' + stickyHead.headBg);
  check('the header leaves with its own section, not with the rail',
    stickyHead.atEndBottom <= stickyHead.secBottomAtEnd + 1.5,
    `head bottom=${stickyHead.atEndBottom.toFixed(1)} section bottom=${stickyHead.secBottomAtEnd.toFixed(1)}`);
  check('a collapsed section header is left alone',
    stickyHead.closedPosition !== 'sticky',
    'position=' + stickyHead.closedPosition);

  // A jump-to-field must not park the field underneath the pinned header.
  const jumpClearance = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const scroller = document.getElementById('editor-scroll');
    scroller.scrollTop = 0;
    document.querySelectorAll('#editor-scroll .ed-section')
      .forEach(s => s.classList.remove('is-open'));
    await wait(120);
    const el = window.Keys.Editor.focusPath('articles.page1.0.body');
    await wait(900);                       // smooth scroll has to finish
    const head = el.closest('.ed-section').querySelector('.ed-head');
    return {
      found: !!el,
      fieldTop: el.getBoundingClientRect().top,
      headBottom: head.getBoundingClientRect().bottom
    };
  });
  check('jumping to a field leaves it clear of the pinned header',
    jumpClearance.found && jumpClearance.fieldTop >= jumpClearance.headBottom - 1,
    `field top=${(jumpClearance.fieldTop || 0).toFixed(1)} header bottom=${(jumpClearance.headBottom || 0).toFixed(1)}`);

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);

  /* ------------------------------------------------------------ bindings -- */
  section('Editor ↔ preview binding');
  const orphans = await page.evaluate(() => {
    const paths = new Set(Array.from(
      document.querySelectorAll('#editor-scroll [data-path]')).map(e => e.getAttribute('data-path')));
    const binds = new Set(Array.from(
      document.querySelectorAll('#page-stage [data-bind]')).map(e => e.getAttribute('data-bind')));
    // Derived regions (SPEC section 2): no value is pushed to them, but they
    // name a field that clicking them must reach.
    const edits = new Set(Array.from(
      document.querySelectorAll('#page-stage [data-edits]')).map(e => e.getAttribute('data-edits')));
    const bindNoField = [...binds, ...edits].filter(b => !paths.has(b));
    // Controls that steer rendering rather than supplying rendered text have
    // no preview counterpart by design.
    // A field is "reachable" if some preview region either displays it
    // (data-bind) or points at it (data-edits).
    const fieldNoBind = [...paths].filter(p => !binds.has(p) && !edits.has(p) &&
      // calendar.year has no preview region of its own; the month/year title
      // points at calendar.month, and the two selects sit side by side.
      !/^calendar\.year$/.test(p) &&
      !/^slips\.\d+\.(nameRow|total|column|height|students)$/.test(p) &&
      !/^slips\.\d+\.fields\.\d+\.kind$/.test(p) &&
      // After School weekday state: blank rule vs XXX. Steers how the cell is
      // drawn rather than supplying text, so it has no [data-bind] twin.
      !/^slips\.\d+\.days\.\d+$/.test(p));
    return { bindNoField, fieldNoBind };
  });
  check('every preview binding has an editor field',
    orphans.bindNoField.length === 0,
    'unbound: ' + orphans.bindNoField.slice(0, 8).join(', '));
  check('every editor field reaches the preview',
    orphans.fieldNoBind.length === 0,
    'no preview target: ' + orphans.fieldNoBind.slice(0, 8).join(', '));

  const live = await page.evaluate(async () => {
    const el = document.querySelector('#editor-scroll .rt[data-path="masthead.motto"]');
    el.focus();
    el.innerHTML = 'LIVE BINDING TEST';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    const out = document.querySelector('#page-stage [data-bind="masthead.motto"]');
    const stateVal = window.Keys.State.get('masthead.motto');
    return { preview: out ? out.innerHTML : null, stateVal };
  });
  check('typing updates the preview', live.preview === 'LIVE BINDING TEST', 'got ' + live.preview);
  check('typing updates state', live.stateVal === 'LIVE BINDING TEST', 'got ' + live.stateVal);

  /* ------------------------------------------------------------- overflow-- */
  section('Overflow (requirement: nothing may run off a page)');
  await page.evaluate(() => window.Keys.Fit.refitAll({ force: true }));
  await page.waitForTimeout(400);
  const of = await page.evaluate(OVERFLOW_PROBE);

  for (const r of of) {
    const label = `page ${r.page} (${r.orientation} ${r.w}×${r.h})`;
    if (r.worst > 1.0) {
      fail(`${label} content stays inside the sheet`,
        `escapes ${r.worst}px past the ${r.worstEdge} edge — ${r.worstSel}`);
    } else {
      ok(`${label} content stays inside the sheet`);
    }
    if (r.clipped.length) {
      fail(`${label} nothing is clipped`,
        r.clipped.map(c => `${c.sel} overflows by ${c.dy.toFixed(1)}×${c.dx.toFixed(1)}px`).join('\n      '));
    } else {
      ok(`${label} nothing is clipped`);
    }
    if (r.flowWorst > 1.0) {
      warn(`${label} content within the print margin`,
        `${r.flowWorst}px into the margin — ${r.flowSel}`);
    }
    if (r.fitOverflowing) {
      warn(`${label} auto-fit at its floor`,
        `${r.fitOverflowing} box(es) still tight at minimum size`);
    }
  }

  const expectedSizes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#page-stage .paper')).map(p => ({
      page: Number(p.getAttribute('data-page')),
      o: p.getAttribute('data-orientation'),
      w: p.offsetWidth, h: p.offsetHeight
    })));
  for (const s of expectedSizes) {
    const wantW = s.o === 'landscape' ? 1056 : 816;
    const wantH = s.o === 'landscape' ? 816 : 1056;
    check(`page ${s.page} is letter ${s.o} (${wantW}×${wantH})`,
      Math.abs(s.w - wantW) <= 2 && Math.abs(s.h - wantH) <= 2,
      `got ${s.w}×${s.h}`);
  }

  /* ------------------------------------------------------- overflow stress--
   * The seeded issue fitting is necessary but not sufficient. Requirement:
   * "no fields overflow off the page" — so abuse every fittable region with
   * far more text than any real issue would carry and assert the guarantee
   * still holds.
   * ---------------------------------------------------------------------- */
  const floodScript = (mult, withLongWord) => `(() => {
    const S = window.Keys.State;
    const SENTENCE = 'The quick brown fox jumped over the lazy dog and kept ' +
      'running all the way to the end of the very long sentence. ';
    const LOREM = SENTENCE.repeat(${mult});
    const LONGWORD = ${withLongWord} ? ('Unbreakable' + 'x'.repeat(180)) : '';
    const join = (a, b) => b ? (a + '<br>' + b) : a;

    S.doc.thisWeek.rows.forEach(r => { r.date = '99/99'; r.event = join(LOREM, LONGWORD); });
    S.doc.lookingAhead.rows.forEach(r => { r.event = LOREM; });
    if (LONGWORD) S.doc.lookingAhead.note = LONGWORD;
    S.doc.masthead.title = 'ST. PETER\\u2019S KEYS' + (LONGWORD ? ' ' + LONGWORD : '');
    S.doc.masthead.schoolInfo = LOREM;
    S.doc.classroom.verse = LOREM;
    /* Modern-only regions. Contemporary never renders these, so flooding them
     * unconditionally costs it nothing and means one flood covers both.
     *
     * HEADINGS get ONE long sentence, not mult of them — the same treatment
     * masthead.title gets above. Tier A's contract is "a realistically heavy
     * issue must fit exactly", and a 340-character HEADING set at 20pt in a
     * 2in column is not a heavy issue, it is a different abuse. Tier B is
     * where these get the unbreakable token instead. */
    S.doc.masthead.volume = LONGWORD || SENTENCE;
    S.doc.masthead.contactHeading = LONGWORD || SENTENCE;
    S.doc.intro.heading = LONGWORD || SENTENCE;
    S.doc.intro.body = '<p>' + LOREM + LOREM + '</p>' +
      (LONGWORD ? '<p>' + LONGWORD + '</p>' : '');
    S.doc.bible.heading = LONGWORD || SENTENCE;
    S.doc.bible.body = '<p>' + LOREM + '</p>';
    S.doc.footer.site = LONGWORD || SENTENCE;
    S.doc.classroom.body = '<p>' + LOREM + LOREM + '</p>' +
      (LONGWORD ? '<p>' + LONGWORD + '</p>' : '');
    S.doc.articles.page1.forEach(a => { a.body = '<p>' + LOREM + LOREM + '</p>'; });
    S.doc.articles.pages.forEach(pg =>
      pg.forEach(a => { a.body = '<p>' + LOREM + LOREM + '</p>'; }));
    Object.keys(S.doc.calendar.days).forEach(k => {
      S.doc.calendar.days[k] = join(LOREM, LONGWORD);
    });
    S.doc.slips.forEach(sl => {
      if (sl.heading) sl.heading = LOREM;
      if (sl.body) sl.body = '<p>' + LOREM + '</p>';
      if (sl.footer) sl.footer = LOREM;
      if (sl.text) sl.text = LOREM;
      if (sl.fields) sl.fields.forEach(f => { f.label = LONGWORD || LOREM; });
    });
    return true;
  })()`;

  /** Reset to the seeded issue, blow every fittable region up by `mult`, and
   *  measure. `template` selects the layout to stress; it has to be applied
   *  AFTER the reset, because replace() restores the default template too. */
  async function flood(mult, withLongWord, template) {
    await page.evaluate(t => window.Keys.App.structuralChange(function () {
      window.Keys.State.replace(window.Keys.State.defaultDoc());
      if (t) window.Keys.State.setTemplate(t);
    }), template || null);
    await page.evaluate(floodScript(mult, withLongWord));
    await page.evaluate(() => window.Keys.App.structuralChange(null));
    await page.waitForTimeout(700);
    await page.evaluate(() => window.Keys.Fit.refitAll({ force: true }));
    await page.waitForTimeout(350);
    return page.evaluate(OVERFLOW_PROBE);
  }

  /* Tier A — a realistically heavy issue (roughly 3x the reference wordcount,
   * i.e. a very busy week). This MUST fit completely: no clipping at all. */
  section('Overflow stress A — a very heavy issue (3x text, must fit exactly)');
  const heavy = await flood(3, false);
  for (const r of heavy) {
    check(`page ${r.page}: nothing escapes the sheet`, r.worst <= 1.0,
      `escapes ${r.worst}px past the ${r.worstEdge} edge — ${r.worstSel}`);
    check(`page ${r.page}: nothing is clipped`, r.clipped.length === 0,
      r.clipped.map(c => `${c.sel} by ${c.dy.toFixed(1)}×${c.dx.toFixed(1)}px`).join('\n      '));
  }

  /* Tier B — deliberately impossible: 12x text PLUS a 190-character
   * unbreakable token in every field. No font-size reduction can make an
   * atomic token narrower than its own glyphs, so the guarantee here is
   * graceful degradation, not a perfect fit:
   *   - nothing may escape SIDEWAYS (that is always a fixable CSS bug),
   *   - nothing may cross the trim edge (`.paper` clips),
   *   - the author must be warned on screen.
   * Vertical clipping inside a bordered box is the accepted outcome. */
  section('Overflow stress B — impossible content (12x + unbreakable tokens)');
  const absurd = await flood(12, true);
  for (const r of absurd) {
    const sideways = r.worstEdge === 'left' || r.worstEdge === 'right';
    check(`page ${r.page}: never escapes sideways`,
      !(sideways && r.worst > 1.0),
      `escapes ${r.worst}px past the ${r.worstEdge} edge — ${r.worstSel}`);
    const hClip = r.clipped.filter(c => c.dx > 1.0);
    check(`page ${r.page}: no horizontal clipping`, hClip.length === 0,
      hClip.map(c => `${c.sel} by ${c.dx.toFixed(1)}px wide`).join('\n      '));
  }
  const flagged = absurd.reduce((n, r) => n + r.fitOverflowing, 0);
  check('impossible content is flagged to the author on screen', flagged > 0,
    flagged + ' box(es) carry the .is-overflowing warning');
  ok('vertical clipping inside bordered boxes',
    'accepted for impossible content; ink never crosses the trim');

  // Restore the pristine document for the remaining tests.
  await page.evaluate(() => {
    window.Keys.App.structuralChange(function () {
      window.Keys.State.replace(window.Keys.State.defaultDoc());
    });
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.Keys.Fit.refitAll({ force: true }));
  await page.waitForTimeout(300);
  const restoredOk = await page.evaluate(() => {
    const t = document.querySelector('#page-stage [data-bind="masthead.title"]');
    return t ? t.textContent.trim() : null;
  });
  check('document restores to the seeded issue after the stress pass',
    /^ST\. PETER/i.test(restoredOk || ''), 'got ' + JSON.stringify(restoredOk));

  /* ------------------------------------------------------------ templates --
   * The template changes the front and announcement sheets ONLY. Everything
   * here is about the two invariants that make that safe: the shared sheets
   * must be untouched, and no content may be lost or altered by switching.
   * ---------------------------------------------------------------------- */
  section('Templates — the dropdown');

  const tplUi = await page.evaluate(() => {
    const sel = document.getElementById('template-select');
    if (!sel) return { missing: true };
    const bar = document.getElementById('toolbar');
    const kids = [...bar.children];
    const idx = el => kids.indexOf(el.closest('.tb-group, .tb-sep, .tb-spacer'));
    return {
      options: [...sel.options].map(o => ({ v: o.value, t: o.textContent.trim() })),
      value: sel.value,
      stateValue: window.Keys.State.template(),
      // Position: after the formatting group, before the theme button.
      afterFormat: idx(sel) > idx(document.getElementById('format-group')),
      beforeTheme: idx(sel) < idx(document.querySelector('[data-act="theme"]')),
      labelled: !!(sel.getAttribute('aria-label') || '').trim(),
      inToolbar: !!sel.closest('#toolbar')
    };
  });
  check('the toolbar has a template dropdown', !tplUi.missing);
  check('it offers exactly Contemporary and Modern',
    tplUi.options.length === 2 &&
    tplUi.options[0].v === 'contemporary' && tplUi.options[0].t === 'Contemporary' &&
    tplUi.options[1].v === 'modern' && tplUi.options[1].t === 'Modern',
    JSON.stringify(tplUi.options));
  check('it sits between the formatting controls and the theme button',
    tplUi.inToolbar && tplUi.afterFormat && tplUi.beforeTheme,
    `afterFormat=${tplUi.afterFormat} beforeTheme=${tplUi.beforeTheme}`);
  check('it shows the active template and agrees with the document',
    tplUi.value === 'contemporary' && tplUi.stateValue === 'contemporary',
    `select=${tplUi.value} doc=${tplUi.stateValue}`);
  check('the dropdown is labelled for screen readers', tplUi.labelled === true);

  /** Switch template through the UI path (the select's change event), which is
   *  what a real user does — not by poking State directly. */
  async function useTemplate(id) {
    await page.evaluate(async t => {
      const sel = document.getElementById('template-select');
      sel.value = t;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 700));
      window.Keys.Fit.refitAll({ force: true });
      await new Promise(r => setTimeout(r, 350));
    }, id);
  }

  /* --- the shared sheets must be untouched ------------------------------- */
  section('Templates — Slips and Calendar are shared');

  /** Fingerprint of the sheets the template must not change. innerHTML is the
   *  strongest available assertion: it catches a changed class, attribute or
   *  node just as readily as a changed layout. */
  const sharedSheets = () => page.evaluate(() => {
    const grab = kind => {
      const p = document.querySelector('#page-stage .paper[data-kind="' + kind + '"]');
      if (!p) return null;
      return {
        html: p.querySelector('.paper-flow').innerHTML,
        orientation: p.getAttribute('data-orientation'),
        w: p.offsetWidth,
        h: p.offsetHeight
      };
    };
    return { slips: grab('slips'), calendar: grab('calendar') };
  });

  const sharedBefore = await sharedSheets();
  await useTemplate('modern');
  const sharedAfter = await sharedSheets();

  check('the slips sheet is byte-identical under both templates',
    sharedBefore.slips && sharedAfter.slips &&
    sharedBefore.slips.html === sharedAfter.slips.html,
    sharedBefore.slips && sharedAfter.slips
      ? 'lengths ' + sharedBefore.slips.html.length + ' vs ' + sharedAfter.slips.html.length
      : 'a slips sheet was missing');
  check('the calendar sheet is byte-identical under both templates',
    sharedBefore.calendar && sharedAfter.calendar &&
    sharedBefore.calendar.html === sharedAfter.calendar.html,
    sharedBefore.calendar && sharedAfter.calendar
      ? 'lengths ' + sharedBefore.calendar.html.length + ' vs ' + sharedAfter.calendar.html.length
      : 'a calendar sheet was missing');
  check('the calendar stays landscape letter under Modern',
    sharedAfter.calendar && sharedAfter.calendar.orientation === 'landscape' &&
    Math.abs(sharedAfter.calendar.w - 1056) <= 2 &&
    Math.abs(sharedAfter.calendar.h - 816) <= 2,
    sharedAfter.calendar
      ? `${sharedAfter.calendar.orientation} ${sharedAfter.calendar.w}×${sharedAfter.calendar.h}`
      : 'missing');

  /* --- the Modern front and announcement markup -------------------------- */
  section('Templates — the Modern layout');

  const modernDom = await page.evaluate(() => {
    const papers = [...document.querySelectorAll('#page-stage .paper')];
    const front = document.querySelector('#page-stage .paper[data-kind="front"]');
    const ann = document.querySelector('#page-stage .paper[data-kind="announcements"]');
    const cs = el => el ? getComputedStyle(el) : null;
    const q = (root, sel) => root ? root.querySelector(sel) : null;

    const cols = q(front, '.nl-m-cols');
    const colStyle = cs(cols);
    const kids = cols ? [...cols.children] : [];

    return {
      // data-template on EVERY sheet, including the shared ones.
      templates: papers.map(p => p.getAttribute('data-template')),
      // Front page structure.
      hasHead: !!q(front, '.nl-m-head'),
      hasDateBand: !!q(front, '.nl-m-dateband'),
      hasVolume: !!q(front, '[data-bind="masthead.volume"]'),
      hasIntro: !!q(front, '[data-bind="intro.body"]'),
      hasBible: !!q(front, '[data-bind="bible.body"]'),
      hasEmblem: !!q(front, '.nl-m-emblem svg'),
      hasContact: !!q(front, '[data-bind="masthead.contactHeading"]'),
      hasFoot: !!q(front, '.nl-m-foot'),
      footNum: (q(front, '.nl-m-foot-num') || {}).textContent,
      annFootNum: (q(ann, '.nl-m-foot-num') || {}).textContent,
      hasSite: !!q(front, '[data-bind="footer.site"]'),
      // Contemporary-only regions must be gone, not merely hidden.
      motto: !!q(front, '[data-bind="masthead.motto"]'),
      verse: !!q(front, '[data-bind="classroom.verse"]'),
      // Three columns on the front, in the left-middle-right order.
      colCount: colStyle ? colStyle.gridTemplateColumns.split(/\s+/).length : 0,
      colOrder: kids.map(k => k.className.split(/\s+/)[0]),
      colWidths: kids.map(k => Math.round(k.getBoundingClientRect().width)),
      // Two columns on the announcements sheet.
      annColumns: cs(q(ann, '.nl-articles')) ?
        cs(q(ann, '.nl-articles')).columnCount : null,
      // The title is NOT force-uppercased under Modern.
      titleTransform: cs(q(front, '.nl-title')) ?
        cs(q(front, '.nl-title')).textTransform : null,
      titleText: (q(front, '[data-bind="masthead.title"]') || {}).textContent,
      // Ruled headings are the Modern signature.
      headingRule: cs(q(front, '.nl-heading')) ?
        cs(q(front, '.nl-heading')).borderBottomWidth : null,
      // The drag/drop hooks arrange.js needs must survive the fork.
      railDrop: !!q(front, '.nl-rail[data-drop="rail"]'),
      railMovables: front ? front.querySelectorAll('[data-move="rail"]').length : -1,
      articleDrops: document.querySelectorAll(
        '#page-stage [data-drop="article"]').length,
      // The emblem is decoration: it must not look editable.
      emblemBinds: front
        ? q(front, '.nl-m-emblem').querySelectorAll('[data-bind],[data-edits]').length
        : -1,
      emblemHidden: q(front, '.nl-m-emblem')
        ? q(front, '.nl-m-emblem').getAttribute('aria-hidden') : null
    };
  });

  check('every sheet carries data-template="modern"',
    modernDom.templates.length === 4 &&
    modernDom.templates.every(t => t === 'modern'),
    JSON.stringify(modernDom.templates));
  check('the Modern masthead, date band and volume line are rendered',
    modernDom.hasHead && modernDom.hasDateBand && modernDom.hasVolume,
    JSON.stringify({ head: modernDom.hasHead, band: modernDom.hasDateBand,
                     vol: modernDom.hasVolume }));
  check('the intro and Bible Inspo blocks are rendered',
    modernDom.hasIntro && modernDom.hasBible);
  check('the cross-and-book emblem is drawn',
    modernDom.hasEmblem === true);
  check('the emblem is decoration, not an editable region',
    modernDom.emblemBinds === 0 && modernDom.emblemHidden === 'true',
    `binds=${modernDom.emblemBinds} aria-hidden=${modernDom.emblemHidden}`);
  check('the contact block gets its own heading',
    modernDom.hasContact === true);
  check('Contemporary-only regions are absent, not just restyled',
    modernDom.motto === false && modernDom.verse === false,
    `motto=${modernDom.motto} verse=${modernDom.verse}`);
  check('the front page is three columns',
    modernDom.colCount === 3, 'grid-template-columns has ' + modernDom.colCount + ' tracks');
  check('the columns run intro / main / rail, left to right',
    modernDom.colOrder.join(',') === 'nl-m-aside,nl-m-main,nl-rail',
    modernDom.colOrder.join(','));
  check('the middle column is the widest, as in the reference',
    modernDom.colWidths[1] > modernDom.colWidths[0] &&
    modernDom.colWidths[1] > modernDom.colWidths[2],
    modernDom.colWidths.join(' / ') + 'px');
  check('the announcements sheet is two columns',
    modernDom.annColumns === '2', 'column-count=' + modernDom.annColumns);
  check('Modern prints the title as typed, not force-uppercased',
    modernDom.titleTransform === 'none' &&
    /St\. Peter/.test(modernDom.titleText || ''),
    `text-transform=${modernDom.titleTransform} title="${modernDom.titleText}"`);
  check('section headings carry the ruled underline',
    parseFloat(modernDom.headingRule) >= 1,
    'border-bottom-width=' + modernDom.headingRule);
  check('the running foot numbers both Modern sheets',
    modernDom.hasFoot && modernDom.footNum === '1' && modernDom.annFootNum === '2',
    `front=${modernDom.footNum} announcements=${modernDom.annFootNum}`);
  check('the website line prints on the front sheet only',
    modernDom.hasSite === true);
  check('the drag-and-drop hooks survive the template fork',
    modernDom.railDrop && modernDom.railMovables === 2 &&
    modernDom.articleDrops === 2,
    `railDrop=${modernDom.railDrop} railBlocks=${modernDom.railMovables} ` +
    `articleLists=${modernDom.articleDrops}`);

  /* The masthead title is centred on the SHEET and the volume line is anchored
   * to the right margin — independently of one another. As flex siblings the
   * volume took width out of the row, so the title was centred on what was left
   * and drifted left as the volume text grew. Measured across four very
   * different volume lengths, because "looks centred" only held for one. */
  const masthead = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const S = window.Keys.State;
    const cases = {
      seeded: null,
      empty: '',
      tiny: 'V1',
      long: 'Volume 12, Issue 34 &mdash; Winter Term 2026/2027',
      absurd: 'Volume' + 'x'.repeat(160)
    };
    const out = {};
    for (const name of Object.keys(cases)) {
      if (cases[name] !== null) {
        S.set('masthead.volume', cases[name]);
        window.Keys.App.structuralChange(null);
        await wait(400);
      }
      const paper = document.querySelector('#page-stage .paper[data-kind="front"]');
      const flow = paper.querySelector('.paper-flow');
      const title = paper.querySelector('.nl-title');
      const vol = paper.querySelector('.nl-m-volume');
      const cs = getComputedStyle(flow);
      const fr = flow.getBoundingClientRect();
      /* The printable content box, i.e. inside .paper-flow's page margins.
       *
       * #page-stage carries the zoom as a CSS transform, so getBoundingClientRect
       * returns SCALED coordinates while getComputedStyle returns unscaled ones.
       * Subtracting a raw padding from a scaled edge puts the margin in the
       * wrong place by (1 - scale) × padding — about 7px at fit zoom, enough to
       * look like a real layout bug. Recover the scale and convert. */
      const scale = fr.width / flow.offsetWidth;
      const cLeft = fr.left + parseFloat(cs.paddingLeft) * scale;
      const cRight = fr.right - parseFloat(cs.paddingRight) * scale;
      const tr = title.getBoundingClientRect();
      const vr = vol.getBoundingClientRect();
      out[name] = {
        offCentre: Math.abs((tr.left + tr.right) / 2 - (cLeft + cRight) / 2),
        volFlush: Math.abs(vr.right - cRight),
        overlap: Math.max(0, tr.right - vr.left),
        escapesRight: Math.max(0, vr.right - cRight),
        hOver: flow.scrollWidth - flow.clientWidth
      };
    }
    return out;
  });

  const mastCases = Object.keys(masthead);
  check('the masthead title is centred on the sheet, whatever the volume line says',
    mastCases.every(k => masthead[k].offCentre <= 1),
    mastCases.map(k => `${k}=${masthead[k].offCentre.toFixed(1)}px`).join(' '));
  check('the volume line is anchored flush to the right margin',
    mastCases.every(k => masthead[k].volFlush <= 1),
    mastCases.map(k => `${k}=${masthead[k].volFlush.toFixed(1)}px`).join(' '));
  check('the volume never overlaps the title or runs past the margin',
    mastCases.every(k => masthead[k].overlap <= 1 &&
                         masthead[k].escapesRight <= 1 &&
                         masthead[k].hOver <= 1),
    mastCases.map(k =>
      `${k}: overlap=${masthead[k].overlap.toFixed(1)} ` +
      `past=${masthead[k].escapesRight.toFixed(1)}`).join(' | '));

  await page.evaluate(async () => {
    window.Keys.App.structuralChange(function () {
      window.Keys.State.set('masthead.volume',
        window.Keys.State.defaultDoc().masthead.volume);
    });
    await new Promise(r => setTimeout(r, 300));
  });

  /* --- the editor rail follows the template ------------------------------ */
  section('Templates — the editor rail follows');

  const railFields = () => page.evaluate(() => {
    const sec = document.querySelector('#editor-scroll .ed-section[data-section="page1"]');
    return {
      paths: [...sec.querySelectorAll('[data-path]')]
        .map(e => e.getAttribute('data-path')),
      lead: (sec.querySelector('.ed-hint--lead') || {}).textContent || ''
    };
  });

  const modernRail = await railFields();
  check('Modern offers its own fields in the rail',
    ['masthead.volume', 'masthead.contactHeading', 'intro.heading', 'intro.body',
     'bible.heading', 'bible.body', 'footer.site', 'modern.emblem']
      .every(p => modernRail.paths.indexOf(p) !== -1),
    'missing: ' + ['masthead.volume', 'masthead.contactHeading', 'intro.heading',
      'intro.body', 'bible.heading', 'bible.body', 'footer.site', 'modern.emblem']
      .filter(p => modernRail.paths.indexOf(p) === -1).join(', '));
  check('Modern hides the fields it does not print',
    modernRail.paths.indexOf('masthead.motto') === -1 &&
    modernRail.paths.indexOf('classroom.verse') === -1,
    modernRail.paths.filter(p => /motto|verse/.test(p)).join(', '));
  check('the rail says which template it is showing, so a hidden field ' +
        'cannot be mistaken for a lost one',
    /Modern/.test(modernRail.lead) && /nothing is lost/i.test(modernRail.lead),
    JSON.stringify(modernRail.lead.slice(0, 90)));

  // The emblem checkbox is the first .ed-check in the app: prove the .pt hook
  // both routes its change event AND does not render as a text input.
  const emblemToggle = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    // Sections load collapsed (`.ed-body { display:none }`), and a field with
    // no box has no measurable size — open it before measuring anything.
    document.querySelector('#editor-scroll .ed-section[data-section="page1"]')
      .classList.add('is-open');
    await wait(250);
    const box = document.querySelector('#editor-scroll .pt[data-path="modern.emblem"]');

    /* Read the geometry into PRIMITIVES first. getComputedStyle returns a live
     * declaration and getBoundingClientRect has to be called while the node is
     * still in the document — toggling below triggers a structural re-render
     * that replaces the whole rail, and a detached node reports 0 and "". */
    const type = box.type;
    const width = Math.round(box.getBoundingClientRect().width);
    const borderWidth = getComputedStyle(box).borderTopWidth;
    const display = getComputedStyle(box).display;

    const before = !!document.querySelector('#page-stage .nl-m-emblem');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(600);
    const off = !!document.querySelector('#page-stage .nl-m-emblem');
    const box2 = document.querySelector('#editor-scroll .pt[data-path="modern.emblem"]');
    box2.checked = true;
    box2.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(600);
    return {
      type, width, borderWidth, display,
      before,
      off,
      backOn: !!document.querySelector('#page-stage .nl-m-emblem'),
      stored: window.Keys.State.get('modern.emblem')
    };
  });
  check('the emblem toggle is a real checkbox, not a text box wearing .pt',
    emblemToggle.type === 'checkbox' && emblemToggle.width > 0 &&
    emblemToggle.width <= 20 && parseFloat(emblemToggle.borderWidth) === 0,
    `width=${emblemToggle.width}px border=${emblemToggle.borderWidth} ` +
    `display=${emblemToggle.display}`);
  check('unticking it removes the emblem, reticking brings it back',
    emblemToggle.before === true && emblemToggle.off === false &&
    emblemToggle.backOn === true && emblemToggle.stored === true,
    JSON.stringify(emblemToggle));

  /* --- click-to-edit reaches the Modern-only regions --------------------- */
  const modernClicks = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const out = {};
    for (const path of ['intro.body', 'bible.body', 'masthead.volume',
                        'footer.site', 'thisWeek.rows.0.event']) {
      const node = document.querySelector('#page-stage [data-bind="' + path + '"]');
      if (!node) { out[path] = 'NO PREVIEW NODE'; continue; }
      const r = node.getBoundingClientRect();
      node.dispatchEvent(new MouseEvent('click', {
        bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + 4
      }));
      await wait(450);
      const a = document.activeElement;
      out[path] = a ? a.getAttribute('data-path') : null;
    }
    return out;
  });
  Object.keys(modernClicks).forEach(path => {
    check('clicking the Modern "' + path + '" region opens its field',
      modernClicks[path] === path, 'focused ' + modernClicks[path]);
  });

  /* Whole blocks are clickable, not just where the glyphs happen to be — the
   * same promise the calendar cells make. A Modern agenda entry is a short
   * centred line with wide empty margins either side of it. */
  const modernBlankClicks = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const out = {};

    // Just inside the left edge of an agenda line, well clear of its text.
    const line = document.querySelectorAll(
      '#page-stage .nl-m-line')[1];
    let r = line.getBoundingClientRect();
    line.dispatchEvent(new MouseEvent('click', {
      bubbles: true, clientX: r.left + 2, clientY: r.top + r.height / 2
    }));
    await wait(450);
    out.agendaLine = document.activeElement
      ? document.activeElement.getAttribute('data-path') : null;

    // Blank space at the very bottom of the left column, under the last block.
    const aside = document.querySelector('#page-stage .nl-m-aside');
    r = aside.getBoundingClientRect();
    aside.dispatchEvent(new MouseEvent('click', {
      bubbles: true, clientX: r.left + r.width / 2, clientY: r.bottom - 2
    }));
    await wait(450);
    out.asideBottom = document.activeElement
      ? document.activeElement.getAttribute('data-path') : null;
    return out;
  });
  check('clicking the empty margin of an agenda entry still selects that entry',
    /^thisWeek\.rows\.\d+\.(date|event)$/.test(modernBlankClicks.agendaLine || ''),
    'focused ' + modernBlankClicks.agendaLine);
  check('clicking blank space in a column lands on its nearest region',
    /^(bible|intro)\./.test(modernBlankClicks.asideBottom || ''),
    'focused ' + modernBlankClicks.asideBottom);

  /* --- switching loses nothing ------------------------------------------- */
  section('Templates — switching preserves the document');

  const roundTripTpl = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const S = window.Keys.State;
    const A = window.Keys.App;
    // Everything except the template itself, which is expected to change.
    const snap = () => {
      const d = JSON.parse(JSON.stringify(S.doc));
      delete d.template;
      delete d.meta;
      return JSON.stringify(d);
    };
    A.chooseTemplate('contemporary'); await wait(600);
    const asContemporary = snap();
    A.chooseTemplate('modern'); await wait(600);
    const asModern = snap();
    A.chooseTemplate('contemporary'); await wait(600);
    const backAgain = snap();
    return {
      stableToModern: asContemporary === asModern,
      stableBack: asContemporary === backAgain,
      len: asContemporary.length
    };
  });
  check('switching to Modern changes no content at all',
    roundTripTpl.stableToModern === true, 'document differed after the switch');
  check('switching back restores byte-identical content',
    roundTripTpl.stableBack === true, 'document differed after switching back');

  // Contemporary must get its own fields back.
  await useTemplate('contemporary');
  const contemporaryRail = await railFields();
  check('Contemporary gets Motto and Verse back',
    contemporaryRail.paths.indexOf('masthead.motto') !== -1 &&
    contemporaryRail.paths.indexOf('classroom.verse') !== -1);
  check('Contemporary hides the Modern-only fields',
    ['masthead.volume', 'intro.body', 'bible.body', 'footer.site', 'modern.emblem']
      .every(p => contemporaryRail.paths.indexOf(p) === -1),
    contemporaryRail.paths.filter(p =>
      /volume|intro|bible|footer|emblem/.test(p)).join(', '));

  /* --- the template travels with the save file --------------------------- */
  const tplPersist = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const S = window.Keys.State;
    S.setTemplate('modern');
    const json = S.toJSON();
    const parsed = JSON.parse(json);
    S.replace(S.defaultDoc());
    const afterReset = S.template();
    S.replace(parsed);
    window.Keys.App.structuralChange(null);
    await wait(500);
    return {
      inFile: parsed.template,
      version: parsed.meta.version,
      afterReset,
      afterLoad: S.template(),
      paperAttr: document.querySelector('#page-stage .paper')
        .getAttribute('data-template'),
      selectValue: document.getElementById('template-select').value
    };
  });
  check('the template is written into the save file',
    tplPersist.inFile === 'modern', 'got ' + tplPersist.inFile);
  check('loading a file applies the template it carries',
    tplPersist.afterReset === 'contemporary' && tplPersist.afterLoad === 'modern' &&
    tplPersist.paperAttr === 'modern',
    JSON.stringify(tplPersist));
  check('the toolbar dropdown follows a loaded file',
    tplPersist.selectValue === 'modern', 'select=' + tplPersist.selectValue);

  /* An older save file predates templates entirely. It was authored for the
   * Contemporary layout, so that is the only correct thing to open it as. */
  const legacyTpl = await page.evaluate(() => {
    const S = window.Keys.State;
    S.replace({ 'input-title': 'OLD', 'input-date': 'OLD DATE' });
    const v1 = S.template();
    S.replace({ meta: { version: 3 }, masthead: { title: 'V3' } });
    return { v1, v3: S.template() };
  });
  check('a save file from before templates opens as Contemporary',
    legacyTpl.v1 === 'contemporary' && legacyTpl.v3 === 'contemporary',
    JSON.stringify(legacyTpl));

  const hostileTpl = await page.evaluate(() => {
    const S = window.Keys.State;
    const tries = {};
    [['bogus', 'unknown id'], ['', 'empty'], [null, 'null'],
     [{ id: 'modern' }, 'object'], ['MODERN', 'wrong case'],
     ['<script>x</script>', 'markup']].forEach(([v, name]) => {
      S.replace({ meta: { version: 4 }, template: v });
      tries[name] = S.template();
    });
    // setTemplate must also refuse, and report what is really in effect.
    S.setTemplate('modern');
    const rejected = S.setTemplate('nope');
    tries['setTemplate rejects'] = rejected;
    return tries;
  });
  check('an unknown template id in a save file falls back to Contemporary',
    ['unknown id', 'empty', 'null', 'object', 'wrong case', 'markup']
      .every(k => hostileTpl[k] === 'contemporary'),
    JSON.stringify(hostileTpl));
  check('setTemplate refuses an unknown id and reports the one in effect',
    hostileTpl['setTemplate rejects'] === 'modern',
    'got ' + hostileTpl['setTemplate rejects']);

  /* --- Modern must meet the same overflow guarantee ---------------------- */
  section('Templates — Modern overflow (seeded issue)');
  await page.evaluate(async () => {
    window.Keys.App.structuralChange(function () {
      window.Keys.State.replace(window.Keys.State.defaultDoc());
      window.Keys.State.setTemplate('modern');
    });
    await new Promise(r => setTimeout(r, 500));
    window.Keys.Fit.refitAll({ force: true });
  });
  await page.waitForTimeout(500);
  const modernSeeded = await page.evaluate(OVERFLOW_PROBE);
  for (const r of modernSeeded) {
    check(`Modern page ${r.page}: nothing escapes the sheet`, r.worst <= 1.0,
      `escapes ${r.worst}px past the ${r.worstEdge} edge — ${r.worstSel}`);
    check(`Modern page ${r.page}: nothing is clipped`, r.clipped.length === 0,
      r.clipped.map(c => `${c.sel} by ${c.dy.toFixed(1)}×${c.dx.toFixed(1)}px`).join('\n      '));
  }

  /* The multi-column announcements sheet is the one place a page could
   * overflow SIDEWAYS instead of downwards — an over-long issue would spill
   * into a third, clipped column. Assert it grows downwards instead, which is
   * the direction tier 2 shrinks against. */
  const annColumnOverflow = await page.evaluate(() => {
    const ann = document.querySelector('#page-stage .paper[data-kind="announcements"]');
    const list = ann.querySelector('.nl-articles');
    const cs = getComputedStyle(list);
    return {
      fill: cs.columnFill,
      height: cs.height,
      hOverflow: list.scrollWidth - list.clientWidth,
      flowH: ann.querySelector('.paper-flow').scrollWidth -
             ann.querySelector('.paper-flow').clientWidth
    };
  });
  check('the announcement columns balance to auto height, so overflow goes down',
    annColumnOverflow.fill === 'balance' && annColumnOverflow.hOverflow <= 1 &&
    annColumnOverflow.flowH <= 1,
    JSON.stringify(annColumnOverflow));

  section('Templates — Modern overflow stress (3x text, must fit exactly)');
  const modernHeavy = await flood(3, false, 'modern');
  for (const r of modernHeavy) {
    check(`Modern page ${r.page}: nothing escapes the sheet`, r.worst <= 1.0,
      `escapes ${r.worst}px past the ${r.worstEdge} edge — ${r.worstSel}`);
    check(`Modern page ${r.page}: nothing is clipped`, r.clipped.length === 0,
      r.clipped.map(c => `${c.sel} by ${c.dy.toFixed(1)}×${c.dx.toFixed(1)}px`).join('\n      '));
  }

  section('Templates — Modern overflow stress (12x + unbreakable tokens)');
  const modernAbsurd = await flood(12, true, 'modern');
  for (const r of modernAbsurd) {
    const sideways = r.worstEdge === 'left' || r.worstEdge === 'right';
    check(`Modern page ${r.page}: never escapes sideways`,
      !(sideways && r.worst > 1.0),
      `escapes ${r.worst}px past the ${r.worstEdge} edge — ${r.worstSel}`);
    const hClip = r.clipped.filter(c => c.dx > 1.0);
    check(`Modern page ${r.page}: no horizontal clipping`, hClip.length === 0,
      hClip.map(c => `${c.sel} by ${c.dx.toFixed(1)}px wide`).join('\n      '));
  }

  /* --- drag-to-reorder across Modern's two columns -----------------------
   * The case that breaks a y-only drop scan. With four sections the sheet
   * balances two per column, so the RIGHT column restarts at the top of the
   * page: a slot chosen from the pointer's y alone resolves a drop high in the
   * right column to a slot in the left one. Four short sections, so the
   * overflow guard has no reason to refuse the move.
   * ---------------------------------------------------------------------- */
  section('Templates — dragging between Modern columns');

  const columnLayout = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const S = window.Keys.State;
    window.Keys.App.structuralChange(function () {
      S.replace(S.defaultDoc());
      S.setTemplate('modern');
      S.doc.articles.pages[0] = ['A', 'B', 'C', 'D'].map(t => ({
        title: 'SECTION ' + t,
        body: '<p>Short body for section ' + t + '.</p>'
      }));
    });
    await wait(700);
    window.Keys.Flip.go(2, { animate: false });
    await wait(400);
    const arts = [...document.querySelectorAll(
      '#page-stage .paper[data-kind="announcements"] .nl-article')];
    const rects = arts.map(a => {
      const r = a.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top) };
    });
    const lefts = [...new Set(rects.map(r => r.left))];
    return {
      count: arts.length,
      labels: arts.map(a => a.getAttribute('data-move-label')),
      rects,
      columns: lefts.length,
      // The two columns must genuinely overlap vertically, or the case this
      // test exists for does not arise.
      rightStartsAboveLeftEnd:
        Math.min(...rects.filter(r => r.left === lefts[1]).map(r => r.top)) <
        Math.max(...rects.filter(r => r.left === lefts[0]).map(r => r.top))
    };
  });
  check('four sections balance into two Modern columns',
    columnLayout.count === 4 && columnLayout.columns === 2,
    `${columnLayout.count} sections across ${columnLayout.columns} column(s)`);
  check('the right column restarts above the end of the left one',
    columnLayout.rightStartsAboveLeftEnd === true,
    JSON.stringify(columnLayout.rects));

  const ANN = '#page-stage .paper[data-kind="announcements"] ';
  // Drop SECTION A onto the TOP half of the right column's first section.
  const rightTop = await page.evaluate(sel => {
    const arts = [...document.querySelectorAll(sel + '.nl-article')];
    const lefts = [...new Set(arts.map(a =>
      Math.round(a.getBoundingClientRect().left)))].sort((a, b) => a - b);
    const inRight = arts
      .filter(a => Math.round(a.getBoundingClientRect().left) === lefts[1])
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return inRight[0].getAttribute('data-move-key');
  }, ANN);

  const colDrag = await dragBlock(
    ANN + '.nl-article[data-move-key="articles.pages.0:0"]',
    ANN + '.nl-article[data-move-key="' + rightTop + '"]',
    0.15);
  const colOrder = await page.evaluate(() =>
    window.Keys.State.doc.articles.pages[0].map(a => a.title));

  check('a drop at the top of the right column lands there, not in the left',
    !colDrag.error && colOrder[1] === 'SECTION A' &&
    colOrder[0] === 'SECTION B',
    (colDrag.error || '') + ' order: ' + colOrder.join(', '));

  // Back to the pristine Contemporary issue for the remaining tests.
  await page.evaluate(async () => {
    window.Keys.App.structuralChange(function () {
      window.Keys.State.replace(window.Keys.State.defaultDoc());
    });
    await new Promise(r => setTimeout(r, 400));
    window.Keys.Fit.refitAll({ force: true });
  });
  await page.waitForTimeout(500);
  const backToContemporary = await page.evaluate(() => ({
    tpl: window.Keys.State.template(),
    motto: !!document.querySelector('#page-stage [data-bind="masthead.motto"]'),
    modernFoot: !!document.querySelector('#page-stage .nl-m-foot')
  }));
  check('the suite is back on the seeded Contemporary issue',
    backToContemporary.tpl === 'contemporary' && backToContemporary.motto &&
    !backToContemporary.modernFoot,
    JSON.stringify(backToContemporary));

  /* ------------------------------------------------------------- calendar-- */
  section('Calendar');
  const cal = await page.evaluate(() => {
    const C = window.Keys.Calendar;
    const cases = [
      { y: 2026, m: 1, name: 'Feb 2026' },
      { y: 2028, m: 1, name: 'Feb 2028 (leap)' },
      { y: 2026, m: 4, name: 'May 2026 (31d, starts Fri)' },
      { y: 2026, m: 7, name: 'Aug 2026 (starts Sat)' },
      { y: 2026, m: 5, name: 'Jun 2026 (reference)' }
    ];
    const results = cases.map(c => {
      const mx = C.monthMatrix(c.y, c.m);
      const flat = mx.flat();
      const inMonth = flat.filter(x => x.inMonth);
      // Sunday-first check: every in-month cell's column must equal its real DOW
      let colOk = true;
      mx.forEach(week => week.forEach((cell, col) => {
        if (!cell.inMonth) return;
        const d = new Date(c.y, c.m, cell.day);
        if (d.getDay() !== col) colOk = false;
      }));
      const isoOk = inMonth.every(x => {
        const [yy, mm, dd] = x.iso.split('-').map(Number);
        return yy === c.y && mm === c.m + 1 && dd === x.day;
      });
      return {
        name: c.name, weeks: mx.length,
        allSeven: mx.every(w => w.length === 7),
        days: inMonth.length,
        ordered: inMonth.every((x, i) => x.day === i + 1),
        colOk, isoOk,
        expectDays: new Date(c.y, c.m + 1, 0).getDate()
      };
    });
    // exhaustive sweep 2020-2040
    let sweepBad = [];
    for (let y = 2020; y <= 2040; y++) {
      for (let m = 0; m < 12; m++) {
        const mx = C.monthMatrix(y, m);
        const dim = new Date(y, m + 1, 0).getDate();
        const start = new Date(y, m, 1).getDay();
        const wantWeeks = Math.ceil((start + dim) / 7);
        const flat = mx.flat().filter(x => x.inMonth);
        if (mx.length !== wantWeeks || flat.length !== dim ||
            !mx.every(w => w.length === 7)) {
          sweepBad.push(`${y}-${m + 1}`);
        }
      }
    }
    const dow = Array.from(document.querySelectorAll('#page-stage .paper[data-kind="calendar"] .cal-dayname'))
      .map(e => e.textContent.trim());
    return { results, sweepBad, dow, dayNames: C.DAY_NAMES };
  });

  for (const r of cal.results) {
    check(`${r.name}: ${r.weeks} week rows, ${r.days} days`,
      r.allSeven && r.colOk && r.isoOk && r.ordered && r.days === r.expectDays,
      `sevens=${r.allSeven} sundayFirst=${r.colOk} iso=${r.isoOk} ordered=${r.ordered} days=${r.days}/${r.expectDays}`);
  }
  check('exhaustive sweep 2020–2040 (252 months)', cal.sweepBad.length === 0,
    'bad: ' + cal.sweepBad.slice(0, 10).join(', '));
  check('rendered header runs Sunday → Saturday',
    cal.dow.length === 7 && cal.dow[0] === 'Sunday' && cal.dow[6] === 'Saturday',
    'got ' + JSON.stringify(cal.dow));

  const monthSwitch = await page.evaluate(async () => {
    const before = window.Keys.State.get('calendar.days.2026-06-05');
    const sel = document.querySelector('#editor-scroll .pt[data-path="calendar.month"]');
    sel.value = '1';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const titleFeb = document.querySelector('#page-stage .paper[data-kind="calendar"] .cal-month');
    const sel2 = document.querySelector('#editor-scroll .pt[data-path="calendar.month"]');
    sel2.value = '5';
    sel2.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const after = window.Keys.State.get('calendar.days.2026-06-05');
    const titleJun = document.querySelector('#page-stage .paper[data-kind="calendar"] .cal-month');
    return {
      before, after,
      febTitle: titleFeb ? titleFeb.textContent.trim() : null,
      junTitle: titleJun ? titleJun.textContent.trim() : null
    };
  });
  check('month dropdown retitles the sheet',
    /FEBRUARY\s+2026/i.test(monthSwitch.febTitle || '') && /JUNE\s+2026/i.test(monthSwitch.junTitle || ''),
    `feb="${monthSwitch.febTitle}" jun="${monthSwitch.junTitle}"`);
  check('switching months preserves events',
    monthSwitch.before && monthSwitch.before === monthSwitch.after,
    `before=${JSON.stringify(monthSwitch.before)} after=${JSON.stringify(monthSwitch.after)}`);

  /* ---------------------------------------------------------------- slips-- */
  section('Lunch slips (add / remove boxes)');
  const slips = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 260));
    const nSlips = () => window.Keys.State.doc.slips.length;
    const nBoxes = () => document.querySelectorAll('#page-stage .paper[data-kind="slips"] .slip').length;
    const nCards = () => document.querySelectorAll('#editor-scroll [data-slip-id]').length;

    const start = { slips: nSlips(), boxes: nBoxes(), cards: nCards() };

    const addBtn = document.querySelector('#editor-scroll [data-act="slip-add"][data-type="lunch"]');
    if (!addBtn) return { error: 'no add-lunch button found' };
    addBtn.click(); await wait();
    const added = { slips: nSlips(), boxes: nBoxes(), cards: nCards() };

    // Add an option line to the new slip
    const newId = window.Keys.State.doc.slips[window.Keys.State.doc.slips.length - 1].id;
    const fieldsBefore = window.Keys.State.doc.slips.find(s => s.id === newId).fields.length;
    const fAdd = document.querySelector('[data-act="field-add"][data-id="' + newId + '"]');
    if (fAdd) { fAdd.click(); await wait(); }
    const fieldsAfter = window.Keys.State.doc.slips.find(s => s.id === newId).fields.length;

    // Delete it again (confirm() is auto-accepted by the harness override)
    window.confirm = () => true;
    const delBtn = document.querySelector('[data-act="slip-del"][data-id="' + newId + '"]');
    if (delBtn) { delBtn.click(); await wait(); }
    const removed = { slips: nSlips(), boxes: nBoxes(), cards: nCards() };

    const cols = Array.from(document.querySelectorAll('#page-stage .paper[data-kind="slips"] .slip-col'))
      .map(c => ({ col: c.getAttribute('data-col'), n: c.querySelectorAll('.slip').length }));

    return { start, added, fieldsBefore, fieldsAfter, removed, cols };
  });

  if (slips.error) {
    fail('slip add/remove', slips.error);
  } else {
    check('seed renders every slip box',
      slips.start.slips === slips.start.boxes && slips.start.boxes === slips.start.cards,
      `state=${slips.start.slips} preview=${slips.start.boxes} editor=${slips.start.cards}`);
    check('adding a box adds a preview box and an editor card',
      slips.added.slips === slips.start.slips + 1 &&
      slips.added.boxes === slips.start.boxes + 1 &&
      slips.added.cards === slips.start.cards + 1,
      JSON.stringify(slips.added));
    check('adding an option line grows the slip',
      slips.fieldsAfter === slips.fieldsBefore + 1,
      `${slips.fieldsBefore} → ${slips.fieldsAfter}`);
    check('removing a box restores the original count',
      slips.removed.slips === slips.start.slips &&
      slips.removed.boxes === slips.start.boxes &&
      slips.removed.cards === slips.start.cards,
      JSON.stringify(slips.removed));
    ok('page 3 columns', slips.cols.map(c => `${c.col}=${c.n}`).join(' '));
  }

  // Checkboxes must store booleans, not the string "on", and must round-trip
  // through a structural re-render.
  const toggles = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 260));
    const S = window.Keys.State;
    const lunchIdx = S.doc.slips.findIndex(s => s.type === 'lunch');
    const path = 'slips.' + lunchIdx + '.nameRow';
    const before = S.get(path);
    // The page-3 accordion is collapsed by default and .ed-body is display:none,
    // so open it before measuring anything geometric.
    const sec = document.querySelector('#editor-scroll .ed-section[data-section="page3"]');
    if (sec) sec.classList.add('is-open');
    await wait();
    const box = document.querySelector('#editor-scroll .pt[data-path="' + path + '"]');
    if (!box) return { error: 'no nameRow checkbox found' };
    const rect = box.getBoundingClientRect();
    const countNameRows = () => document.querySelectorAll(
      '#page-stage .paper[data-kind="slips"] .slip-namerow').length;
    const nameRowsBefore = countNameRows();

    box.checked = !before;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await wait();
    const afterVal = S.get(path);
    const rerendered = document.querySelector('#editor-scroll .pt[data-path="' + path + '"]');
    const nameRows = countNameRows();
    // Capture this NOW — restoring the value below would overwrite it.
    const reflected = rerendered ? rerendered.checked === !before : null;

    // put it back
    rerendered.checked = before;
    rerendered.dispatchEvent(new Event('change', { bubbles: true }));
    await wait();

    return {
      before, afterVal, typeofAfter: typeof afterVal, reflected,
      restored: S.get(path), nameRows, nameRowsBefore,
      width: Math.round(rect.width)
    };
  });
  if (toggles.error) {
    fail('slip checkbox binding', toggles.error);
  } else {
    check('checkbox stores a boolean, not "on"',
      toggles.typeofAfter === 'boolean' && toggles.afterVal === !toggles.before,
      `got ${JSON.stringify(toggles.afterVal)} (${toggles.typeofAfter})`);
    check('checkbox state survives a re-render', toggles.reflected === true,
      'reflected=' + toggles.reflected);
    // Relative, not absolute: page 3 also carries the After School box's own
    // name rows, so the total is not a fixed number.
    check('unticking "Name line" removes exactly that one from the printed slip',
      toggles.nameRows === toggles.nameRowsBefore - 1,
      `${toggles.nameRowsBefore} -> ${toggles.nameRows} name rows on page 3`);
    check('checkbox restores cleanly', toggles.restored === toggles.before,
      `${JSON.stringify(toggles.restored)} vs ${JSON.stringify(toggles.before)}`);
    check('checkbox renders at a native size (not a full-width slab)',
      toggles.width > 0 && toggles.width < 60, toggles.width + 'px wide');
  }

  /* ------------------------------------------------------------------ nav-- */
  /* --------------------------------------------- After School Sign Up type-- */
  section('After School Sign Up slip');
  await resetDoc();

  const as1 = await page.evaluate(() => {
    const S = window.Keys.State;
    const i = S.doc.slips.findIndex(s => s.type === 'afterschool');
    const slip = S.doc.slips[i];
    const box = document.querySelector(
      '#page-stage .paper[data-kind="slips"] .slip--afterschool');
    if (!box) return { error: 'no afterschool box rendered' };
    const grids = box.querySelectorAll('.slip-as-days');
    const firstGrid = grids[0];
    const headCells = firstGrid.querySelectorAll('.slip-as-dayname');
    const dayCells = firstGrid.querySelectorAll('.slip-as-daycell');
    return {
      index: i,
      isOwnType: !!window.Keys.Slips.TYPES.afterschool,
      customStillExists: !!window.Keys.Slips.TYPES.custom,
      inToolbar: !!document.querySelector(
        '#editor-scroll [data-act="slip-add"][data-type="afterschool"]'),
      customInToolbar: !!document.querySelector(
        '#editor-scroll [data-act="slip-add"][data-type="custom"]'),
      // Structure generated from data, not typed by hand:
      students: slip.students,
      grids: grids.length,
      nameRows: box.querySelectorAll('.slip-namerow').length,
      dayNames: [...headCells].map(e => e.textContent.trim()),
      cellKinds: [...dayCells].map(td =>
        td.classList.contains('slip-as-daycell--xxx') ? 'xxx'
          : (td.querySelector('.slip-rule') ? 'blank' : '?')),
      xxxText: [...dayCells].filter(td =>
        td.classList.contains('slip-as-daycell--xxx')).map(e => e.textContent.trim()),
      terms: box.querySelectorAll('.slip-as-terms tr').length,
      hasTotal: !!box.querySelector('.slip-total'),
      // No hand-aligned underscore padding left anywhere in the box:
      underscores: /_{3,}/.test(box.textContent),
      nbspRuns: / {4,}/.test(box.textContent)
    };
  });

  if (as1.error) {
    fail('After School Sign Up renders', as1.error);
  } else {
    check('After School Sign Up is its own slip type',
      as1.isOwnType && as1.index >= 0, 'index=' + as1.index);
    check('Custom Box still exists alongside it',
      as1.customStillExists && as1.customInToolbar);
    check('it can be added from the toolbar', as1.inToolbar === true);
    check('one hours grid and name line per sign-up line',
      as1.grids === as1.students && as1.nameRows === as1.students,
      `students=${as1.students} grids=${as1.grids} nameRows=${as1.nameRows}`);
    check('weekday headings run Mon..Fri',
      JSON.stringify(as1.dayNames) === JSON.stringify(['Mon', 'Tues', 'Wed', 'Thurs', 'Fri']),
      JSON.stringify(as1.dayNames));
    check('day cells are generated as rules, with XXX where closed',
      JSON.stringify(as1.cellKinds) ===
        JSON.stringify(['blank', 'blank', 'blank', 'blank', 'xxx']),
      JSON.stringify(as1.cellKinds));
    check('the XXX cell prints as XXX',
      as1.xxxText.length === 1 && as1.xxxText[0] === 'XXX',
      JSON.stringify(as1.xxxText));
    check('the rate/policy rows render', as1.terms === 2, 'rows=' + as1.terms);
    check('the total line renders', as1.hasTotal === true);
    check('no hand-aligned underscore or nbsp padding remains',
      !as1.underscores && !as1.nbspRuns,
      `underscores=${as1.underscores} nbspRuns=${as1.nbspRuns}`);
  }

  // The day dropdown is the feature: switching a day must change the print.
  const as2 = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 320));
    const S = window.Keys.State;
    const i = S.doc.slips.findIndex(s => s.type === 'afterschool');
    const sec = document.querySelector('#editor-scroll .ed-section[data-section="page3"]');
    if (sec) sec.classList.add('is-open');
    await wait();

    const sel = document.querySelector(
      '#editor-scroll .pt[data-path="slips.' + i + '.days.0"]');
    if (!sel) return { error: 'no day dropdown found' };
    const options = [...sel.options].map(o => o.value);

    // Monday -> XXX
    sel.value = 'xxx';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait();
    const after = [...document.querySelectorAll(
      '#page-stage .paper[data-kind="slips"] .slip--afterschool .slip-as-days')[0]
      .querySelectorAll('.slip-as-daycell')]
      .map(td => td.classList.contains('slip-as-daycell--xxx') ? 'xxx' : 'blank');

    // Every sign-up line must agree — closure is a property of the week.
    const allGrids = [...document.querySelectorAll(
      '#page-stage .paper[data-kind="slips"] .slip--afterschool .slip-as-days')]
      .map(g => [...g.querySelectorAll('.slip-as-daycell')]
        .map(td => td.classList.contains('slip-as-daycell--xxx') ? 'x' : 'b').join(''));

    return { options, stored: S.get('slips.' + i + '.days.0'), after, allGrids };
  });

  if (as2.error) {
    fail('day dropdown', as2.error);
  } else {
    check('each day offers exactly a blank line or XXX',
      JSON.stringify(as2.options) === JSON.stringify(['blank', 'xxx']),
      JSON.stringify(as2.options));
    check('choosing XXX for a day updates state and the printed cell',
      as2.stored === 'xxx' &&
      JSON.stringify(as2.after) === JSON.stringify(['xxx', 'blank', 'blank', 'blank', 'xxx']),
      `stored=${as2.stored} cells=${JSON.stringify(as2.after)}`);
    check('every sign-up line shows the same closed days',
      new Set(as2.allGrids).size === 1, JSON.stringify(as2.allGrids));
  }

  // Add/remove sign-up lines and rate rows.
  const as3 = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 320));
    const S = window.Keys.State;
    const id = S.doc.slips.find(s => s.type === 'afterschool').id;
    const grids = () => document.querySelectorAll(
      '#page-stage .paper[data-kind="slips"] .slip--afterschool .slip-as-days').length;
    const termRows = () => document.querySelectorAll(
      '#page-stage .paper[data-kind="slips"] .slip--afterschool .slip-as-terms tr').length;

    const start = { g: grids(), t: termRows() };
    document.querySelector('[data-act="student-add"][data-id="' + id + '"]').click();
    await wait();
    const added = grids();
    document.querySelector('[data-act="student-del"][data-id="' + id + '"]').click();
    await wait();
    const removed = grids();
    document.querySelector('[data-act="term-add"][data-id="' + id + '"]').click();
    await wait();
    const termAdded = termRows();
    document.querySelector(
      '[data-act="term-del"][data-id="' + id + '"][data-index="0"]').click();
    await wait();
    const termRemoved = termRows();
    return { start, added, removed, termAdded, termRemoved };
  });
  check('adding a sign-up line adds a name line and hours grid',
    as3.added === as3.start.g + 1, `${as3.start.g} -> ${as3.added}`);
  check('removing a sign-up line restores the count',
    as3.removed === as3.start.g, `-> ${as3.removed}`);
  check('rate/policy rows can be added and removed',
    as3.termAdded === as3.start.t + 1 && as3.termRemoved === as3.start.t,
    `${as3.start.t} -> ${as3.termAdded} -> ${as3.termRemoved}`);

  // A brand-new box from the toolbar must be usable immediately.
  const as4 = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 340));
    const S = window.Keys.State;
    const before = S.doc.slips.length;
    document.querySelector(
      '#editor-scroll [data-act="slip-add"][data-type="afterschool"]').click();
    await wait();
    const slip = S.doc.slips[S.doc.slips.length - 1];
    const boxes = document.querySelectorAll(
      '#page-stage .paper[data-kind="slips"] .slip--afterschool').length;
    window.confirm = () => true;
    document.querySelector('[data-act="slip-del"][data-id="' + slip.id + '"]').click();
    await wait();
    return {
      added: S.doc.slips.length === before + 1 ? false : true,
      count: S.doc.slips.length,
      before,
      type: slip.type,
      days: slip.days,
      dayLabels: slip.dayLabels,
      students: slip.students,
      boxes
    };
  });
  check('a new After School box seeds a full weekday grid',
    as4.type === 'afterschool' && as4.days.length === 5 &&
    as4.dayLabels.length === 5 && as4.students === 2,
    JSON.stringify({ days: as4.days, labels: as4.dayLabels, students: as4.students }));
  check('a new After School box appears on the page and deletes cleanly',
    as4.boxes === 2 && as4.count === as4.before,
    `boxes=${as4.boxes} slips ${as4.before} -> ${as4.count}`);

  // Malformed afterschool data must not throw.
  const as5 = await page.evaluate(async () => {
    const S = window.Keys.State;
    let threw = null;
    try {
      S.replace({ slips: [{ id: 'x', type: 'afterschool', days: 'nope',
                            dayLabels: 5, terms: 'no', students: -4 },
                          { id: 'y', type: 'afterschool', days: { '0': 'weird' },
                            students: 9999 }] });
      window.Keys.App.structuralChange(null);
    } catch (e) { threw = e.message; }
    await new Promise(r => setTimeout(r, 340));
    return {
      threw,
      boxes: document.querySelectorAll(
        '#page-stage .paper[data-kind="slips"] .slip--afterschool').length,
      grids0: document.querySelectorAll(
        '#page-stage .paper[data-kind="slips"] .slip--afterschool')[0]
        .querySelectorAll('.slip-as-days').length,
      grids1: document.querySelectorAll(
        '#page-stage .paper[data-kind="slips"] .slip--afterschool')[1]
        .querySelectorAll('.slip-as-days').length
    };
  });
  check('malformed After School data renders without throwing',
    as5.threw === null && as5.boxes === 2, 'threw=' + as5.threw);
  check('a negative sign-up count clamps to none, a huge one is capped',
    as5.grids0 === 0 && as5.grids1 > 0 && as5.grids1 <= 12,
    `grids ${as5.grids0} / ${as5.grids1}`);

  await resetDoc();

  /* ------------------------------------------------ extra announcement pages-- */
  section('Extra announcement pages');
  await resetDoc();

  const pagesBase = await page.evaluate(() => ({
    total: window.Keys.App.totalPages(),
    kinds: window.Keys.Render.pages().map(p => p.kind),
    domKinds: [...document.querySelectorAll('#page-stage .paper')]
      .map(p => p.getAttribute('data-kind')),
    domOrdinals: [...document.querySelectorAll('#page-stage .paper')]
      .map(p => Number(p.getAttribute('data-page')))
  }));
  check('the issue starts as Front / Announcements / Slips / Calendar',
    JSON.stringify(pagesBase.kinds) ===
      JSON.stringify(['front', 'announcements', 'slips', 'calendar']),
    JSON.stringify(pagesBase.kinds));
  check('the rendered sheets match the page list',
    JSON.stringify(pagesBase.domKinds) === JSON.stringify(pagesBase.kinds) &&
    JSON.stringify(pagesBase.domOrdinals) === JSON.stringify([1, 2, 3, 4]),
    JSON.stringify(pagesBase.domKinds) + ' ' + JSON.stringify(pagesBase.domOrdinals));

  // Add a page from the preview-pane shortcut.
  const added = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 500));
    const btn = document.querySelector('#thumb-rail .thumb--add');
    if (!btn) return { error: 'no add-page shortcut in the rail' };
    btn.click();
    await wait();
    return {
      total: window.Keys.App.totalPages(),
      kinds: window.Keys.Render.pages().map(p => p.kind),
      names: window.Keys.Render.pages().map(p => p.name),
      ordinals: [...document.querySelectorAll('#page-stage .paper')]
        .map(p => Number(p.getAttribute('data-page'))),
      papers: document.querySelectorAll('#page-stage .paper').length,
      thumbs: document.querySelectorAll('#thumb-rail .thumb:not(.thumb--add)').length,
      current: window.Keys.Flip.current(),
      pageCount: window.Keys.State.get('articles.pages').length,
      indicator: (document.getElementById('page-indicator') || {}).textContent,
      railLabels: [...document.querySelectorAll('#thumb-rail .thumb-label')]
        .map(l => l.textContent.trim()),
      truncated: [...document.querySelectorAll('#thumb-rail .thumb-label')]
        .filter(l => l.scrollWidth > l.clientWidth + 1)
        .map(l => l.textContent.trim()),
      overlaps: (function () {
        const rects = [...document.querySelectorAll('#thumb-rail .thumb')]
          .map(t => t.getBoundingClientRect());
        const bad = [];
        for (let i = 1; i < rects.length; i++) {
          if (rects[i].left < rects[i - 1].right - 0.5) bad.push(i);
        }
        return bad;
      })()
    };
  });
  if (added.error) {
    fail('add a page from the preview rail', added.error);
  } else {
    check('the rail shortcut adds an announcement page',
      added.total === 5 && added.pageCount === 2,
      `total=${added.total} announcementPages=${added.pageCount}`);
    check('the new sheet is inserted after the existing announcements',
      JSON.stringify(added.kinds) === JSON.stringify(
        ['front', 'announcements', 'announcements', 'slips', 'calendar']),
      JSON.stringify(added.kinds));
    check('the later pages renumber themselves',
      JSON.stringify(added.ordinals) === JSON.stringify([1, 2, 3, 4, 5]),
      JSON.stringify(added.ordinals));
    check('the preview, rail and pager all agree',
      added.papers === 5 && added.thumbs === 5 && /5$/.test(added.indicator || ''),
      `papers=${added.papers} thumbs=${added.thumbs} pager="${added.indicator}"`);
    check('the preview jumps to the page just added', added.current === 3,
      'on page ' + added.current);
    check('multiple announcement pages get numbered names',
      /Announcements 1/.test(added.names[1]) && /Announcements 2/.test(added.names[2]),
      JSON.stringify(added.names));
    check('the rail captions read "Announcements 1" / "Announcements 2"',
      JSON.stringify(added.railLabels) === JSON.stringify(
        ['Front', 'Announcements 1', 'Announcements 2', 'Slips', 'Calendar',
         'Add page']),
      JSON.stringify(added.railLabels));
    check('the longer captions are still not truncated or overlapping',
      added.truncated.length === 0 && added.overlaps.length === 0,
      'truncated: ' + JSON.stringify(added.truncated) +
      ' overlaps: ' + JSON.stringify(added.overlaps));
  }

  // Slips and calendar must still be reachable and correct at their new ordinals.
  const shifted = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 400));
    const slipsOrd = window.Keys.Render.ordinalOf('slips');
    const calOrd = window.Keys.Render.ordinalOf('calendar');
    const calPaper = document.querySelector('#page-stage .paper[data-kind="calendar"]');
    // Focusing a calendar field must now navigate to its NEW ordinal.
    const sec = document.querySelector('#editor-scroll .ed-section[data-section="page4"]');
    sec.classList.add('is-open');
    await wait();
    const fld = document.querySelector('#editor-scroll .rt[data-path^="calendar.days."]');
    const declared = fld ? Number(fld.getAttribute('data-page')) : null;
    fld.focus();
    await wait();
    return {
      slipsOrd, calOrd,
      calOrdinalAttr: Number(calPaper.getAttribute('data-page')),
      calLandscape: calPaper.getAttribute('data-orientation'),
      calPadding: getComputedStyle(
        calPaper.querySelector('.paper-flow')).paddingLeft,
      declared,
      landedOn: window.Keys.Flip.current()
    };
  });
  check('slips and calendar move to their new ordinals',
    shifted.slipsOrd === 4 && shifted.calOrd === 5 && shifted.calOrdinalAttr === 5,
    `slips=${shifted.slipsOrd} calendar=${shifted.calOrd}/${shifted.calOrdinalAttr}`);
  check('the calendar keeps its landscape trim and its own margins',
    shifted.calLandscape === 'landscape' && shifted.calPadding !== '48px',
    `orientation=${shifted.calLandscape} padding-left=${shifted.calPadding}`);
  check('editor fields follow the renumbering',
    shifted.declared === 5 && shifted.landedOn === 5,
    `field says page ${shifted.declared}, landed on ${shifted.landedOn}`);

  // Content on the new page, and nothing overflowing.
  const newPageContent = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 400));
    const S = window.Keys.State;
    S.set('articles.pages.1.0.title', 'SECOND SHEET');
    window.Keys.App.structuralChange(null);
    window.Keys.Fit.refitAll({ force: true });
    await wait();
    const paper = [...document.querySelectorAll(
      '#page-stage .paper[data-kind="announcements"]')][1];
    return {
      title: paper.querySelector('.nl-article-title').textContent.trim(),
      bound: !!paper.querySelector('[data-bind="articles.pages.1.0.title"]'),
      overflow: window.Keys.Fit.measure(paper)
    };
  });
  check('the new page renders its own content',
    newPageContent.title === 'SECOND SHEET' && newPageContent.bound,
    `title="${newPageContent.title}" bound=${newPageContent.bound}`);
  check('the new page does not overflow',
    newPageContent.overflow && newPageContent.overflow.overflow === false,
    JSON.stringify(newPageContent.overflow));

  // Save / load round trip with the extra page.
  const rt2 = await page.evaluate(() => {
    const S = window.Keys.State;
    const json = S.toJSON();
    S.replace(S.defaultDoc());
    const wiped = S.get('articles.pages').length;
    S.replace(JSON.parse(json));
    return { wiped, restored: S.get('articles.pages').length,
             title: S.get('articles.pages.1.0.title') };
  });
  check('extra pages survive a save/load round trip',
    rt2.wiped === 1 && rt2.restored === 2 && rt2.title === 'SECOND SHEET',
    JSON.stringify(rt2));

  // Remove it again.
  const removed = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 500));
    window.confirm = () => true;
    window.Keys.App.structuralChange(null);
    await wait();
    window.Keys.App.removeAnnouncementPage(1);
    await wait();
    return {
      total: window.Keys.App.totalPages(),
      kinds: window.Keys.Render.pages().map(p => p.kind),
      ordinals: [...document.querySelectorAll('#page-stage .paper')]
        .map(p => Number(p.getAttribute('data-page'))),
      current: window.Keys.Flip.current()
    };
  });
  check('removing a page collapses the numbering back',
    removed.total === 4 &&
    JSON.stringify(removed.kinds) === JSON.stringify(
      ['front', 'announcements', 'slips', 'calendar']) &&
    JSON.stringify(removed.ordinals) === JSON.stringify([1, 2, 3, 4]),
    `total=${removed.total} ${JSON.stringify(removed.kinds)}`);
  check('the current page stays in range after a removal',
    removed.current >= 1 && removed.current <= removed.total,
    'on page ' + removed.current);

  // The last announcement page must not be removable.
  const lastOne = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 420));
    window.confirm = () => true;
    window.Keys.App.removeAnnouncementPage(0);
    await wait();
    return {
      pages: window.Keys.State.get('articles.pages').length,
      toast: [...document.querySelectorAll('#toasts .toast')]
        .map(t => t.textContent).join(' | '),
      delButtons: document.querySelectorAll(
        '#editor-scroll [data-act="page-del"]').length
    };
  });
  check('the last announcement page cannot be deleted',
    lastOne.pages === 1 && /at least one/i.test(lastOne.toast || ''),
    `pages=${lastOne.pages} toast=${lastOne.toast}`);
  check('and its delete button is not even offered',
    lastOne.delButtons === 0, lastOne.delButtons + ' delete buttons');

  // v2 save files (single fixed page 2) must still load.
  const legacyV2 = await page.evaluate(() => {
    const S = window.Keys.State;
    S.replace({
      meta: { version: 2 },
      masthead: { title: 'V2 FILE' },
      articles: {
        page1: [{ title: 'A', body: '<p>a</p>' }],
        page2: [{ title: 'OLD PAGE TWO', body: '<p>b</p>' }]
      }
    });
    return {
      title: S.get('masthead.title'),
      pages: S.get('articles.pages'),
      hasOldKey: 'page2' in S.doc.articles,
      version: S.doc.meta.version
    };
  });
  check('a v2 save file migrates its page 2 into the new page list',
    Array.isArray(legacyV2.pages) && legacyV2.pages.length === 1 &&
    legacyV2.pages[0][0].title === 'OLD PAGE TWO' && !legacyV2.hasOldKey,
    JSON.stringify(legacyV2));
  await resetDoc();

  /* -------------------------------------------------- arrange (drag/move)-- */
  section('Moving sections around the preview');
  await resetDoc();

  /** Simulate a drag: press the handle on `fromSel`, move to the centre of
   *  `toSel` biased by `yFrac`, release. Mirrors the real pointer sequence. */
  async function dragBlock(fromSel, toSel, yFrac) {
    return page.evaluate(async ([from, to, frac]) => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms == null ? 420 : ms));
      const src = document.querySelector(from);
      const dst = document.querySelector(to);
      if (!src) return { error: 'no source: ' + from };
      if (!dst) return { error: 'no target: ' + to };

      // Only one sheet is visible at a time, and a hidden one has
      // pointer-events:none — so turn to the source's page, exactly as a real
      // user would have to before they could grab anything on it.
      const owner = src.closest('.paper');
      if (owner) {
        window.Keys.Flip.go(Number(owner.getAttribute('data-page')),
                            { animate: false });
        await wait(220);
      }

      const sr = src.getBoundingClientRect();
      const stage = document.getElementById('page-stage');
      // Hover the block so the handle attaches to it.
      stage.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, clientX: sr.left + 6, clientY: sr.top + 6
      }));
      // pointermove is delegated from #page-stage; retarget through the block.
      src.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, clientX: sr.left + 6, clientY: sr.top + 6
      }));
      await wait(120);

      const handle = document.getElementById('arrange-handle');
      if (!handle || handle.hidden) return { error: 'handle did not appear' };
      const hr = handle.getBoundingClientRect();

      handle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, button: 0, pointerId: 1,
        clientX: hr.left + hr.width / 2, clientY: hr.top + hr.height / 2
      }));

      const dr = dst.getBoundingClientRect();
      const tx = dr.left + dr.width / 2;
      const ty = dr.top + dr.height * (frac == null ? 0.5 : frac);
      // Two moves: the first crosses the drag threshold.
      window.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: 1, clientX: tx, clientY: ty - 30
      }));
      window.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: 1, clientX: tx, clientY: ty
      }));
      await wait(60);
      const indicatorShown = !document.getElementById('arrange-indicator').hidden;
      const thumbHighlighted = document.querySelectorAll(
        '#thumb-rail .thumb.is-drop-target').length;

      window.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerId: 1, clientX: tx, clientY: ty
      }));
      await wait(600);
      return {
        indicatorShown, thumbHighlighted,
        toastText: [...document.querySelectorAll('#toasts .toast')]
          .map(t => t.textContent).join(' | ')
      };
    }, [fromSel, toSel, yFrac]);
  }

  const titlesOf = (listPath) => page.evaluate((p) =>
    (window.Keys.State.get(p) || []).map(a =>
      String(a.title).replace(/<[^>]*>/g, '').trim()), listPath);

  // 1. Reorder two announcements within page 2.
  const p2Before = await titlesOf('articles.pages.0');
  const d1 = await dragBlock(
    '#page-stage .paper[data-kind="announcements"] .nl-article:nth-of-type(1)',
    '#page-stage .paper[data-kind="announcements"] .nl-article:nth-of-type(2)', 0.9);
  const p2After = await titlesOf('articles.pages.0');
  check('a drag shows the drop indicator', d1.indicatorShown === true,
    JSON.stringify(d1));
  check('dragging an announcement below its neighbour reorders it',
    JSON.stringify(p2After) === JSON.stringify([p2Before[1], p2Before[0]]),
    `${JSON.stringify(p2Before)} -> ${JSON.stringify(p2After)}`);

  // 2. Reordering must never overlap or leave the sheet.
  await page.evaluate(() => window.Keys.Fit.refitAll({ force: true }));
  await page.waitForTimeout(300);
  const afterMoveOverflow = await page.evaluate(OVERFLOW_PROBE);
  for (const r of afterMoveOverflow) {
    check(`page ${r.page}: still inside the sheet after a move`, r.worst <= 1.0,
      `escapes ${r.worst}px past the ${r.worstEdge} edge — ${r.worstSel}`);
    check(`page ${r.page}: nothing clipped after a move`, r.clipped.length === 0,
      r.clipped.map(c => `${c.sel} by ${c.dy.toFixed(1)}px`).join('\n      '));
  }
  const overlaps = await page.evaluate(() => {
    // Siblings in a flow column can touch but must never overlap.
    const bad = [];
    document.querySelectorAll('#page-stage [data-drop]').forEach(cont => {
      const kind = cont.getAttribute('data-drop');
      const blocks = [...cont.querySelectorAll('[data-move="' + kind + '"]')]
        .filter(b => b.closest('[data-drop="' + kind + '"]') === cont)
        .map(b => b.getBoundingClientRect());
      for (let i = 1; i < blocks.length; i++) {
        if (blocks[i].top < blocks[i - 1].bottom - 0.5) {
          bad.push(`${kind}[${i - 1}] bottom ${blocks[i - 1].bottom.toFixed(1)} > ` +
                   `[${i}] top ${blocks[i].top.toFixed(1)}`);
        }
      }
    });
    return bad;
  });
  check('no two sections overlap anywhere', overlaps.length === 0,
    overlaps.join('\n      '));
  await resetDoc();

  // 3. Move an announcement from page 2 to page 1 (cross-page drag).
  const crossBefore = await page.evaluate(() => ({
    p1: window.Keys.State.get('articles.page1').length,
    p2: window.Keys.State.get('articles.pages.0').length
  }));
  const d2 = await dragBlock(
    '#page-stage .paper[data-kind="announcements"] .nl-article:nth-of-type(1)',
    '#thumb-rail .thumb[data-page="1"]', 0.5);
  const crossAfter = await page.evaluate(() => ({
    p1: window.Keys.State.get('articles.page1').length,
    p2: window.Keys.State.get('articles.pages.0').length,
    pinned: document.querySelectorAll('#page-stage .is-overflowing').length
  }));
  // Either it moved, or the guard refused it — both are correct outcomes, but
  // it must never end up half-applied or overflowing.
  const movedAcross = crossAfter.p1 === crossBefore.p1 + 1 &&
                      crossAfter.p2 === crossBefore.p2 - 1;
  const refused = crossAfter.p1 === crossBefore.p1 &&
                  crossAfter.p2 === crossBefore.p2;
  check('a cross-page drag either lands or is refused, never half-applied',
    movedAcross || refused,
    `${JSON.stringify(crossBefore)} -> ${JSON.stringify(crossAfter)}`);
  check('a refused move explains itself',
    !refused || /would not fit/i.test(d2.toastText || ''),
    'toast: ' + d2.toastText);
  check('the destination page thumbnail lights up while dragging over it',
    d2.thumbHighlighted === 1, 'highlighted thumbs: ' + d2.thumbHighlighted);
  ok('cross-page drag outcome', movedAcross ? 'moved to page 1' : 'refused (would overflow)');
  await resetDoc();

  // 4. The guard: force a page that is already at its limit, then try to add.
  const guard = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 450));
    const S = window.Keys.State;
    const LOREM = ('Every good newsletter needs a great deal of copy to fill ' +
      'the page from edge to edge. ').repeat(14);
    // Fill page 1 right to the brink.
    S.doc.articles.page1.forEach(a => { a.body = '<p>' + LOREM + '</p>'; });
    S.doc.articles.pages[0][0].body = '<p>' + LOREM + LOREM + '</p>';
    window.Keys.App.structuralChange(null);
    window.Keys.Fit.refitAll({ force: true });
    await wait();

    const before = {
      p1: S.get('articles.page1').length,
      p2: S.get('articles.pages.0').length,
      sig: window.Keys.Arrange.overflowSignature()
    };

    // Ask arrange to move page 2's monster article onto page 1.
    const block = document.querySelector(
      '#page-stage .paper[data-kind="announcements"] .nl-article');
    const container = document.querySelector(
      '#page-stage .paper[data-page="1"] .nl-articles');
    const kept = window.Keys.Arrange.commit(function () {
      return window.Keys.Arrange.apply(block, { container: container, index: 99 });
    }, null);
    await wait();

    return {
      kept,
      before,
      after: {
        p1: S.get('articles.page1').length,
        p2: S.get('articles.pages.0').length,
        sig: window.Keys.Arrange.overflowSignature()
      },
      toast: [...document.querySelectorAll('#toasts .toast')]
        .map(t => t.textContent).join(' | ')
    };
  });
  check('a move that would overflow is rolled back',
    guard.kept === false &&
    guard.after.p1 === guard.before.p1 && guard.after.p2 === guard.before.p2,
    `kept=${guard.kept} ${JSON.stringify(guard.before.p1)}/${guard.before.p2} -> ` +
    `${guard.after.p1}/${guard.after.p2}`);
  check('the rollback restores the previous fit state',
    JSON.stringify(guard.after.sig) === JSON.stringify(guard.before.sig),
    `${JSON.stringify(guard.before.sig)} vs ${JSON.stringify(guard.after.sig)}`);
  check('the user is told why the move was refused',
    /would not fit/i.test(guard.toast || ''), 'toast: ' + guard.toast);
  await resetDoc();

  // 5. Slips. Reordering within a column always fits; changing columns on the
  //    seeded issue does not, because page 3's left column already carries the
  //    full-height After School box. Both outcomes are correct and both are
  //    asserted, plus a column move on a lighter page that must succeed.
  const slipReorder = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 450));
    const S = window.Keys.State, A = window.Keys.Arrange;
    const rightIds = () => [...document.querySelectorAll(
      '#page-stage .slip-col[data-drop-col="right"] [data-move="slip"]')]
      .map(e => e.getAttribute('data-move-key'));
    const before = rightIds();
    const block = document.querySelector(
      '[data-move="slip"][data-move-key="' + before[1] + '"]');
    const col = document.querySelector('.slip-col[data-drop-col="right"]');
    const kept = A.commit(function () {
      return A.apply(block, { container: col, index: 0 });
    }, null);
    await wait();
    return { kept, before, after: rightIds() };
  });
  check('a slip can be reordered within its column',
    slipReorder.kept === true &&
    slipReorder.after[0] === slipReorder.before[1],
    `${JSON.stringify(slipReorder.before)} -> ${JSON.stringify(slipReorder.after)}`);
  await resetDoc();

  const slipRefused = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 450));
    const S = window.Keys.State, A = window.Keys.Arrange;
    const id = 'slip-hotdog';
    const before = S.doc.slips.find(s => s.id === id).column;
    const sigBefore = A.overflowSignature();
    const block = document.querySelector('[data-move="slip"][data-move-key="' + id + '"]');
    const leftCol = document.querySelector('.slip-col[data-drop-col="left"]');
    const kept = A.commit(function () {
      return A.apply(block, { container: leftCol, index: 0 });
    }, null);
    await wait();
    return {
      kept, before,
      after: S.doc.slips.find(s => s.id === id).column,
      scaleBefore: sigBefore.scales['3'],
      scaleAfter: A.overflowSignature().scales['3'],
      toast: [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent).join(' | ')
    };
  });
  check('a column move that would crush the page is refused and rolled back',
    slipRefused.kept === false && slipRefused.after === slipRefused.before &&
    Math.abs(slipRefused.scaleAfter - slipRefused.scaleBefore) < 0.01,
    `kept=${slipRefused.kept} column ${slipRefused.before}->${slipRefused.after} ` +
    `scale ${slipRefused.scaleBefore}->${slipRefused.scaleAfter}`);
  check('the refusal is explained', /would not fit/i.test(slipRefused.toast || ''),
    'toast: ' + slipRefused.toast);
  await resetDoc();

  // A column move that genuinely fits must land.
  const slipMoved = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 480));
    const S = window.Keys.State, A = window.Keys.Arrange;
    // Lighten page 3 so there is room to rebalance the columns.
    S.doc.slips = S.doc.slips.filter(s => s.type !== 'afterschool');
    window.Keys.App.structuralChange(null);
    window.Keys.Fit.refitAll({ force: true });
    await wait();

    const id = 'slip-hotdog';
    const before = S.doc.slips.find(s => s.id === id).column;
    const block = document.querySelector('[data-move="slip"][data-move-key="' + id + '"]');
    const leftCol = document.querySelector('.slip-col[data-drop-col="left"]');
    const kept = A.commit(function () {
      return A.apply(block, { container: leftCol, index: 0 });
    }, null);
    await wait();
    const leftIds = [...document.querySelectorAll(
      '#page-stage .slip-col[data-drop-col="left"] [data-move="slip"]')]
      .map(e => e.getAttribute('data-move-key'));
    return { kept, before, after: S.doc.slips.find(s => s.id === id).column,
             firstInLeft: leftIds[0], id };
  });
  check('a slip moves to the other column when there is room',
    slipMoved.kept === true && slipMoved.before === 'right' &&
    slipMoved.after === 'left',
    `kept=${slipMoved.kept} ${slipMoved.before} -> ${slipMoved.after}`);
  check('it lands at the requested position in that column',
    slipMoved.firstInLeft === slipMoved.id,
    `first in left is ${slipMoved.firstInLeft}, expected ${slipMoved.id}`);
  await resetDoc();

  // 6. Rail boxes reorder, and the order is persisted.
  const rail = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 420));
    const S = window.Keys.State;
    const before = S.get('railOrder').slice();
    const block = document.querySelector(
      '#page-stage [data-move="rail"][data-move-key="lookingAhead"]');
    const railEl = document.querySelector('#page-stage .nl-rail');
    window.Keys.Arrange.commit(function () {
      return window.Keys.Arrange.apply(block, { container: railEl, index: 0 });
    }, null);
    await wait();
    const domOrder = [...document.querySelectorAll(
      '#page-stage .nl-rail [data-move="rail"]')]
      .map(e => e.getAttribute('data-move-key'));
    const json = S.toJSON();
    return { before, after: S.get('railOrder'), domOrder,
             persisted: JSON.parse(json).railOrder };
  });
  check('the This Week / Looking Ahead boxes can be reordered',
    JSON.stringify(rail.after) === JSON.stringify(['lookingAhead', 'thisWeek']),
    `${JSON.stringify(rail.before)} -> ${JSON.stringify(rail.after)}`);
  check('the printed rail follows the new order',
    JSON.stringify(rail.domOrder) === JSON.stringify(rail.after),
    JSON.stringify(rail.domOrder));
  check('the order is saved with the newsletter',
    JSON.stringify(rail.persisted) === JSON.stringify(rail.after),
    JSON.stringify(rail.persisted));
  await resetDoc();

  // 7. Keyboard is a real alternative to dragging.
  const kbd = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 450));
    const S = window.Keys.State;
    const before = S.get('articles.page1').map(a =>
      String(a.title).replace(/<[^>]*>/g, '').trim());
    window.Keys.Flip.go(1, { animate: false });
    await new Promise(r => setTimeout(r, 250));
    const block = document.querySelector(
      '#page-stage .paper[data-page="1"] .nl-article');
    const sr = block.getBoundingClientRect();
    block.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: sr.left + 6, clientY: sr.top + 6 }));
    await new Promise(r => setTimeout(r, 120));
    const handle = document.getElementById('arrange-handle');
    const visible = !handle.hidden;
    handle.focus();
    handle.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'ArrowDown', bubbles: true }));
    await wait();
    return {
      visible,
      isButton: handle.tagName === 'BUTTON',
      hasLabel: /move/i.test(handle.getAttribute('aria-label') || ''),
      before,
      after: S.get('articles.page1').map(a =>
        String(a.title).replace(/<[^>]*>/g, '').trim())
    };
  });
  check('the drag handle is a focusable, labelled button',
    kbd.visible && kbd.isButton && kbd.hasLabel,
    `visible=${kbd.visible} button=${kbd.isButton} label=${kbd.hasLabel}`);
  check('arrow keys move a section without dragging',
    JSON.stringify(kbd.after) === JSON.stringify([kbd.before[1], kbd.before[0]]),
    `${JSON.stringify(kbd.before)} -> ${JSON.stringify(kbd.after)}`);
  await resetDoc();

  // 8. The handle must never become part of the printed page.
  const handleScope = await page.evaluate(() => ({
    inPaper: document.querySelectorAll('#page-stage .paper #arrange-layer,' +
      '#page-stage .paper .arrange-handle, .paper-flow .arrange-handle').length,
    layerParent: (document.getElementById('arrange-layer') || {}).parentElement
      ? document.getElementById('arrange-layer').parentElement.id : null
  }));
  check('the drag handle lives in the chrome, not inside the paper',
    handleScope.inPaper === 0 && handleScope.layerParent === 'preview-pane',
    `inPaper=${handleScope.inPaper} parent=${handleScope.layerParent}`);

  section('Page turning');
  const nav = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const F = window.Keys.Flip;
    const visible = () => Array.from(document.querySelectorAll('#page-stage .paper'))
      .filter(p => getComputedStyle(p).visibility !== 'hidden')
      .map(p => Number(p.getAttribute('data-page')));

    F.go(1, { animate: false }); await wait(120);
    const seq = [];

    F.next(); await wait(900);
    seq.push({ step: '1→2', cur: F.current(), vis: visible() });

    F.go(4); await wait(900);
    seq.push({ step: '2→4 (jump)', cur: F.current(), vis: visible() });

    F.prev(); await wait(900);
    seq.push({ step: '4→3', cur: F.current(), vis: visible() });

    // Interrupt a turn mid-flight, then let it settle.
    F.go(1); await wait(150); F.go(2); await wait(1200);
    seq.push({ step: 'interrupted', cur: F.current(), vis: visible() });

    // Clamping
    F.go(1, { animate: false }); await wait(80); F.prev(); await wait(400);
    const atStart = F.current();
    F.go(4, { animate: false }); await wait(80); F.next(); await wait(400);
    const atEnd = F.current();

    const stuck = Array.from(document.querySelectorAll('#page-stage .paper'))
      .filter(p => {
        const t = getComputedStyle(p).transform;
        return t && t !== 'none' && !/matrix\(1, 0, 0, 1, 0, 0\)/.test(t);
      })
      .map(p => p.getAttribute('data-page') + ':' + getComputedStyle(p).transform.slice(0, 40));

    return { seq, atStart, atEnd, stuck, dbg: F.debugState ? F.debugState() : null };
  });

  for (const s of nav.seq) {
    check(`${s.step} → page ${s.cur}, exactly one page visible`,
      s.vis.length === 1 && s.vis[0] === s.cur,
      `current=${s.cur} visible=[${s.vis}]`);
  }
  check('prev at page 1 clamps', nav.atStart === 1, 'got ' + nav.atStart);
  check('next at page 4 clamps', nav.atEnd === 4, 'got ' + nav.atEnd);
  check('no page left with a stuck transform', nav.stuck.length === 0,
    nav.stuck.join('\n      '));

  /* ----------------------------------------------------------------- zoom-- */
  section('Zoom / fit-to-view');
  const zoom = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const F = window.Keys.Flip;
    const vp = document.getElementById('stage-viewport');
    const out = [];
    for (const n of [1, 4]) {
      F.setZoom('fit'); F.go(n, { animate: false });
      await wait(300);
      const paper = document.querySelector('#page-stage .paper[data-page="' + n + '"]');
      const r = paper.getBoundingClientRect();
      const vr = vp.getBoundingClientRect();
      out.push({
        page: n, mode: F.getZoom().mode, scale: +F.getZoom().scale.toFixed(3),
        fitsW: r.width <= vr.width + 1, fitsH: r.height <= vr.height + 1,
        scrollable: vp.scrollHeight > vp.clientHeight + 1 || vp.scrollWidth > vp.clientWidth + 1,
        wRatio: +(r.width / vr.width).toFixed(2), hRatio: +(r.height / vr.height).toFixed(2)
      });
    }
    F.setZoom('fit'); F.go(1, { animate: false }); await wait(200);
    const before = F.getZoom().scale;
    F.zoomIn(); await wait(200);
    const zoomedIn = F.getZoom();
    F.setZoom('fit'); await wait(200);
    return { out, before, zoomedIn: { mode: zoomedIn.mode, scale: zoomedIn.scale } };
  });

  for (const z of zoom.out) {
    check(`page ${z.page} fits entirely in view at "fit" (scale ${z.scale})`,
      z.fitsW && z.fitsH && !z.scrollable,
      `fitsW=${z.fitsW} fitsH=${z.fitsH} scrollable=${z.scrollable} ratios=${z.wRatio}/${z.hRatio}`);
    check(`page ${z.page} fit uses the available space (>55%)`,
      Math.max(z.wRatio, z.hRatio) > 0.55,
      `largest ratio ${Math.max(z.wRatio, z.hRatio)}`);
  }
  check('zoom in switches to manual and enlarges',
    zoom.zoomedIn.mode === 'manual' && zoom.zoomedIn.scale > zoom.before,
    JSON.stringify(zoom.zoomedIn) + ' vs fit ' + zoom.before);

  /* ------------------------------------------------------------ save/load-- */
  section('Save / load round trip');
  const roundTrip = await page.evaluate(async () => {
    const S = window.Keys.State;
    S.set('masthead.date', 'ROUND TRIP 1/2/3');
    S.set('calendar.days.2026-06-11', 'ROUNDTRIP EVENT');
    const json = S.toJSON();
    const parsed = JSON.parse(json);
    // wipe, then reload
    S.replace(S.defaultDoc());
    const wiped = S.get('masthead.date');
    S.replace(parsed);
    await new Promise(r => setTimeout(r, 60));
    return {
      wiped,
      date: S.get('masthead.date'),
      day: S.get('calendar.days.2026-06-11'),
      slipCount: S.doc.slips.length,
      version: S.doc.meta.version,
      bytes: json.length
    };
  });
  check('save produces valid JSON', roundTrip.bytes > 1000, roundTrip.bytes + ' bytes');
  check('load restores edited text', roundTrip.date === 'ROUND TRIP 1/2/3', 'got ' + roundTrip.date);
  check('load restores calendar events', roundTrip.day === 'ROUNDTRIP EVENT', 'got ' + roundTrip.day);
  check('load restores structure', roundTrip.slipCount === 5, 'slips=' + roundTrip.slipCount);

  const legacy = await page.evaluate(() => {
    const S = window.Keys.State;
    S.replace({ 'input-title': 'OLD TITLE', 'input-date': 'OLD DATE',
                'input-main': '<p>old body</p>' });
    return { title: S.get('masthead.title'), date: S.get('masthead.date'),
             hasCal: !!S.doc.calendar, slips: S.doc.slips.length };
  });
  check('legacy v1 save file still loads',
    legacy.title === 'OLD TITLE' && legacy.date === 'OLD DATE' && legacy.hasCal,
    JSON.stringify(legacy));

  /* ------------------------------------------------- the file-name prompt -- */
  section('File name for Save and PDF');

  const suggestions = await page.evaluate(() => {
    const S = window.Keys.State, A = window.Keys.App;
    const cases = [
      'May 26, 2026',
      '<b>May&nbsp;26, 2026</b>',
      'Week of May 26, 2026',
      'May 26-30, 2026',
      'September 1, 2026',
      'Fall Issue',
      ''
    ];
    const out = {};
    cases.forEach(v => { S.set('masthead.date', v); out[v || '(empty)'] = A.suggestedName(); });
    S.set('masthead.date', 'May 26, 2026');
    return out;
  });
  check('the suggestion is "SP_Keys-" plus the page-1 date',
    suggestions['May 26, 2026'] === 'SP_Keys-May26_2026',
    suggestions['May 26, 2026']);
  check('markup and entities in the date field are resolved, not copied',
    suggestions['<b>May&nbsp;26, 2026</b>'] === 'SP_Keys-May26_2026',
    suggestions['<b>May&nbsp;26, 2026</b>']);
  check('the date is found even with words around it',
    suggestions['Week of May 26, 2026'] === 'SP_Keys-May26_2026',
    suggestions['Week of May 26, 2026']);
  check('a date range uses the first day',
    suggestions['May 26-30, 2026'] === 'SP_Keys-May26_2026',
    suggestions['May 26-30, 2026']);
  check('any month name works, not just the seeded one',
    suggestions['September 1, 2026'] === 'SP_Keys-September1_2026',
    suggestions['September 1, 2026']);
  check('a date that is not a date still yields a usable name',
    suggestions['Fall Issue'] === 'SP_Keys-Fall_Issue',
    suggestions['Fall Issue']);
  check('an empty date field falls back to today',
    /^SP_Keys-\d{4}-\d{2}-\d{2}$/.test(suggestions['(empty)']),
    suggestions['(empty)']);

  const cleaned = await page.evaluate(() => {
    const c = window.Keys.App.cleanFilename;
    return {
      slashes: c('../../etc/passwd', 'FB'),
      reserved: c('a:b*c?d"e<f>g|h', 'FB'),
      empty: c('   ', 'FB'),
      nullish: c(null, 'FB'),
      leadingDot: c('.hidden', 'FB'),
      long: c('x'.repeat(400), 'FB').length,
      keeps: c('SP_Keys-May26_2026', 'FB')
    };
  });
  check('a typed name cannot contain a path',
    !/[\/\\]/.test(cleaned.slashes), cleaned.slashes);
  check('Windows-reserved characters are replaced',
    !/[:*?"<>|]/.test(cleaned.reserved), cleaned.reserved);
  check('a blank name falls back to the suggestion',
    cleaned.empty === 'FB' && cleaned.nullish === 'FB',
    `blank="${cleaned.empty}" null="${cleaned.nullish}"`);
  check('a leading dot cannot make a hidden file',
    cleaned.leadingDot.charAt(0) !== '.', cleaned.leadingDot);
  check('an absurdly long name is truncated',
    cleaned.long <= 120, 'length=' + cleaned.long);
  check('an ordinary name passes through untouched',
    cleaned.keeps === 'SP_Keys-May26_2026', cleaned.keeps);

  /* --- the dialog itself --- */
  await page.click('[data-act="save"]');
  await page.waitForTimeout(300);
  const dlgOpen = await page.evaluate(() => {
    const d = document.getElementById('name-dialog');
    const i = document.getElementById('name-dialog-input');
    return {
      open: d.open,
      modal: d.matches(':modal'),
      title: document.getElementById('name-dialog-title').textContent,
      ext: document.getElementById('name-dialog-ext').textContent,
      ok: document.getElementById('name-dialog-ok').textContent,
      placeholder: i.placeholder,
      value: i.value,
      focused: document.activeElement === i
    };
  });
  check('the Save button asks for a name instead of downloading straight away',
    dlgOpen.open === true && dlgOpen.modal === true,
    `open=${dlgOpen.open} modal=${dlgOpen.modal}`);
  check('the suggested name is the placeholder, not a value to clear first',
    dlgOpen.placeholder === 'SP_Keys-May26_2026' && dlgOpen.value === '',
    `placeholder="${dlgOpen.placeholder}" value="${dlgOpen.value}"`);
  check('the dialog names the action and the extension',
    /save/i.test(dlgOpen.title) && dlgOpen.ext === '.json' && /save/i.test(dlgOpen.ok),
    `title="${dlgOpen.title}" ext="${dlgOpen.ext}" ok="${dlgOpen.ok}"`);
  check('the name field takes focus so you can just type',
    dlgOpen.focused === true);

  // Esc must dismiss the dialog the Save click opened — a real key press, not
  // a synthesised close(), because Esc bypasses the submit handler entirely.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const afterEsc = await page.evaluate(() =>
    document.getElementById('name-dialog').open);
  check('Escape closes the dialog', afterEsc === false, 'open=' + afterEsc);

  const answers = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const A = window.Keys.App;
    const d = document.getElementById('name-dialog');
    const input = document.getElementById('name-dialog-input');
    const form = document.getElementById('name-dialog-form');
    const ask = () => A.askFilename({
      title: 'Save newsletter', note: '', ext: '.json',
      okLabel: 'Save', suggestion: A.suggestedName()
    });

    // 1. submit with the field left empty -> the suggestion
    let p = ask(); await wait(150);
    form.requestSubmit(); const blank = await p;

    // 2. type a name -> that name
    p = ask(); await wait(150);
    input.value = '  June newsletter  ';
    form.requestSubmit(); const typed = await p;

    // 3. Cancel -> null, and nothing is written
    p = ask(); await wait(150);
    d.querySelector('[data-dlg="cancel"]').click();
    const cancelled = await p;

    // 4. a click on the backdrop -> also a cancel
    p = ask(); await wait(150);
    d.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const backdrop = await p;

    // 5. a name containing a path -> scrubbed, still resolves
    p = ask(); await wait(150);
    input.value = 'a/b:c';
    form.requestSubmit(); const nasty = await p;

    await wait(120);
    return { blank, typed, cancelled, backdrop, nasty, stillOpen: d.open };
  });
  check('submitting an empty field accepts the suggestion',
    answers.blank === 'SP_Keys-May26_2026', String(answers.blank));
  check('a typed name is used, trimmed',
    answers.typed === 'June newsletter', String(answers.typed));
  check('Cancel resolves to null so nothing is saved',
    answers.cancelled === null, String(answers.cancelled));
  check('clicking the backdrop cancels too',
    answers.backdrop === null, String(answers.backdrop));
  check('a path typed into the dialog is scrubbed on the way out',
    typeof answers.nasty === 'string' && !/[\/\\:]/.test(answers.nasty),
    String(answers.nasty));
  check('the dialog closes behind itself every time',
    answers.stillOpen === false, 'open=' + answers.stillOpen);

  /* --- the name reaches the actual download --- */
  let downloadName = null;
  try {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 6000 }),
      page.evaluate(() => window.Keys.App.writeSaveFile('June newsletter'))
    ]);
    downloadName = dl.suggestedFilename();
    await dl.delete().catch(() => {});
  } catch (e) {
    downloadName = 'ERR: ' + e.message;
  }
  check('the chosen name is what the file is actually saved as',
    downloadName === 'June newsletter.json', String(downloadName));

  let doubleExt = null;
  try {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 6000 }),
      page.evaluate(() => window.Keys.App.writeSaveFile('already.json'))
    ]);
    doubleExt = dl.suggestedFilename();
    await dl.delete().catch(() => {});
  } catch (e) {
    doubleExt = 'ERR: ' + e.message;
  }
  check('a name already ending in .json does not get a second one',
    doubleExt === 'already.json', String(doubleExt));

  /* --- the PDF path parks the name in document.title, then puts it back --- */
  const pdfName = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const realPrint = window.print;
    let titleAtPrint = null;
    window.print = function () { titleAtPrint = document.title; };

    const before = document.title;
    window.Keys.App.printDoc();
    await wait(200);
    const d = document.getElementById('name-dialog');
    const snap = {
      open: d.open,
      title: document.getElementById('name-dialog-title').textContent,
      ext: document.getElementById('name-dialog-ext').textContent,
      placeholder: document.getElementById('name-dialog-input').placeholder
    };
    document.getElementById('name-dialog-input').value = 'Keys June 2026.pdf';
    document.getElementById('name-dialog-form').requestSubmit();
    await wait(400);

    window.dispatchEvent(new Event('afterprint'));
    await wait(400);
    window.print = realPrint;
    return { snap, before, titleAtPrint, after: document.title };
  });
  check('the PDF button asks for a name too, offering .pdf',
    pdfName.snap.open === true && pdfName.snap.ext === '.pdf' &&
    /pdf/i.test(pdfName.snap.title),
    `open=${pdfName.snap.open} ext="${pdfName.snap.ext}" title="${pdfName.snap.title}"`);
  check('the PDF dialog suggests the same name as Save',
    pdfName.snap.placeholder === 'SP_Keys-May26_2026', pdfName.snap.placeholder);
  check('the chosen name is what the print dialog will suggest',
    pdfName.titleAtPrint === 'Keys June 2026',
    `document.title at print = "${pdfName.titleAtPrint}"`);
  check('the tab title is put back afterwards',
    pdfName.after === pdfName.before,
    `before="${pdfName.before}" after="${pdfName.after}"`);

  await resetDoc();

  /* ------------------------------------------------------- toolbar / robust--
   * Regressions for defects found by code review that every check above
   * missed. The toolbar formatting path in particular had no coverage at all.
   * ---------------------------------------------------------------------- */
  async function selectAllIn(pagePath, sectionKey) {
    return page.evaluate(async ([p, key]) => {
      const wait = () => new Promise(r => setTimeout(r, 280));
      if (key) {
        const sec = document.querySelector(
          '#editor-scroll .ed-section[data-section="' + key + '"]');
        if (sec) sec.classList.add('is-open');
        await wait();
      }
      const f = document.querySelector('#editor-scroll .rt[data-path="' + p + '"]');
      if (!f) return false;
      f.focus();
      const sel = window.getSelection();
      const rng = document.createRange();
      rng.selectNodeContents(f);
      sel.removeAllRanges();
      sel.addRange(rng);
      document.dispatchEvent(new Event('selectionchange'));
      await wait();
      return true;
    }, [pagePath, sectionKey]);
  }

  async function resetDoc() {
    await page.evaluate(async () => {
      window.Keys.State.replace(window.Keys.State.defaultDoc());
      window.Keys.App.structuralChange(null);
      await new Promise(r => setTimeout(r, 300));
    });
  }

  section('Toolbar formatting');

  await resetDoc();
  await selectAllIn('articles.page1.0.body', 'page1');
  const staleSel = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 300));
    const S = window.Keys.State;
    const survivorBody = S.get('articles.page1.1.body');

    document.querySelector(
      '[data-act="list-del"][data-list="articles.page1"][data-index="0"]').click();
    await wait();
    // Bold, with the previously-focused field now detached by the re-render.
    document.querySelector('#format-group .tb-btn[data-fmt="bold"]').click();
    await wait();

    const list = S.get('articles.page1');
    return {
      len: Array.isArray(list) ? list.length : 'NOT-ARRAY',
      body0: S.get('articles.page1.0.body'),
      survivorBody,
      hasTitle0: !!(list && list[0] && list[0].title),
      articlesInDom: document.querySelectorAll(
        '#page-stage .paper[data-page="1"] .nl-article').length
    };
  });
  check('deleting a section leaves exactly one behind', staleSel.len === 1,
    'length=' + staleSel.len);
  check('formatting after a delete does NOT overwrite the surviving section',
    staleSel.body0 === staleSel.survivorBody,
    'surviving body now: ' + String(staleSel.body0).slice(0, 60));
  check('formatting after a delete does not resurrect a ghost item',
    staleSel.len === staleSel.articlesInDom && staleSel.hasTitle0,
    `state=${staleSel.len} dom=${staleSel.articlesInDom} hasTitle=${staleSel.hasTitle0}`);

  await resetDoc();
  await selectAllIn('articles.pages.0.0.body', 'page2');
  const fontSize = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 320));
    const dd = document.querySelector('#format-group .tb-select[data-fmt="fontSize"]');
    dd.value = '7';
    dd.dispatchEvent(new Event('change', { bubbles: true }));
    await wait();
    window.Keys.Fit.refitAll({ force: true });
    await wait();
    const stored = String(window.Keys.State.get('articles.pages.0.0.body'));
    return {
      hasFontTag: /<font[\s>]/i.test(stored),
      hasEm: /font-size:\s*[\d.]+em/i.test(stored),
      measure: window.Keys.Fit.measure(
        document.querySelector('#page-stage .paper[data-kind="announcements"]'))
    };
  });
  check('Size dropdown stores a relative (em) size, not <font size>',
    !fontSize.hasFontTag && fontSize.hasEm,
    `fontTag=${fontSize.hasFontTag} em=${fontSize.hasEm}`);
  check('page still fits after applying the largest text size',
    fontSize.measure && fontSize.measure.overflow === false,
    'overflows by ' + (fontSize.measure && fontSize.measure.px) + 'px');

  await resetDoc();
  await selectAllIn('masthead.title', 'page1');
  const blockGate = await page.evaluate(async () => {
    document.querySelector('#format-group .tb-btn[data-fmt="insertUnorderedList"]').click();
    await new Promise(r => setTimeout(r, 260));
    return { title: String(window.Keys.State.get('masthead.title')) };
  });
  check('a bulleted list cannot be applied to a single-line field',
    !/<ul|<li/i.test(blockGate.title), 'stored: ' + blockGate.title.slice(0, 70));

  /* ------------------------------------------------------ click-to-edit --
   * Clicking a region on the paper must focus the field that feeds it.
   * ---------------------------------------------------------------------- */
  section('Click a preview region to edit it');
  await resetDoc();

  /** Click the centre of a preview element and report what got focused. */
  async function clickPreview(selector, opts) {
    return page.evaluate(async ([sel, o]) => {
      const wait = () => new Promise(r => setTimeout(r, 420));
      const probe = document.querySelector(sel);
      if (!probe) return { error: 'no such preview element: ' + sel };

      // Turn to the page the target actually lives on. Inactive pages are
      // visibility:hidden with pointer-events:none, so elementFromPoint would
      // otherwise return whatever sits at those coordinates on the live page —
      // which is exactly what a real user could never click.
      const owner = probe.closest('.paper');
      const pageNo = owner ? Number(owner.getAttribute('data-page')) : 1;
      window.Keys.Flip.go(pageNo, { animate: false });

      // Nothing focused, every section shut, so we can prove the jump both
      // opens the right section and focuses the right field.
      document.querySelectorAll('#editor-scroll .ed-section')
        .forEach(s => s.classList.remove('is-open'));
      if (document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
      }
      await wait();

      const el = document.querySelector(sel);
      if (!el) return { error: 'element vanished after navigating: ' + sel };
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return { error: 'preview element has no box: ' + sel };

      // Aim at a fraction of the element's height so we can target blank space.
      const y = r.top + r.height * (o && o.yFrac != null ? o.yFrac : 0.5);
      const x = r.left + r.width * 0.5;
      const hit = document.elementFromPoint(x, y);
      if (!hit) return { error: 'nothing at the click point' };
      hit.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, clientX: x, clientY: y
      }));
      await wait();

      const a = document.activeElement;
      const sec = a && a.closest ? a.closest('.ed-section') : null;
      return {
        focusedPath: a ? a.getAttribute('data-path') : null,
        isEditorField: !!(a && a.classList && a.classList.contains('rt')),
        sectionOpen: !!(sec && sec.classList.contains('is-open')),
        sectionKey: sec ? sec.getAttribute('data-section') : null,
        flashed: !!(a && a.classList && a.classList.contains('is-jumped')),
        caretAtEnd: (function () {
          const s = window.getSelection();
          if (!a || !s || !s.rangeCount || !a.isContentEditable) return null;
          return s.isCollapsed && s.anchorOffset > 0;
        })(),
        page: window.Keys.Flip.current()
      };
    }, [selector, opts || {}]);
  }

  const c1 = await clickPreview('#page-stage .paper[data-page="1"] [data-bind="classroom.body"]');
  check('clicking the main article focuses its field',
    c1.focusedPath === 'classroom.body' && c1.isEditorField,
    'focused ' + JSON.stringify(c1));
  check('the jump opens the collapsed section it lands in',
    c1.sectionOpen === true && c1.sectionKey === 'page1',
    `open=${c1.sectionOpen} section=${c1.sectionKey}`);
  check('the jumped-to field is flashed', c1.flashed === true);
  check('the caret is placed at the end, ready to type', c1.caretAtEnd === true,
    'caretAtEnd=' + c1.caretAtEnd);

  const c2 = await clickPreview(
    '#page-stage .paper[data-page="1"] [data-bind="thisWeek.rows.3.event"]');
  check('clicking one This Week row focuses that exact row',
    c2.focusedPath === 'thisWeek.rows.3.event', 'focused ' + c2.focusedPath);

  // Blank lower area of a calendar day: must still resolve to that day.
  const c3 = await clickPreview(
    '#page-stage .paper[data-kind="calendar"] .cal-cell[data-iso="2026-06-15"]',
    { yFrac: 0.88 });
  check('clicking the blank part of a calendar day focuses that day',
    c3.focusedPath === 'calendar.days.2026-06-15',
    'focused ' + c3.focusedPath);
  check('the calendar jump opens the page-4 section',
    c3.sectionKey === 'page4' && c3.sectionOpen === true,
    `section=${c3.sectionKey} open=${c3.sectionOpen}`);

  // A slip's padding, not its text.
  const c4 = await clickPreview(
    '#page-stage .paper[data-kind="slips"] .slip[data-slip-id="slip-pizza"]',
    { yFrac: 0.03 });
  check('clicking a slip box focuses one of its fields',
    typeof c4.focusedPath === 'string' && /^slips\.\d+\./.test(c4.focusedPath),
    'focused ' + c4.focusedPath);
  check('the slip jump opens the page-3 section', c4.sectionKey === 'page3',
    'section=' + c4.sectionKey);

  const c5 = await clickPreview(
    '#page-stage .paper[data-kind="announcements"] [data-bind="articles.pages.0.1.title"]');
  check('clicking a page-2 heading focuses that heading',
    c5.focusedPath === 'articles.pages.0.1.title', 'focused ' + c5.focusedPath);
  check('the jump leaves the preview on the page that was clicked',
    c5.page === 2, 'on page ' + c5.page);

  // The calendar's month/year title is DERIVED, so it has no data-bind. It
  // must still jump to the month dropdown rather than to a neighbouring field.
  const c8 = await clickPreview('#page-stage .paper[data-kind="calendar"] .cal-month');
  check('clicking the calendar month/year opens the month dropdown',
    c8.focusedPath === 'calendar.month', 'focused ' + c8.focusedPath);
  check('that jump opens the calendar section', c8.sectionKey === 'page4' &&
    c8.sectionOpen === true, `section=${c8.sectionKey} open=${c8.sectionOpen}`);

  const c8b = await page.evaluate(() => {
    const title = document.querySelector('#page-stage .paper[data-kind="calendar"] .cal-month');
    const a = document.activeElement;
    const monthSel = document.querySelector(
      '#editor-scroll .pt[data-path="calendar.month"]');
    const yearSel = document.querySelector(
      '#editor-scroll .pt[data-path="calendar.year"]');
    const yearBox = yearSel ? yearSel.getBoundingClientRect() : null;
    return {
      isSelect: !!(a && a.tagName === 'SELECT'),
      isMonth: a === monthSel,
      flashed: !!(a && a.classList && a.classList.contains('is-jumped')),
      // The year dropdown must be on screen too — the user asked for the
      // month/year section, not just one control.
      yearVisible: !!yearBox && yearBox.height > 0 &&
        yearBox.top > 0 && yearBox.bottom < window.innerHeight,
      titleEdits: title.getAttribute('data-edits'),
      titleHasBind: title.hasAttribute('data-bind'),
      cursor: getComputedStyle(title).cursor
    };
  });
  check('the focused control is the month <select>',
    c8b.isSelect && c8b.isMonth,
    `isSelect=${c8b.isSelect} isMonth=${c8b.isMonth}`);
  check('the month dropdown is flashed on arrival', c8b.flashed === true);
  check('the year dropdown is on screen alongside it',
    c8b.yearVisible === true);
  check('the title declares data-edits and is not a bound output',
    c8b.titleEdits === 'calendar.month' && !c8b.titleHasBind,
    `edits=${c8b.titleEdits} hasBind=${c8b.titleHasBind}`);
  check('the title shows a pointer cursor', c8b.cursor === 'pointer',
    'cursor=' + c8b.cursor);

  // Changing the month from there must actually retitle the sheet.
  const c8c = await page.evaluate(async () => {
    const sel = document.activeElement;
    sel.value = '0';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 340));
    const t = document.querySelector('#page-stage .paper[data-kind="calendar"] .cal-month');
    return { title: t ? t.textContent.trim() : null,
             month: window.Keys.State.get('calendar.month') };
  });
  check('changing the month from that dropdown retitles the sheet',
    c8c.month === 0 && /JANUARY/i.test(c8c.title || ''),
    `month=${c8c.month} title=${c8c.title}`);
  await resetDoc();

  // The neighbouring bound fields inside the same title box must still win
  // when they are what was actually clicked.
  const c9 = await clickPreview(
    '#page-stage .paper[data-kind="calendar"] [data-bind="calendar.schoolName"]');
  check('clicking the school name still focuses the school name',
    c9.focusedPath === 'calendar.schoolName', 'focused ' + c9.focusedPath);

  // Selecting text to copy must NOT steal focus into the editor.
  const c6 = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 380));
    window.Keys.Flip.go(1, { animate: false });
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    await wait();
    const el = document.querySelector('#page-stage [data-bind="classroom.body"]');
    const rng = document.createRange();
    rng.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(rng);
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
    }));
    await wait();
    const a = document.activeElement;
    return {
      selectionKept: !!String(window.getSelection()).trim(),
      focusedField: !!(a && a.classList && a.classList.contains('rt'))
    };
  });
  check('selecting preview text to copy does not hijack focus',
    c6.selectionKept === true && c6.focusedField === false,
    `selectionKept=${c6.selectionKept} focusedField=${c6.focusedField}`);

  // The handler lives on #page-stage, whose children are replaced on every
  // structural change — so it must survive one.
  const c7 = await page.evaluate(async () => {
    window.Keys.App.structuralChange(null);
    await new Promise(r => setTimeout(r, 400));
    return true;
  }).then(() => clickPreview(
    '#page-stage .paper[data-page="1"] [data-bind="classroom.verse"]'));
  check('click-to-edit still works after a structural re-render',
    c7.focusedPath === 'classroom.verse', 'focused ' + c7.focusedPath);

  await resetDoc();

  section('Hostile / malformed save files');
  const hostile = await page.evaluate(async () => {
    const S = window.Keys.State;
    const out = {};

    out.arrayRoot = S.replace([]) === null && !Array.isArray(S.doc);
    S.replace(S.defaultDoc());
    out.stringifyKeepsFields = /masthead/.test(S.toJSON());

    let threw = null;
    try {
      S.replace({ meta: { version: 2 }, masthead: { title: 'AFTER LOAD' },
                  thisWeek: { heading: 'X', rows: { '0': { date: 'a', event: 'b' } } } });
      window.Keys.App.structuralChange(null);
    } catch (e) { threw = e.message; }
    await new Promise(r => setTimeout(r, 320));
    out.objectListThrew = threw;
    out.objectListRows = Array.isArray(S.get('thisWeek.rows'))
      ? S.get('thisWeek.rows').length : 'NOT-ARRAY';
    const domTitle = document.querySelector('#page-stage [data-bind="masthead.title"]');
    out.domMatchesState = !!domTitle && domTitle.innerHTML === S.get('masthead.title');

    S.replace({ masthead: { title:
      'A<img src="http://example.invalid/pixel.png">' +
      '<span style="background:url(http://example.invalid/beacon.png)">B</span>' +
      '<span style="position:fixed;left:4px;top:120px;z-index:999">ESCAPED</span>' +
      '<scr' + 'ipt>window.__pwned=1</scr' + 'ipt>' +
      '<b onclick="window.__pwned=1">bold</b>' } });
    const t = String(S.get('masthead.title'));
    out.scrubbed = {
      img: /<img/i.test(t), url: /url\(/i.test(t),
      position: /position\s*:/i.test(t), script: /<scr/i.test(t),
      onclick: /onclick/i.test(t),
      keptBold: /<b>/i.test(t), keptText: /bold/.test(t)
    };

    S.replace({ slips: [{ type: 'lunch' }, { type: 'lunch' },
                        { type: 'custom', id: 'dup' }, { type: 'custom', id: 'dup' }] });
    const ids = S.doc.slips.map(s => s.id);
    out.ids = { n: ids.length, allTruthy: ids.every(Boolean),
                unique: new Set(ids).size === ids.length };

    S.replace({ calendar: { month: 15, year: 2026 } });
    out.rolled = { m: S.get('calendar.month'), y: S.get('calendar.year') };
    S.replace({ calendar: { month: 1e9, year: 2026 } });
    out.absurdInRange = S.get('calendar.month') >= 0 && S.get('calendar.month') <= 11;
    S.replace({ calendar: { month: 5, year: '' } });
    out.badYear = Number.isFinite(S.get('calendar.year')) && S.get('calendar.year') > 1000;

    S.replace({ calendar: { month: 5, year: 2026,
      days: { 'not-a-date': 'x', '2026-06-05': 'keep', '2026-6-5': 'y' } } });
    out.days = Object.keys(S.get('calendar.days'));

    S.replace(S.defaultDoc());
    window.Keys.App.structuralChange(null);
    await new Promise(r => setTimeout(r, 320));
    out.pwned = !!window.__pwned;
    return out;
  });

  check('an array root is rejected outright', hostile.arrayRoot === true);
  check('Save output still contains the document fields',
    hostile.stringifyKeepsFields === true);
  check('an object-shaped list is repaired instead of throwing',
    hostile.objectListThrew === null && hostile.objectListRows === 1,
    `threw=${hostile.objectListThrew} rows=${hostile.objectListRows}`);
  check('preview and state agree after a malformed load',
    hostile.domMatchesState === true);
  check('loaded HTML cannot reach the network (no <img>, no url())',
    !hostile.scrubbed.img && !hostile.scrubbed.url, JSON.stringify(hostile.scrubbed));
  check('loaded HTML cannot escape the sheet via position/z-index',
    !hostile.scrubbed.position, JSON.stringify(hostile.scrubbed));
  check('scripts and inline handlers are stripped',
    !hostile.scrubbed.script && !hostile.scrubbed.onclick && !hostile.pwned,
    JSON.stringify(hostile.scrubbed) + ' pwned=' + hostile.pwned);
  check('legitimate formatting survives scrubbing',
    hostile.scrubbed.keptBold && hostile.scrubbed.keptText,
    JSON.stringify(hostile.scrubbed));
  check('every slip is given a unique id',
    hostile.ids.n === 4 && hostile.ids.allTruthy && hostile.ids.unique,
    JSON.stringify(hostile.ids));
  check('an out-of-range month rolls into a real month/year',
    hostile.rolled.m === 3 && hostile.rolled.y === 2027, JSON.stringify(hostile.rolled));
  check('an absurd month falls back in range', hostile.absurdInRange === true);
  check('a blank year falls back to a real year', hostile.badYear === true);
  // `reconcile` merges plain objects, so the seed month's days are still
  // present alongside the loaded ones; what matters is that unreachable keys
  // are gone and the valid one survived.
  check('non-ISO calendar day keys are dropped',
    !hostile.days.includes('not-a-date') && !hostile.days.includes('2026-6-5') &&
    hostile.days.includes('2026-06-05') &&
    hostile.days.every(k => /^\d{4}-\d{2}-\d{2}$/.test(k)),
    JSON.stringify(hostile.days));

  section('Recovery from a corrupt autosave');
  const storageKey = await page.evaluate(() => window.Keys.State.STORAGE_KEY);
  await page.evaluate((key) => {
    localStorage.setItem(key, JSON.stringify({
      meta: { version: 2 }, masthead: { title: 'CORRUPT' },
      thisWeek: { rows: { '0': { date: 'a', event: 'b' } } },
      articles: { page1: 'not-a-list', page2: 7 },
      slips: 'nope', calendar: 42
    }));
  }, storageKey);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  const recovery = await page.evaluate(() => ({
    papers: document.querySelectorAll('#page-stage .paper').length,
    sections: document.querySelectorAll('#editor-scroll .ed-section').length,
    thumbs: document.querySelectorAll(
      '#thumb-rail .thumb:not(.thumb--add)').length,
    addPageBtn: document.querySelectorAll('#thumb-rail .thumb--add').length,
    total: window.Keys.Flip.debugState().total,
    // Proves wire() ran: the next-page button must actually navigate.
    wired: (function () {
      var before = window.Keys.Flip.current();
      var btn = document.querySelector('[data-act="next"]');
      if (!btn) return false;
      btn.click();
      return window.Keys.Flip.current() !== before;
    })()
  }));
  check('a corrupt autosave still boots all 4 pages', recovery.papers === 4,
    'papers=' + recovery.papers + ' flipTotal=' + recovery.total);
  check('a corrupt autosave still boots the editor rail', recovery.sections === 4,
    'sections=' + recovery.sections);
  check('the UI is wired and clickable after recovery', recovery.wired === true,
    'next-page navigation responded: ' + recovery.wired);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });

  /* --------------------------------------------------- save-for-later ----
   * The drawer down the right edge of the preview pane. Runs in its own
   * context: it writes to a persistent store of its own, and the rest of the
   * suite must not inherit whatever it leaves behind.
   * ---------------------------------------------------------------------- */
  section('Save-for-later drawer');

  const stashCtx = await browser.newContext({ viewport: { width: 1500, height: 980 } });
  const stash = await stashCtx.newPage();
  const stashErrors = [];
  stash.on('pageerror', e => stashErrors.push(e.message));
  await stash.goto(URL, { waitUntil: 'load' });
  await stash.waitForTimeout(800);

  const drawerClosed = await stash.evaluate(() => {
    const el = document.getElementById('stash');
    const handle = document.getElementById('stash-handle');
    const pane = document.getElementById('preview-pane');
    const pr = pane.getBoundingClientRect();
    const hr = handle.getBoundingClientRect();
    return {
      exists: !!el,
      insidePreviewPane: !!el.closest('#preview-pane'),
      open: el.classList.contains('is-open'),
      // Closed, the panel is clipped away and only the handle is left.
      panelOffscreen: el.getBoundingClientRect().left >= pr.right - 2,
      handleOnScreen: hr.right <= pr.right + 1 && hr.left >= pr.left &&
                      hr.width > 10 && hr.height > 40,
      handleExpanded: handle.getAttribute('aria-expanded'),
      // Off-screen controls must be out of the tab order.
      panelInert: document.getElementById('stash-panel').hasAttribute('inert'),
      seeded: window.Keys.Stash.count(),
      names: window.Keys.Stash.items().map(i => i.name)
    };
  });

  check('the drawer lives in the preview pane, on its right edge',
    drawerClosed.exists && drawerClosed.insidePreviewPane,
    JSON.stringify({ exists: drawerClosed.exists,
                     inPane: drawerClosed.insidePreviewPane }));
  check('it starts closed, with only its handle showing',
    !drawerClosed.open && drawerClosed.panelOffscreen &&
    drawerClosed.handleOnScreen,
    JSON.stringify(drawerClosed));
  check('the closed panel is out of the tab order',
    drawerClosed.panelInert === true);
  check('it is pre-populated from the lunch slips page',
    drawerClosed.seeded === 5, 'items=' + drawerClosed.seeded);
  /* The seeded names come from multi-line headings; textContent alone runs
   * them together into an unreadable "THIS THURSDAY, 5/28FOR LUNCHHOTDOG…". */
  check('seeded names are the first line of each heading, not run together',
    drawerClosed.names.every(n => n.length <= 45 && !/[a-z][A-Z]{2}/.test(n)) &&
    drawerClosed.names.indexOf('THIS THURSDAY, 5/28') !== -1,
    JSON.stringify(drawerClosed.names));

  // Clicking the handle slides it out.
  await stash.click('#stash-handle');
  await stash.waitForTimeout(600);
  const drawerOpen = await stash.evaluate(() => {
    const el = document.getElementById('stash');
    const list = document.getElementById('stash-list');
    const pane = document.getElementById('preview-pane').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
      open: el.classList.contains('is-open'),
      onScreen: r.right <= pane.right + 2 && r.left < pane.right - 100,
      expanded: document.getElementById('stash-handle').getAttribute('aria-expanded'),
      inert: document.getElementById('stash-panel').hasAttribute('inert'),
      rows: list.children.length,
      // The list, not the drawer, is what scrolls.
      listScrolls: getComputedStyle(list).overflowY === 'auto',
      handleStillVisible:
        document.getElementById('stash-handle').getBoundingClientRect().width > 10
    };
  });
  check('clicking the handle slides the drawer open',
    drawerOpen.open && drawerOpen.onScreen && drawerOpen.expanded === 'true',
    JSON.stringify(drawerOpen));
  check('opening it puts its controls back in the tab order',
    drawerOpen.inert === false);
  check('every saved item is listed, and the list is the part that scrolls',
    drawerOpen.rows === 5 && drawerOpen.listScrolls === true,
    `rows=${drawerOpen.rows} overflowY=${drawerOpen.listScrolls}`);
  check('the handle stays reachable while the drawer is open',
    drawerOpen.handleStillVisible === true);

  // Enough items to actually need scrolling.
  const scrolls = await stash.evaluate(async () => {
    const S = window.Keys.Stash;
    const slip = window.Keys.State.doc.slips[0];
    for (let i = 0; i < 20; i++) S.add('Filler box ' + i, 'slip', slip);
    await new Promise(r => setTimeout(r, 250));
    const list = document.getElementById('stash-list');
    const el = document.getElementById('stash');
    const pane = document.getElementById('preview-pane').getBoundingClientRect();
    return {
      count: S.count(),
      scrollable: list.scrollHeight > list.clientHeight + 2,
      // A long list must not push the drawer past the pane.
      drawerWithinPane: el.getBoundingClientRect().bottom <= pane.bottom + 2
    };
  });
  check('a full drawer scrolls rather than growing past the pane',
    scrolls.scrollable && scrolls.drawerWithinPane,
    JSON.stringify(scrolls));

  const stashCapped = await stash.evaluate(() => {
    const S = window.Keys.Stash;
    const slip = window.Keys.State.doc.slips[0];
    let err = null;
    for (let i = 0; i < 60 && !err; i++) {
      const res = S.add('Overflow ' + i, 'slip', slip);
      if (res.error) err = res.error;
    }
    return { err, count: S.count(), max: S.MAX_ITEMS };
  });
  check('the drawer is stashCapped, with an explanation rather than silent loss',
    /full/i.test(stashCapped.err || '') && stashCapped.count === stashCapped.max,
    `${stashCapped.count}/${stashCapped.max} — ${stashCapped.err}`);

  await stash.evaluate(() => window.Keys.Stash.clear());
  await stash.waitForTimeout(200);
  const stashCleared = await stash.evaluate(() => ({
    count: window.Keys.Stash.count(),
    emptyShown: !document.getElementById('stash-empty').hidden,
    countBadgeHidden: document.getElementById('stash-count').hidden
  }));
  check('an emptied drawer says so and is not silently re-seeded',
    stashCleared.count === 0 && stashCleared.emptyShown && stashCleared.countBadgeHidden,
    JSON.stringify(stashCleared));

  /* --- stashing from the editor ----------------------------------------- */
  const viaButton = await stash.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const sec = document.querySelector(
      '#editor-scroll .ed-section[data-section="page3"]');
    sec.classList.add('is-open');
    await wait(250);
    const btn = document.querySelector('#editor-scroll [data-act="slip-stash"]');
    if (!btn) return { error: 'no Save-for-later button on the slip card' };
    const slipsBefore = window.Keys.State.doc.slips.length;
    btn.click();
    await wait(400);

    const dlg = document.getElementById('name-dialog');
    const snap = {
      dialogOpen: dlg.open,
      title: document.getElementById('name-dialog-title').textContent,
      label: document.getElementById('name-dialog-label').textContent,
      okLabel: document.getElementById('name-dialog-ok').textContent,
      suggestion: document.getElementById('name-dialog-input').placeholder,
      // A stash name is not a file name: no extension chip.
      extHidden: document.getElementById('name-dialog-ext').hidden
    };
    document.getElementById('name-dialog-input').value = 'Hotdog / Thursday: reusable';
    document.getElementById('name-dialog-form').requestSubmit();
    await wait(600);
    return Object.assign(snap, {
      count: window.Keys.Stash.count(),
      newest: window.Keys.Stash.items()[0],
      drawerOpened: window.Keys.Stash.isOpen(),
      slipsBefore,
      slipsAfter: window.Keys.State.doc.slips.length
    });
  });
  check('each slip card offers a Save-for-later button',
    !viaButton.error && viaButton.dialogOpen === true,
    viaButton.error || 'dialog opened');
  check('it asks for a name, suggesting the slip heading',
    /save for later/i.test(viaButton.title) && /name/i.test(viaButton.label) &&
    viaButton.suggestion && viaButton.suggestion.length > 2,
    JSON.stringify({ title: viaButton.title, label: viaButton.label,
                     suggestion: viaButton.suggestion }));
  check('the name prompt is a name prompt, not the file-name one',
    viaButton.extHidden === true && /drawer/i.test(viaButton.okLabel),
    `ext hidden=${viaButton.extHidden} ok="${viaButton.okLabel}"`);
  check('the typed name is kept verbatim, punctuation and all',
    viaButton.newest && viaButton.newest.name === 'Hotdog / Thursday: reusable',
    JSON.stringify(viaButton.newest));
  check('stashing COPIES — the box stays on the page',
    viaButton.slipsAfter === viaButton.slipsBefore,
    `${viaButton.slipsBefore} -> ${viaButton.slipsAfter}`);
  check('the drawer opens so you can see what was saved',
    viaButton.drawerOpened === true);

  /* --- stashing by dragging onto the drawer ------------------------------ */
  const viaDrag = await stash.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.Keys.Stash.close();
    window.Keys.Flip.go(3, { animate: false });
    await wait(500);

    const slip = document.querySelector(
      '#page-stage .paper[data-kind="slips"] [data-move="slip"]');
    if (!slip) return { error: 'no draggable slip on the page' };
    const sr = slip.getBoundingClientRect();
    const stage = document.getElementById('page-stage');
    stage.dispatchEvent(new PointerEvent('pointermove',
      { bubbles: true, clientX: sr.left + 6, clientY: sr.top + 6 }));
    slip.dispatchEvent(new PointerEvent('pointermove',
      { bubbles: true, clientX: sr.left + 6, clientY: sr.top + 6 }));
    await wait(150);

    const h = document.getElementById('arrange-handle');
    if (!h || h.hidden) return { error: 'the drag handle did not appear' };
    const hr = h.getBoundingClientRect();
    h.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, button: 0, pointerId: 7,
      clientX: hr.left + hr.width / 2, clientY: hr.top + hr.height / 2
    }));

    /* Aim at the HANDLE of a still-closed drawer — the only part of it on
     * screen, and the part that hangs outside the drawer's own box. */
    const grip = document.getElementById('stash-handle').getBoundingClientRect();
    const tx = grip.left + grip.width / 2;
    const ty = grip.top + grip.height / 2;
    window.dispatchEvent(new PointerEvent('pointermove',
      { bubbles: true, pointerId: 7, clientX: tx, clientY: ty - 40 }));
    window.dispatchEvent(new PointerEvent('pointermove',
      { bubbles: true, pointerId: 7, clientX: tx, clientY: ty }));
    await wait(250);

    const midDrag = {
      litUp: document.getElementById('stash').classList.contains('is-drop-target'),
      openedOnHover: window.Keys.Stash.isOpen(),
      indicatorHidden: document.getElementById('arrange-indicator').hidden
    };

    const slipsBefore = window.Keys.State.doc.slips.length;
    const countBefore = window.Keys.Stash.count();
    window.dispatchEvent(new PointerEvent('pointerup',
      { bubbles: true, pointerId: 7, clientX: tx, clientY: ty }));
    await wait(500);

    const dialogOpen = document.getElementById('name-dialog').open;
    document.getElementById('name-dialog-form').requestSubmit();  // take the suggestion
    await wait(600);
    return Object.assign(midDrag, {
      dialogOpen, slipsBefore,
      slipsAfter: window.Keys.State.doc.slips.length,
      countBefore, countAfter: window.Keys.Stash.count(),
      newest: window.Keys.Stash.items()[0].name
    });
  });

  check('a slip can be dragged onto the drawer',
    !viaDrag.error && viaDrag.dialogOpen === true,
    viaDrag.error || 'dropped and prompted');
  check('the drawer lights up and slides open as you drag over it',
    viaDrag.litUp === true && viaDrag.openedOnHover === true,
    `lit=${viaDrag.litUp} opened=${viaDrag.openedOnHover}`);
  check('no move indicator is shown — this is a copy, not a reorder',
    viaDrag.indicatorHidden === true);
  check('dropping on the drawer asks for a name, like the button does',
    viaDrag.dialogOpen === true);
  check('the drag saves a copy and leaves the page untouched',
    viaDrag.countAfter === viaDrag.countBefore + 1 &&
    viaDrag.slipsAfter === viaDrag.slipsBefore,
    JSON.stringify({ stash: `${viaDrag.countBefore}->${viaDrag.countAfter}`,
                     slips: `${viaDrag.slipsBefore}->${viaDrag.slipsAfter}` }));

  /* --- putting one back -------------------------------------------------- */
  const stashRestored = await stash.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const before = window.Keys.State.doc.slips.length;
    const item = window.Keys.Stash.items()[0];
    document.querySelector(
      '#stash-list [data-stash="restore"][data-id="' + item.id + '"]').click();
    await wait(800);
    const slips = window.Keys.State.doc.slips;
    return {
      name: item.name,
      before, after: slips.length,
      stillInDrawer: window.Keys.Stash.items().some(i => i.id === item.id),
      // Two boxes sharing an id would make every delete and reorder ambiguous.
      uniqueIds: new Set(slips.map(s => s.id)).size === slips.length,
      onPage: document.querySelectorAll(
        '#page-stage .paper[data-kind="slips"] .slip').length,
      wentToSlipsPage: window.Keys.Flip.current() ===
        window.Keys.Render.ordinalOf('slips')
    };
  });
  check('clicking Add puts a copy back on the lunch slips page',
    stashRestored.after === stashRestored.before + 1 &&
    stashRestored.onPage === stashRestored.after,
    JSON.stringify(stashRestored));
  check('the restored box gets a fresh id',
    stashRestored.uniqueIds === true);
  check('restoring keeps the drawer copy — it is a library, not an outbox',
    stashRestored.stillInDrawer === true);
  check('the preview turns to the page it landed on',
    stashRestored.wentToSlipsPage === true);

  /* --- rename and remove -------------------------------------------------- */
  const stashRenamed = await stash.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const item = window.Keys.Stash.items()[0];
    document.querySelector(
      '#stash-list [data-stash="rename"][data-id="' + item.id + '"]').click();
    await wait(400);
    const prefilled = document.getElementById('name-dialog-input').placeholder;
    document.getElementById('name-dialog-input').value = '   Renamed with spaces   ';
    document.getElementById('name-dialog-form').requestSubmit();
    await wait(500);
    return {
      prefilled,
      name: window.Keys.Stash.items()[0].name,
      shownInDrawer: document.querySelector('#stash-list .stash-item-name').textContent
    };
  });
  check('an item can be renamed, offering its current name',
    stashRenamed.prefilled && stashRenamed.name === 'Renamed with spaces' &&
    stashRenamed.shownInDrawer === 'Renamed with spaces',
    JSON.stringify(stashRenamed));

  const stashRemoved = await stash.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const before = window.Keys.Stash.count();
    const slipsBefore = window.Keys.State.doc.slips.length;
    const id = window.Keys.Stash.items()[0].id;
    const real = window.confirm;
    window.confirm = () => true;
    document.querySelector(
      '#stash-list [data-stash="remove"][data-id="' + id + '"]').click();
    await wait(400);
    window.confirm = real;
    return {
      before, after: window.Keys.Stash.count(),
      rows: document.getElementById('stash-list').children.length,
      slipsUnchanged: window.Keys.State.doc.slips.length === slipsBefore
    };
  });
  check('an item can be removed from the drawer',
    stashRemoved.after === stashRemoved.before - 1 && stashRemoved.rows === stashRemoved.after,
    JSON.stringify(stashRemoved));
  check('removing from the drawer does not touch the newsletter',
    stashRemoved.slipsUnchanged === true);

  /* --- what the stash is, and is not, part of ---------------------------- */
  const independence = await stash.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const S = window.Keys.State;
    const before = window.Keys.Stash.count();

    // The whole point: the drawer outlives the document it was filled from.
    const json = S.toJSON();
    const inSaveFile = /stash/i.test(json);
    S.replace(S.defaultDoc());
    window.Keys.App.structuralChange(null);
    await wait(400);
    return {
      inSaveFile,
      survivesLoad: window.Keys.Stash.count() === before,
      count: window.Keys.Stash.count()
    };
  });
  check('the drawer is NOT written into the newsletter file',
    independence.inSaveFile === false);
  /* If it lived in the document, starting next week's issue would empty the
   * library — which is exactly what "save for later" is for. */
  check('loading a different newsletter leaves the drawer alone',
    independence.survivesLoad === true, 'count=' + independence.count);

  await stash.reload({ waitUntil: 'load' });
  await stash.waitForTimeout(900);
  const stashAfterReload = await stash.evaluate(() => ({
    count: window.Keys.Stash.count(),
    closed: !window.Keys.Stash.isOpen(),
    rows: document.getElementById('stash-list').children.length
  }));
  check('saved items survive a reload, and the drawer starts closed',
    stashAfterReload.count > 0 && stashAfterReload.closed &&
    stashAfterReload.rows === stashAfterReload.count,
    JSON.stringify(stashAfterReload));

  /* --- hostile storage ---------------------------------------------------- */
  const hostileStash = await stash.evaluate(() => {
    const S = window.Keys.Stash;
    const out = {};
    const set = v => localStorage.setItem(S.STORAGE_KEY, v);

    set('{{{ not json');
    out.badJson = S.count();

    set(JSON.stringify({ items: 'not a list' }));
    out.notAList = S.count();

    // Records with no payload, or a kind with no renderer, are dropped:
    // restoring one would put an unusable object into doc.slips.
    set(JSON.stringify({ items: [
      { id: 'a', name: 'No payload', kind: 'slip' },
      { id: 'b', name: 'Unknown kind', kind: 'spaceship', payload: { x: 1 } },
      { id: 'c', name: 'Good', kind: 'slip', payload: { type: 'lunch' } }
    ] }));
    out.kept = S.items().map(i => i.name);
    out.rejectedKind = S.add('nope', 'spaceship', { x: 1 }).error || null;
    return out;
  });
  check('unparseable drawer storage is treated as empty, not a crash',
    hostileStash.badJson === 0 && hostileStash.notAList === 0,
    JSON.stringify(hostileStash));
  check('items with no payload or an unknown kind are discarded on read',
    hostileStash.kept.length === 1 && hostileStash.kept[0] === 'Good',
    JSON.stringify(hostileStash.kept));
  check('only stashable kinds can be added',
    /only lunch-slip/i.test(hostileStash.rejectedKind || ''),
    String(hostileStash.rejectedKind));

  check('no uncaught errors anywhere in the drawer',
    stashErrors.length === 0, stashErrors.slice(0, 4).join(' | '));

  await stashCtx.close();

  /* ------------------------------------------------------------- offline --
   * file:// — "opened straight from disk". There is no server, therefore no
   * accounts and NO GATE AT ALL; start(boot) calls boot() immediately.
   *
   * These checks exist because the honest version of this mode is easy to get
   * wrong in two opposite directions: putting a local sign-in prompt back
   * (which protects nothing from someone who already has the files, and lies
   * about it), or leaving the account-management calls firing fetches at a
   * server that is not there and hanging the dialog on them.
   * ---------------------------------------------------------------------- */
  section('Accounts — opened from disk (offline mode)');

  const offlineCtx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  /* Installed before any page script runs, so a fetch issued during boot is
   * counted too — "does it call the network?" is the question here. */
  await offlineCtx.addInitScript(() => {
    window.__fetches = [];
    const realFetch = window.fetch;
    window.fetch = function () {
      window.__fetches.push(String(arguments[0]));
      return realFetch.apply(this, arguments);
    };
  });
  const offlinePage = await offlineCtx.newPage();
  const offlineErrors = [];
  offlinePage.on('pageerror', e => offlineErrors.push(e.message));
  await offlinePage.goto(URL, { waitUntil: 'load' });
  await offlinePage.waitForTimeout(900);

  const offlineBoot = await offlinePage.evaluate(() => ({
    mode: window.Keys.Auth.mode,
    gateHidden: document.getElementById('auth-gate').hidden,
    locked: document.body.classList.contains('is-locked'),
    relocked: document.body.classList.contains('is-relocked'),
    inert: document.getElementById('app').hasAttribute('inert'),
    papers: document.querySelectorAll('#page-stage .paper').length,
    fields: document.querySelectorAll('#editor-scroll .rt').length,
    notice: (document.querySelector('.auth-notice') || {}).textContent || '',
    fetches: window.__fetches.slice()
  }));

  check('a file:// copy boots straight into the editor, with no gate',
    offlineBoot.gateHidden === true && !offlineBoot.locked &&
    !offlineBoot.relocked && offlineBoot.inert === false &&
    offlineBoot.papers === 4 && offlineBoot.fields > 0,
    JSON.stringify({ gate: offlineBoot.gateHidden, papers: offlineBoot.papers,
                     inert: offlineBoot.inert }));
  check('the client calls this mode offline', offlineBoot.mode === 'offline',
    String(offlineBoot.mode));
  /* The old copy said "this is not a security barrier". Offline there is no
   * barrier at all to describe, so the sentence has to be the other honest
   * one: anyone holding the files can read the newsletter. */
  check('the offline notice says accounts live on the server, not here',
    /opened straight from disk/i.test(offlineBoot.notice) &&
    /anyone who can open these files/i.test(offlineBoot.notice),
    offlineBoot.notice.slice(0, 90));
  check('booting offline makes no network requests at all',
    offlineBoot.fetches.length === 0, offlineBoot.fetches.join(', '));

  const offlineSettings = await offlinePage.evaluate(async () => {
    window.Keys.Auth.openSettings();
    await new Promise(r => setTimeout(r, 350));
    const out = {
      open: document.getElementById('settings-dialog').open,
      noteShown: !document.getElementById('settings-offline').hidden,
      note: document.getElementById('settings-offline').textContent,
      peopleHidden: document.getElementById('settings-people').hidden,
      rosterHtml: document.getElementById('settings-user-list').innerHTML,
      removeButtons: document.querySelectorAll('[data-auth="remove"]').length,
      who: document.getElementById('settings-who').textContent,
      heading: document.getElementById('settings-me-h').textContent,
      signOutHidden: document.getElementById('settings-signout').hidden,
      passwordHidden: document.getElementById('settings-password-section').hidden
    };
    window.Keys.Auth.closeSettings();
    return out;
  });

  check('Settings still opens offline — it has other content',
    offlineSettings.open === true);
  check('it shows the opened-from-disk note instead of a roster',
    offlineSettings.noteShown === true &&
    /opened straight from disk/i.test(offlineSettings.note) &&
    /no accounts/i.test(offlineSettings.note) &&
    offlineSettings.peopleHidden === true &&
    offlineSettings.rosterHtml === '' &&
    offlineSettings.removeButtons === 0,
    JSON.stringify({ note: offlineSettings.noteShown,
                     people: offlineSettings.peopleHidden,
                     roster: offlineSettings.rosterHtml.length }));
  check('"Signed in" is not claimed when nobody is or can be',
    offlineSettings.heading === 'Accounts' &&
    /opened from disk/i.test(offlineSettings.who) &&
    offlineSettings.signOutHidden === true &&
    offlineSettings.passwordHidden === true,
    `${offlineSettings.heading} / ${offlineSettings.who}`);

  /* A doomed fetch offline is worse than a refusal: it hangs the dialog on a
   * request nothing will ever answer. Every network-backed call has to decide
   * locally and resolve { code: 'OFFLINE' }. */
  const offlineCalls = await offlinePage.evaluate(async () => {
    const A = window.Keys.Auth;
    const before = window.__fetches.length;
    const codes = {};
    codes.users = (await A.users()).code;
    codes.signIn = (await A.signIn('Somebody', 'a-long-enough-passphrase')).code;
    codes.signOut = (await A.signOut()).code;
    codes.addUser = (await A.addUser('Somebody', 'a-long-enough-passphrase', 'user')).code;
    codes.removeUser = (await A.removeUser('Somebody')).code;
    codes.changePassword =
      (await A.changePassword('a-long-enough-passphrase', 'another-long-passphrase')).code;
    return {
      codes,
      checkIdle: await A.checkIdle(),
      hasAccounts: await A.hasAccounts(),
      fetches: window.__fetches.slice(before)
    };
  });

  const offlineCodes = Object.keys(offlineCalls.codes)
    .filter(k => offlineCalls.codes[k] !== 'OFFLINE');
  check('every account-management call resolves { code: "OFFLINE" }',
    offlineCodes.length === 0, 'not OFFLINE: ' + JSON.stringify(offlineCalls.codes));
  check('and none of them issues a fetch nothing will answer',
    offlineCalls.fetches.length === 0, offlineCalls.fetches.join(', '));
  check('checkIdle() reports offline rather than inventing a session',
    offlineCalls.checkIdle === 'offline', String(offlineCalls.checkIdle));
  check('there are no accounts to have', offlineCalls.hasAccounts === false);

  const offlineDiag = await offlinePage.evaluate(() => window.Keys.Auth.diagnose());
  check('diagnose() explains the missing gate rather than leaving it a mystery',
    offlineDiag.mode === 'offline' && offlineDiag.server === null &&
    offlineDiag.signedIn === false && /opened from disk/i.test(offlineDiag.summary),
    offlineDiag.summary.slice(0, 90));

  check('no uncaught errors in offline mode', offlineErrors.length === 0,
    offlineErrors.slice(0, 3).join(' | '));

  await offlineCtx.close();

  /* -------------------------------------------------------------- served --
   * Everything below runs against the REAL server in server/, started here on
   * a fresh KEYS_DATA directory, driven through the REAL /setup and /login
   * pages and the REAL API. Nothing is stubbed and no test bypass is installed;
   * a harness that wrote a session cookie by hand would leave the only path
   * anybody actually takes untested.
   *
   * Served mode is an access-control boundary, which the file:// mode above is
   * not, so these checks are allowed to assert something the old browser-only
   * suite could not: that the newsletter and the code that edits it are NOT
   * handed to a stranger.
   * ---------------------------------------------------------------------- */
  section('Accounts — first run on a fresh server');

  const ADMIN_NAME = 'Head Teacher';
  const ADMIN_PW = 'first-admin-passphrase';
  const ADMIN_PW2 = 'a-brand-new-passphrase';
  const USER_NAME = 'Office Assistant';
  const USER_PW = 'ordinary-user-passphrase';
  const DEPUTY_NAME = 'Deputy Head';
  const DEPUTY_PW = 'deputy-passphrase-here';

  const srv = startServer({});
  const srvUp = await waitForServer(srv);
  check('the server starts and answers /api/auth/state', srvUp === true,
    srvUp ? srv.base : srv.log().slice(0, 400));

  const firstRoot = await req(srv, 'GET', '/');
  /* §6, and the direct answer to "I cloned it onto a VM and was never prompted
   * to create an administrator". A fresh box must send you to setup, not to a
   * sign-in form for an account that does not exist. */
  check('a first-run visitor is sent to /setup, not to a sign-in form',
    firstRoot.status === 302 && firstRoot.headers.location === '/setup',
    firstRoot.status + ' -> ' + firstRoot.headers.location);

  const tokenFile = path.join(srv.dir, 'setup-token.txt');
  const setupToken = fs.readFileSync(tokenFile, 'utf8').trim();
  check('the setup token is printed to the console, unmissably',
    srv.log().includes(setupToken) && /FIRST-RUN SETUP/.test(srv.log()),
    srv.log().split('\n').filter(l => /Token/.test(l)).join(' '));
  check('and saved to the data directory, readable only by the server account',
    (fs.statSync(tokenFile).mode & 0o777) === 0o600,
    '0' + (fs.statSync(tokenFile).mode & 0o777).toString(8));

  /* The token is what stops the administrator account being claimed by
   * whoever reaches the box first on a shared network. Without this check the
   * whole mechanism could be a decoration. */
  const wrongToken = await req(srv, 'POST', '/api/auth/setup', {
    json: { token: 'WRNG-WRNG-WRNG-WRNG', name: 'Impostor', password: 'a-good-passphrase' }
  });
  check('a wrong setup token is refused',
    wrongToken.status === 400 && wrongToken.json && wrongToken.json.code === 'BAD_TOKEN',
    wrongToken.status + ' ' + JSON.stringify(wrongToken.json));
  const afterWrongToken = await req(srv, 'GET', '/api/auth/state');
  check('a refused setup creates nothing',
    afterWrongToken.json.hasAccounts === false,
    JSON.stringify(afterWrongToken.json && afterWrongToken.json.hasAccounts));

  const noToken = await req(srv, 'POST', '/api/auth/setup', {
    json: { name: 'Impostor', password: 'a-good-passphrase' }
  });
  check('so is a setup with no token at all',
    noToken.status === 400 && noToken.json.code === 'BAD_TOKEN',
    noToken.status + ' ' + (noToken.json || {}).code);

  /* --- the administrator, created through the real page ------------------ */
  const adminCtx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const admin = await adminCtx.newPage();
  const adminErrors = [];
  admin.on('pageerror', e => adminErrors.push('pageerror: ' + e.message));
  admin.on('console', m => { if (m.type() === 'error') adminErrors.push('console: ' + m.text()); });

  await admin.goto(srv.base + '/', { waitUntil: 'domcontentloaded' });
  check('a browser is redirected to the setup page on a first visit',
    admin.url().endsWith('/setup'), admin.url());

  await admin.fill('#token', setupToken);
  await admin.fill('#name', ADMIN_NAME);
  await admin.fill('#password', ADMIN_PW);
  await admin.fill('#confirm', ADMIN_PW);
  await Promise.all([
    admin.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => {}),
    admin.click('#submit')
  ]);
  await admin.waitForFunction(
    () => document.querySelectorAll('#page-stage .paper').length > 0,
    null, { timeout: 20000 });
  await admin.waitForTimeout(700);

  const afterSetup = await admin.evaluate(() => ({
    path: location.pathname,
    papers: document.querySelectorAll('#page-stage .paper').length,
    gateHidden: document.getElementById('auth-gate').hidden,
    mode: window.Keys.Auth.mode,
    me: window.Keys.Auth.currentUser(),
    isAdmin: window.Keys.Auth.isAdmin(),
    notice: (document.querySelector('.auth-notice') || {}).textContent || ''
  }));
  check('completing setup opens the newsletter',
    afterSetup.path === '/' && afterSetup.papers === 4 &&
    afterSetup.gateHidden === true,
    JSON.stringify({ path: afterSetup.path, papers: afterSetup.papers }));
  check('the first account is always an administrator',
    afterSetup.me && afterSetup.me.name === ADMIN_NAME &&
    afterSetup.me.role === 'admin' && afterSetup.isAdmin === true,
    JSON.stringify(afterSetup.me));
  check('the client reports served mode', afterSetup.mode === 'served',
    String(afterSetup.mode));
  /* The old "this is not a security barrier" sentence would now be an
   * understatement, which is its own kind of lie. Served mode says what the
   * server actually does — and what it still does not do, which is encrypt. */
  check('the served notice claims a real lock, and admits it is not encryption',
    /real lock/i.test(afterSetup.notice) && /in the clear/i.test(afterSetup.notice) &&
    !/not a security barrier/i.test(afterSetup.notice),
    afterSetup.notice.slice(0, 90));

  const secondSetup = await req(srv, 'POST', '/api/auth/setup', {
    json: { token: setupToken, name: 'Second Admin', password: 'another-passphrase' }
  });
  check('the setup token is consumed — a second setup is refused',
    secondSetup.status === 403 && secondSetup.json.code === 'SETUP_DONE',
    secondSetup.status + ' ' + (secondSetup.json || {}).code);
  check('and the token file is deleted, so a stale copy cannot be replayed',
    fs.existsSync(tokenFile) === false);

  const adminCookieObj = await sessionCookieObj(adminCtx, srv.base);
  const adminCookie = adminCookieObj ? 'keys_sid=' + adminCookieObj.value : '';
  /* `Secure` over plain http is the trap the server's own comment warns about:
   * the cookie is stored and then never sent back, so sign-in appears to work,
   * / bounces to /login, and it looks like an infinite loop with no error
   * anywhere. It must be set only under TLS. */
  check('the session cookie is HttpOnly, SameSite=Strict, and not Secure over plain http',
    !!adminCookieObj && adminCookieObj.httpOnly === true &&
    adminCookieObj.sameSite === 'Strict' && adminCookieObj.secure === false,
    JSON.stringify(adminCookieObj && {
      httpOnly: adminCookieObj.httpOnly, sameSite: adminCookieObj.sameSite,
      secure: adminCookieObj.secure, path: adminCookieObj.path
    }));

  /* --- the boundary itself ---------------------------------------------- */
  section('Accounts — the server will not serve the app to a stranger');

  const anonApp = await req(srv, 'GET', '/assets/js/app.js');
  /* THE point of moving accounts to a server. A browser-side gate could only
   * ever hide the editor after shipping it; this refuses to ship it. */
  check('the application JavaScript is not served without a session',
    anonApp.status === 401 && anonApp.json && anonApp.json.code === 'NO_SESSION',
    anonApp.status + ' ' + (anonApp.json || {}).code);
  const anonAuthJs = await req(srv, 'GET', '/assets/js/auth.js');
  check('nor is auth.js, which is where the gate would be tampered with',
    anonAuthJs.status === 401, String(anonAuthJs.status));

  const anonRoot = await req(srv, 'GET', '/');
  check('/ sends a stranger to /login once an account exists',
    anonRoot.status === 302 && anonRoot.headers.location === '/login',
    anonRoot.status + ' -> ' + anonRoot.headers.location);
  const anonIndex = await req(srv, 'GET', '/index.html');
  check('index.html cannot be fetched by name to go round that',
    anonIndex.status === 404, String(anonIndex.status));

  const anonCss = await req(srv, 'GET', '/assets/css/app.css');
  check('the one allowlisted stylesheet is served, because /login needs it',
    anonCss.status === 200 && /text\/css/.test(anonCss.headers['content-type'] || ''),
    anonCss.status + ' ' + anonCss.headers['content-type']);

  const anonUsers = await req(srv, 'GET', '/api/users');
  check('the roster is not served without a session',
    anonUsers.status === 401 && (anonUsers.json || {}).code === 'NO_SESSION',
    anonUsers.status + ' ' + (anonUsers.json || {}).code);

  const anonSetupPage = await req(srv, 'GET', '/setup');
  check('/setup closes for good once an account exists',
    anonSetupPage.status === 302 && anonSetupPage.headers.location === '/login',
    anonSetupPage.status + ' -> ' + anonSetupPage.headers.location);

  /* --- paths that must never resolve ------------------------------------- */
  const traversals = [
    ['/assets/../server/server.js', 'a plain ..'],
    ['/assets/%2e%2e/server/server.js', 'an encoded ..'],
    ['/assets/js/app.js%00.png', 'a NUL byte'],
    ['/assets/%5c..%5cserver/server.js', 'a backslash separator'],
    ['/assets/.env', 'a dotfile under assets'],
    ['/.git/config', 'the git directory']
  ];
  for (const [p, what] of traversals) {
    // With a VALID session, so this is about the path handling and not about
    // the auth gate happening to catch it first.
    const res = await req(srv, 'GET', p, { cookie: adminCookie });
    check(`a path containing ${what} is refused outright`,
      res.status === 400, p + ' -> ' + res.status);
  }

  const neverServed = ['/server/server.js', '/server/accounts.js',
    '/docs/AUTH-API.md', '/tools/verify.js', '/reference/anything.txt',
    '/README.md', '/assets/js/../../server/server.js'];
  for (const p of neverServed) {
    const res = await req(srv, 'GET', p, { cookie: adminCookie });
    check(`${p} is never served, even to an administrator`,
      res.status === 404 || res.status === 400, p + ' -> ' + res.status);
  }

  /* --- cross-site request forgery ---------------------------------------- */
  const crossOrigin = await req(srv, 'POST', '/api/auth/signin', {
    json: { name: ADMIN_NAME, password: ADMIN_PW }, origin: 'http://evil.example'
  });
  check('a cross-origin Origin is refused 403 CSRF',
    crossOrigin.status === 403 && crossOrigin.json.code === 'CSRF',
    crossOrigin.status + ' ' + (crossOrigin.json || {}).code);

  const noOrigin = await req(srv, 'POST', '/api/auth/signin', {
    json: { name: ADMIN_NAME, password: ADMIN_PW }, origin: null
  });
  /* "Both absent" must be a refusal, not a pass. Browsers always send Origin
   * on a non-GET; anything that does not is a script, and a script can set the
   * header. Defaulting to allow is how a CSRF check comes to be worth nothing. */
  check('a non-GET with no Origin at all is refused too, not given the benefit of the doubt',
    noOrigin.status === 403 && noOrigin.json.code === 'CSRF',
    noOrigin.status + ' ' + (noOrigin.json || {}).code);

  const formish = await req(srv, 'POST', '/api/auth/signin', {
    json: { name: ADMIN_NAME, password: ADMIN_PW },
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
  });
  check('a content type an HTML form could actually send is refused',
    formish.status === 403 && formish.json.code === 'CSRF',
    formish.status + ' ' + (formish.json || {}).code);

  /* The one place this is easy to get wrong: DELETE has no body, so it is
   * tempting to exempt it from the content-type leg. It is not exempt. */
  const deleteNoType = await req(srv, 'DELETE', '/api/users/Nobody',
    { cookie: adminCookie });
  check('DELETE is held to the same content-type rule, despite having no body',
    deleteNoType.status === 403 && deleteNoType.json.code === 'CSRF',
    deleteNoType.status + ' ' + (deleteNoType.json || {}).code);

  /* --- who may do what --------------------------------------------------- */
  section('Accounts — administrator and users');

  const roster0 = await admin.evaluate(() => window.Keys.Auth.users());
  check('an administrator can read the roster over the real API',
    roster0.users && roster0.users.length === 1 &&
    roster0.users[0].name === ADMIN_NAME,
    JSON.stringify(roster0));
  check('the roster never carries password material',
    (roster0.users || []).every(u =>
      Object.keys(u).sort().join(',') === 'createdAt,lastSignInAt,name,role'),
    JSON.stringify(Object.keys((roster0.users || [{}])[0] || {})));

  const addedUser = await admin.evaluate(
    a => window.Keys.Auth.addUser(a[0], a[1], 'user'), [USER_NAME, USER_PW]);
  check('an administrator can add a user',
    addedUser.user && addedUser.user.name === USER_NAME &&
    addedUser.user.role === 'user', JSON.stringify(addedUser));

  const dupe = await admin.evaluate(
    a => window.Keys.Auth.addUser(a[0].toLowerCase(), a[1], 'user'),
    [USER_NAME, USER_PW]);
  check('a duplicate name is refused, ignoring case',
    dupe.code === 'NAME_TAKEN' && dupe.status === 409,
    JSON.stringify(dupe));

  const weak = await admin.evaluate(() =>
    window.Keys.Auth.addUser('Someone Else', 'short', 'user'));
  check('a short password is refused when adding someone',
    weak.code === 'WEAK_PASSWORD' && /at least 8/i.test(weak.error || ''),
    JSON.stringify(weak));

  /* The client's own validation lets this through — it only checks length and
   * emptiness — so this is the SERVER's character rule being exercised, and
   * the client passing the server's code back unchanged. */
  const badName = await admin.evaluate(() =>
    window.Keys.Auth.addUser('Slash/Name', 'a-good-passphrase-here', 'user'));
  check('a name with characters that are not allowed is refused by the server',
    badName.code === 'BAD_NAME' && badName.status === 400,
    JSON.stringify(badName));

  /* A role the server does not recognise must round DOWN to user, never up. */
  const oddRole = await admin.evaluate(() =>
    window.Keys.Auth.addUser('Temp Helper', 'temporary-passphrase', 'superuser'));
  check('an unrecognised role is created as an ordinary user, never an administrator',
    oddRole.user && oddRole.user.role === 'user', JSON.stringify(oddRole));

  /* Names may legally contain spaces, and the DELETE route puts the name in
   * the path — so this is the encodeURIComponent round trip as well. */
  const removedHelper = await admin.evaluate(() =>
    window.Keys.Auth.removeUser('Temp Helper'));
  check('an administrator can remove someone, name with a space and all',
    removedHelper.removed && removedHelper.removed.name === 'Temp Helper' &&
    removedHelper.self === false, JSON.stringify(removedHelper));

  const gone = await admin.evaluate(() => window.Keys.Auth.users());
  check('and they are gone from the roster',
    (gone.users || []).every(u => u.name !== 'Temp Helper'),
    (gone.users || []).map(u => u.name).join(', '));

  /* --- an ordinary user -------------------------------------------------- */
  const userCtx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const userPage = await userCtx.newPage();
  const userErrors = [];
  const userRequests = [];
  userPage.on('pageerror', e => userErrors.push('pageerror: ' + e.message));
  userPage.on('console', m => { if (m.type() === 'error') userErrors.push('console: ' + m.text()); });
  userPage.on('request', r => userRequests.push(r.url()));

  await userPage.goto(srv.base + '/', { waitUntil: 'domcontentloaded' });
  await userPage.waitForTimeout(400);
  check('a browser with no session lands on /login',
    userPage.url().endsWith('/login'), userPage.url());
  const atLogin = await userPage.evaluate(() => ({
    papers: document.querySelectorAll('.paper').length,
    editor: !!document.getElementById('editor-scroll'),
    text: document.body.innerText
  }));
  check('and none of the newsletter is in that page — it was never sent',
    atLogin.papers === 0 && !atLogin.editor &&
    !/Classroom Corner|Walmore/i.test(atLogin.text),
    JSON.stringify({ papers: atLogin.papers, editor: atLogin.editor }));

  await userPage.fill('#name', USER_NAME);
  await userPage.fill('#password', USER_PW);
  await Promise.all([
    userPage.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => {}),
    userPage.click('#submit')
  ]);
  await userPage.waitForFunction(
    () => document.querySelectorAll('#page-stage .paper').length > 0,
    null, { timeout: 20000 });
  await userPage.waitForTimeout(600);

  const userCookieObj = await sessionCookieObj(userCtx, srv.base);
  const userCookie = userCookieObj ? 'keys_sid=' + userCookieObj.value : '';
  const asUser = await userPage.evaluate(() => ({
    me: window.Keys.Auth.currentUser(),
    isAdmin: window.Keys.Auth.isAdmin(),
    papers: document.querySelectorAll('#page-stage .paper').length
  }));
  check('signing in through the real /login page opens the newsletter',
    asUser.papers === 4 && asUser.me && asUser.me.name === USER_NAME,
    JSON.stringify(asUser.me));
  check('an ordinary user is not an administrator',
    asUser.me.role === 'user' && asUser.isAdmin === false, asUser.me.role);

  const userRoster = await userPage.evaluate(async () => {
    const r = await fetch('/api/users', { credentials: 'same-origin' });
    return { status: r.status, body: await r.json() };
  });
  check('the server refuses an ordinary user the roster',
    userRoster.status === 403 && userRoster.body.code === 'NOT_ADMIN',
    userRoster.status + ' ' + userRoster.body.code);

  const requestsBefore = userRequests.length;
  const userUi = await userPage.evaluate(async () => {
    window.Keys.Auth.openSettings();
    await new Promise(r => setTimeout(r, 600));
    const out = {
      open: document.getElementById('settings-dialog').open,
      peopleHidden: document.getElementById('settings-people').hidden,
      rosterHtml: document.getElementById('settings-user-list').innerHTML,
      rosterItems: document.querySelectorAll('#settings-user-list li').length,
      removeButtons: document.querySelectorAll('[data-auth="remove"]').length,
      anyOtherName: /Head Teacher/.test(document.getElementById('settings-dialog').innerHTML),
      who: document.getElementById('settings-who').textContent,
      role: document.getElementById('settings-role').textContent
    };
    window.Keys.Auth.closeSettings();
    return out;
  });
  const askedForRoster = userRequests.slice(requestsBefore)
    .filter(u => u.indexOf('/api/users') !== -1);

  /* REQUIREMENT WITH HISTORY. An earlier build left the whole people list —
   * every name, a remove button each — sitting in the DOM of anyone who opened
   * Settings, merely `hidden`. "Hidden" is one devtools keystroke from
   * visible. The elements must not be BUILT, and the request that would fetch
   * the names must not be MADE. */
  check('a non-administrator never even asks the server for the roster',
    askedForRoster.length === 0, askedForRoster.join(', '));
  check('and has no roster markup in the DOM at all — not merely hidden',
    userUi.rosterHtml === '' && userUi.rosterItems === 0 &&
    userUi.removeButtons === 0 && userUi.peopleHidden === true &&
    userUi.anyOtherName === false,
    JSON.stringify({ html: userUi.rosterHtml.length, items: userUi.rosterItems,
                     buttons: userUi.removeButtons, hidden: userUi.peopleHidden,
                     leak: userUi.anyOtherName }));
  check('settings still names who is signed in, and their role',
    userUi.who === USER_NAME && userUi.role === 'User',
    `${userUi.who} / ${userUi.role}`);

  const userAdds = await userPage.evaluate(() =>
    window.Keys.Auth.addUser('Sneaky', 'sneaky-passphrase-here', 'admin'));
  check('an ordinary user cannot add anyone',
    userAdds.code === 'NOT_ADMIN' && userAdds.status === 403,
    JSON.stringify(userAdds));

  const userRemovesOther = await userPage.evaluate(
    n => window.Keys.Auth.removeUser(n), ADMIN_NAME);
  check('an ordinary user cannot remove anyone else',
    userRemovesOther.code === 'NOT_ADMIN' && userRemovesOther.status === 403,
    JSON.stringify(userRemovesOther));

  /* --- deleting your own account ----------------------------------------- */
  const selfDelete = await userPage.evaluate(() =>
    window.Keys.Auth.removeUser(window.Keys.Auth.currentUser().name));
  check('a non-administrator can delete their own account',
    selfDelete.removed && selfDelete.removed.name === USER_NAME &&
    selfDelete.self === true, JSON.stringify(selfDelete));
  check('and is signed out by it',
    (await userPage.evaluate(() => window.Keys.Auth.currentUser())) === null);

  const deletedTouch = await req(srv, 'POST', '/api/auth/touch',
    { json: {}, cookie: userCookie });
  check('the deleted account\'s session is destroyed server-side, not just forgotten locally',
    deletedTouch.status === 401, deletedTouch.status + ' ' +
    ((deletedTouch.json || {}).code || ''));

  const rosterAfterSelfDelete = await admin.evaluate(() => window.Keys.Auth.users());
  check('the administrator sees them gone from the roster',
    (rosterAfterSelfDelete.users || []).every(u => u.name !== USER_NAME),
    (rosterAfterSelfDelete.users || []).map(u => u.name).join(', '));

  await userCtx.close();

  /* --- the last administrator -------------------------------------------- */
  section('Accounts — the last administrator');

  /* Without this guard a server can end up with accounts but nobody able to
   * manage them, and the only way out is reset-accounts.js on the box itself. */
  const lastAdmin = await admin.evaluate(() =>
    window.Keys.Auth.removeUser(window.Keys.Auth.currentUser().name));
  check('the last administrator cannot be removed',
    lastAdmin.code === 'LAST_ADMIN' && lastAdmin.status === 409,
    JSON.stringify(lastAdmin));

  const stillAdmin = await admin.evaluate(async () => ({
    roster: await window.Keys.Auth.users(),
    me: window.Keys.Auth.currentUser()
  }));
  check('and is therefore still there, still signed in',
    stillAdmin.roster.users.length === 1 && stillAdmin.me &&
    stillAdmin.me.name === ADMIN_NAME,
    JSON.stringify(stillAdmin.me));

  const lastAdminUi = await admin.evaluate(async () => {
    window.Keys.Auth.openSettings();
    await new Promise(r => setTimeout(r, 600));
    const out = {
      rosterItems: document.querySelectorAll('#settings-user-list li').length,
      removeButtons: document.querySelectorAll(
        '#settings-user-list [data-auth="remove"]').length,
      note: (document.querySelector('.set-user-note') || {}).textContent || '',
      you: (document.querySelector('.set-user-you') || {}).textContent || ''
    };
    window.Keys.Auth.closeSettings();
    return out;
  });
  check('the UI offers no way to remove the last administrator either',
    lastAdminUi.rosterItems === 1 && lastAdminUi.removeButtons === 0 &&
    /last admin/i.test(lastAdminUi.note),
    JSON.stringify(lastAdminUi));
  check('the roster marks which entry is you',
    /you/i.test(lastAdminUi.you), lastAdminUi.you);

  /* --- changing a password ------------------------------------------------ */
  section('Accounts — changing a password');

  const saltBefore = readAccountsFile(srv).data.users[0].salt;

  /* A SECOND session for the same person, made the honest way, so that
   * "every other session is invalidated" can be observed rather than assumed. */
  const elsewhere = await req(srv, 'POST', '/api/auth/signin',
    { json: { name: ADMIN_NAME, password: ADMIN_PW } });
  check('the same person can be signed in in two places at once',
    elsewhere.status === 200 && !!elsewhere.cookie, String(elsewhere.status));

  const wrongCurrent = await admin.evaluate(
    a => window.Keys.Auth.changePassword('nope-not-it', a), ADMIN_PW2);
  /* A 401 here means "you mistyped your current password", NOT "your session
   * is gone". An earlier build read the status alone, threw the sign-in gate
   * over the whole app and never mentioned the typo. */
  check('changing a password requires the current one',
    wrongCurrent.code === 'BAD_CREDENTIALS' &&
    /not your current password/i.test(wrongCurrent.error || ''),
    JSON.stringify(wrongCurrent));

  /* THE bug this guards, and it happened: the settings code read the 401
   * ALONE, decided the session was gone, threw the sign-in gate over the whole
   * app and never mentioned the typo. Only IDLE / EXPIRED / NO_SESSION mean
   * that. Driven through the real form, because the faulty code was in the
   * form's handler. */
  const typoInSettings = await admin.evaluate(async (next) => {
    window.Keys.Auth.openSettings();
    await new Promise(r => setTimeout(r, 350));
    document.getElementById('settings-current-password').value = 'nope-not-it';
    document.getElementById('settings-next-password').value = next;
    document.getElementById('settings-next-password-2').value = next;
    document.getElementById('settings-password-form').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 1200));
    const out = {
      message: document.getElementById('settings-message').textContent,
      messageShown: !document.getElementById('settings-message').hidden,
      gateShown: !document.getElementById('auth-gate').hidden,
      dialogOpen: document.getElementById('settings-dialog').open
    };
    window.Keys.Auth.closeSettings();
    return out;
  }, ADMIN_PW2);
  check('a mistyped current password is reported in Settings, not read as a lapsed session',
    /not your current password/i.test(typoInSettings.message) &&
    typoInSettings.messageShown === true &&
    typoInSettings.gateShown === false && typoInSettings.dialogOpen === true,
    JSON.stringify(typoInSettings));

  const tooShort = await admin.evaluate(
    a => window.Keys.Auth.changePassword(a, 'abc'), ADMIN_PW);
  check('the new password must still meet the minimum',
    tooShort.code === 'WEAK_PASSWORD', JSON.stringify(tooShort));

  const changed = await admin.evaluate(
    a => window.Keys.Auth.changePassword(a[0], a[1]), [ADMIN_PW, ADMIN_PW2]);
  check('the password changes', changed.changed === true, JSON.stringify(changed));

  const oldPwNow = await req(srv, 'POST', '/api/auth/signin',
    { json: { name: ADMIN_NAME, password: ADMIN_PW } });
  check('the old password stops working',
    oldPwNow.status === 401 && oldPwNow.json.code === 'BAD_CREDENTIALS',
    oldPwNow.status + ' ' + (oldPwNow.json || {}).code);
  const newPwNow = await req(srv, 'POST', '/api/auth/signin',
    { json: { name: ADMIN_NAME, password: ADMIN_PW2 } });
  check('and the new one does', newPwNow.status === 200, String(newPwNow.status));

  /* Half the reason anybody changes a password is that they think somebody
   * else knows it. Leaving that somebody signed in makes the change pointless. */
  const elsewhereAfter = await req(srv, 'POST', '/api/auth/touch',
    { json: {}, cookie: elsewhere.cookie });
  check('every OTHER session for that person is signed out by the change',
    elsewhereAfter.status === 401, elsewhereAfter.status + ' ' +
    ((elsewhereAfter.json || {}).code || ''));
  check('but the session that made the change is kept',
    (await admin.evaluate(() => window.Keys.Auth.checkIdle())) === 'active');

  const saltAfter = readAccountsFile(srv).data.users[0].salt;
  /* Reusing the salt would mean the old and the new hash are relatable, and
   * anyone with both copies of the file could tell the password changed. */
  check('the salt is rotated on change, not reused',
    !!saltBefore && !!saltAfter && saltBefore !== saltAfter,
    `before=${String(saltBefore).slice(0, 12)}… after=${String(saltAfter).slice(0, 12)}…`);

  /* --- how the password is stored ----------------------------------------- */
  section('Accounts — password storage on disk');

  const deputy = await admin.evaluate(
    a => window.Keys.Auth.addUser(a[0], a[1], 'admin'), [DEPUTY_NAME, DEPUTY_PW]);
  check('a second administrator can be added',
    deputy.user && deputy.user.role === 'admin', JSON.stringify(deputy));

  const store = readAccountsFile(srv);
  const records = store.data.users;
  const secrets = [ADMIN_PW, ADMIN_PW2, USER_PW, DEPUTY_PW];

  check('accounts.json is readable only by the account running the server',
    store.mode === 0o600, '0' + store.mode.toString(8));
  check('no password appears in the file in the clear',
    secrets.every(pw => store.raw.indexOf(pw) === -1),
    secrets.filter(pw => store.raw.indexOf(pw) !== -1).join(', '));
  check('every record has a salt of its own',
    records.length === 2 &&
    new Set(records.map(u => u.salt)).size === records.length &&
    records.every(u => Buffer.from(u.salt, 'base64').length === 16),
    records.map(u => String(u.salt).slice(0, 8)).join(' / '));
  check('hashed at the OWASP iteration floor of 310,000',
    records.every(u => u.iterations === 310000),
    records.map(u => u.iterations).join(', '));
  check('with a 32-byte derived key',
    records.every(u => Buffer.from(u.hash, 'base64').length === 32),
    records.map(u => Buffer.from(u.hash, 'base64').length).join(', '));

  /* --- rate limiting ------------------------------------------------------ */
  section('Accounts — repeated wrong passwords');

  /* Keyed on (IP, name), so this burns the budget for DEPUTY_NAME only —
   * deliberately somebody the rest of the suite never signs in as. */
  let limited = null;
  let attempts = 0;
  for (let i = 0; i < 10 && !limited; i++) {
    attempts++;
    const r = await req(srv, 'POST', '/api/auth/signin',
      { json: { name: DEPUTY_NAME, password: 'definitely-not-it-' + i } });
    if (r.status === 429) limited = r;
  }
  check('repeated wrong passwords are eventually refused outright',
    !!limited && limited.json.code === 'RATE_LIMITED',
    'gave up after ' + attempts + ' attempts');
  check('the five free attempts are not spent on the first mistake',
    attempts > 5, 'brake engaged on attempt ' + attempts);
  check('and the refusal says how long to wait, in the body and in a header',
    !!limited && limited.json.retryAfterMs > 0 && !!limited.headers['retry-after'],
    limited ? `retryAfterMs=${limited.json.retryAfterMs} Retry-After=${limited.headers['retry-after']}` : '');

  /* The UI half. A person who is being throttled and is only ever told "that
   * name and password do not match" will try harder and make it worse. */
  const rlCtx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const rlPage = await rlCtx.newPage();
  await rlPage.goto(srv.base + '/login', { waitUntil: 'domcontentloaded' });
  await rlPage.waitForTimeout(300);
  let rlMessage = '';
  for (let i = 0; i < 10; i++) {
    await rlPage.fill('#name', DEPUTY_NAME);
    await rlPage.fill('#password', 'still-not-it-' + i);
    await rlPage.click('#submit');
    await rlPage.waitForTimeout(400);
    rlMessage = await rlPage.evaluate(() =>
      document.getElementById('error').textContent || '');
    if (/too many/i.test(rlMessage)) break;
  }
  check('the sign-in page shows the rate limit, rather than repeating "wrong password"',
    /too many/i.test(rlMessage) && /try again in/i.test(rlMessage),
    rlMessage.slice(0, 100));
  await rlCtx.close();

  /* --- signing out --------------------------------------------------------- */
  section('Accounts — signing out');

  /* Auth.signOut() deliberately does NOT clear the screen — a rendered
   * newsletter is still on display when it resolves. The Settings button is
   * what follows it with a reload, which the server bounces to /login, and
   * that is the only way to be certain nothing is left visible. So this drives
   * the BUTTON, not the API. */
  await admin.evaluate(() => window.Keys.Auth.openSettings());
  await admin.waitForTimeout(400);
  await admin.click('[data-auth="signout"]');
  await admin.waitForTimeout(3000);

  check('the Sign out button reloads, and the server sends the reload to /login',
    admin.url().indexOf('/login') !== -1, admin.url());
  const afterSignOut = await admin.evaluate(() => ({
    papers: document.querySelectorAll('.paper').length,
    editor: !!document.getElementById('editor-scroll'),
    text: document.body.innerText
  }));
  check('nothing of the newsletter is left on the screen',
    afterSignOut.papers === 0 && !afterSignOut.editor &&
    !/Classroom Corner|Walmore/i.test(afterSignOut.text),
    JSON.stringify({ papers: afterSignOut.papers, editor: afterSignOut.editor }));

  const cookieAfterSignOut = await req(srv, 'POST', '/api/auth/touch',
    { json: {}, cookie: adminCookie });
  check('the session is destroyed server-side, not merely forgotten by the browser',
    cookieAfterSignOut.status === 401, cookieAfterSignOut.status + ' ' +
    ((cookieAfterSignOut.json || {}).code || ''));

  /* 400/401/403/409/429 are all provoked on purpose above and the browser logs
   * every refused fetch to the console regardless. Only count what is not a
   * deliberate refusal. */
  const REFUSALS = /status of (400|401|403|404|409|413|429)/;
  const realAdminErrors = adminErrors.filter(e => !REFUSALS.test(e));
  const realUserErrors = userErrors.filter(e => !REFUSALS.test(e));
  check('no unexpected page or console errors in the served flow',
    realAdminErrors.length === 0 && realUserErrors.length === 0,
    realAdminErrors.concat(realUserErrors).slice(0, 4).join(' | '));

  await adminCtx.close();
  await srv.stop();

  /* ------------------------------------------------------------ idle ------
   * THE highest-value check in this file.
   *
   * When the session lapses, the editor is holding an issue that may never
   * have been on disk. The old browser build reloaded on idle; served, a
   * reload is bounced to /login and the tab goes with it. Losing somebody's
   * unsaved newsletter to a five-minute timeout would be the worst possible
   * failure of this feature, so what is asserted here is not "the session
   * ended" but "the session ended AND the document is still there".
   *
   * Run against a server with a four-second idle budget, so the real
   * server-side clock is exercised rather than a constant only tests use.
   * ---------------------------------------------------------------------- */
  section('Accounts — an idle session re-locks in place, losing nothing');

  const idleSrv = startServer({ KEYS_IDLE_MS: '4000' });
  const idleUp = await waitForServer(idleSrv);
  check('a server with a four-second idle budget starts', idleUp === true,
    idleUp ? idleSrv.base : idleSrv.log().slice(0, 400));

  const idleToken = fs.readFileSync(
    path.join(idleSrv.dir, 'setup-token.txt'), 'utf8').trim();

  const idleCtx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const idlePage = await idleCtx.newPage();
  const idleErrors = [];
  idlePage.on('pageerror', e => idleErrors.push('pageerror: ' + e.message));
  idlePage.on('console', m => { if (m.type() === 'error') idleErrors.push('console: ' + m.text()); });

  await idlePage.goto(idleSrv.base + '/', { waitUntil: 'domcontentloaded' });
  await idlePage.fill('#token', idleToken);
  await idlePage.fill('#name', ADMIN_NAME);
  await idlePage.fill('#password', ADMIN_PW);
  await idlePage.fill('#confirm', ADMIN_PW);
  await Promise.all([
    idlePage.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => {}),
    idlePage.click('#submit')
  ]);
  await idlePage.waitForFunction(
    () => document.querySelectorAll('#page-stage .paper').length > 0,
    null, { timeout: 20000 });
  await idlePage.waitForTimeout(700);

  const idleCookieObj = await sessionCookieObj(idleCtx, idleSrv.base);
  const idleCookie = idleCookieObj ? 'keys_sid=' + idleCookieObj.value : '';

  /* The published constant must be the server's number, not the client's
   * default — a UI that quotes five minutes while the server enforces four
   * seconds is worse than one that quotes nothing. */
  check('the client adopts the server\'s idle budget rather than its own default',
    (await idlePage.evaluate(() => window.Keys.Auth.IDLE_MS)) === 4000,
    String(await idlePage.evaluate(() => window.Keys.Auth.IDLE_MS)));

  /* GET /api/auth/state must NOT refresh lastSeen. If it did, every
   * visibilitychange, focus and online probe would be a keepalive and the
   * timeout would never fire for a tab that is merely open. */
  const probe = await idlePage.evaluate(async () => {
    const a = await fetch('/api/auth/state', { credentials: 'same-origin' }).then(r => r.json());
    await new Promise(r => setTimeout(r, 1200));
    const b = await fetch('/api/auth/state', { credentials: 'same-origin' }).then(r => r.json());
    return { a: a.signedIn, b: b.signedIn };
  });
  check('asking "am I still signed in?" does not answer "yes" by the act of asking',
    probe.a === true && probe.b === true, JSON.stringify(probe));

  /* Work in progress, typed the way a person types it — through the editor
   * field, so the preview holds it too. Nobody has pressed Save. This is the
   * thing the whole in-place re-auth exists to protect. */
  await idlePage.evaluate(async () => {
    const el = document.querySelector('#editor-scroll .rt[data-path="masthead.motto"]');
    el.focus();
    el.innerHTML = 'TYPED BUT NOT SAVED BY HAND';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    window.Keys.State.dirty = true;
    el.blur();
  });
  await idlePage.waitForTimeout(300);

  console.log('    \x1b[90m(waiting out the 4s idle window with no activity…)\x1b[0m');
  await idlePage.waitForTimeout(7000);

  /* Server-side first: the clock is the server's, and it must say WHY. A
   * generic refusal would leave the gate telling the person "the server no
   * longer recognises this session" when the truthful, reassuring answer is
   * "you stepped away". */
  const idleTouch = await req(idleSrv, 'POST', '/api/auth/touch',
    { json: {}, cookie: idleCookie });
  check('the server closes an idle session and says IDLE, not just "no"',
    idleTouch.status === 401 && (idleTouch.json || {}).code === 'IDLE',
    idleTouch.status + ' ' + ((idleTouch.json || {}).code || ''));
  check('and the sentence it sends is one a person can act on',
    /signed out after a spell without activity/i.test((idleTouch.json || {}).error || '') &&
    /saved/i.test((idleTouch.json || {}).error || ''),
    String((idleTouch.json || {}).error || '').slice(0, 90));

  const dropped = await idlePage.evaluate(async () => {
    const verdict = await window.Keys.Auth.checkIdle();
    await new Promise(r => setTimeout(r, 800));
    const gate = document.getElementById('auth-gate');
    return {
      verdict,
      gateShown: !!gate && !gate.hidden,
      relocked: document.body.classList.contains('is-relocked'),
      blanked: document.body.classList.contains('is-locked'),
      inert: document.getElementById('app').hasAttribute('inert'),
      sheets: document.querySelectorAll('#page-stage .paper').length,
      fields: document.querySelectorAll('#editor-scroll .rt').length,
      path: location.pathname,
      title: document.getElementById('auth-title').textContent,
      note: document.getElementById('auth-note').textContent,
      noteShown: !document.getElementById('auth-note').hidden,
      nameFilled: document.getElementById('auth-name').value,
      motto: window.Keys.State.get('masthead.motto'),
      saved: (JSON.parse(localStorage.getItem(window.Keys.State.STORAGE_KEY) || '{}')
        .masthead || {}).motto,
      signedIn: !!window.Keys.Auth.currentUser()
    };
  });

  check('a lapsed session is noticed',
    /expired|idle|no session/i.test(String(dropped.verdict)) &&
    dropped.signedIn === false, String(dropped.verdict));
  check('the gate comes back up IN PLACE, not as a fresh boot',
    dropped.gateShown === true && dropped.relocked === true &&
    dropped.blanked === false,
    JSON.stringify({ gate: dropped.gateShown, relocked: dropped.relocked,
                     locked: dropped.blanked }));
  /* The one that matters. is-locked would display:none the whole app; this
   * path must leave it laid out, scroll positions and all, so signing back in
   * does not feel like a reload. */
  check('the four sheets are STILL IN THE DOM behind the gate',
    dropped.sheets === 4 && dropped.fields > 0,
    `sheets=${dropped.sheets} fields=${dropped.fields}`);
  check('no navigation happened — the tab is still on the app',
    dropped.path === '/' && dropped.path !== '/login', dropped.path);
  check('the app is made inert, so nothing behind the gate is tabbable',
    dropped.inert === true);
  check('the issue was saved before the gate went up, so nothing is at risk',
    dropped.motto === 'TYPED BUT NOT SAVED BY HAND' &&
    dropped.saved === 'TYPED BUT NOT SAVED BY HAND',
    `in memory=${dropped.motto} autosaved=${dropped.saved}`);
  /* "Sign in again", not "Sign in": the difference is the difference between
   * an interruption and a fault. And the reassurance has to be there, because
   * the first thing anybody wants to know is whether they lost the issue. */
  check('it asks to sign in AGAIN, and promises nothing is lost',
    /sign in again/i.test(dropped.title) && dropped.noteShown === true &&
    /session/i.test(dropped.note) && /Nothing is lost/i.test(dropped.note),
    `"${dropped.title}" — ${dropped.note.slice(0, 80)}`);
  /* The name is remembered because it authorises nothing — the server rechecks
   * both fields — and typing it again is pure friction for somebody who is
   * trying to get back to a half-finished sentence. */
  check('the name is already filled in, so only a password has to be typed',
    dropped.nameFilled === ADMIN_NAME, dropped.nameFilled);

  await idlePage.fill('#auth-password', ADMIN_PW);
  await idlePage.click('#auth-submit');
  await idlePage.waitForFunction(
    () => document.getElementById('auth-gate').hidden === true,
    null, { timeout: 15000 });
  await idlePage.waitForTimeout(600);

  const resumed = await idlePage.evaluate(() => ({
    gateHidden: document.getElementById('auth-gate').hidden,
    relocked: document.body.classList.contains('is-relocked'),
    inert: document.getElementById('app').hasAttribute('inert'),
    sheets: document.querySelectorAll('#page-stage .paper').length,
    path: location.pathname,
    motto: window.Keys.State.get('masthead.motto'),
    onPage: (document.querySelector(
      '#page-stage [data-bind="masthead.motto"]') || {}).textContent,
    me: (window.Keys.Auth.currentUser() || {}).name
  }));

  check('signing in again dismisses the gate',
    resumed.gateHidden === true && resumed.relocked === false &&
    resumed.inert === false, JSON.stringify(resumed));
  check('the same document is still loaded — no reload, nothing retyped',
    resumed.sheets === 4 && resumed.path === '/' &&
    resumed.motto === 'TYPED BUT NOT SAVED BY HAND' &&
    resumed.onPage === 'TYPED BUT NOT SAVED BY HAND',
    JSON.stringify({ sheets: resumed.sheets, path: resumed.path,
                     motto: resumed.motto, onPage: resumed.onPage }));
  check('and identity is restored', resumed.me === ADMIN_NAME, String(resumed.me));

  const realIdleErrors = idleErrors.filter(e => !REFUSALS.test(e));
  check('no unexpected page or console errors through the whole lapse',
    realIdleErrors.length === 0, realIdleErrors.slice(0, 4).join(' | '));

  await idleCtx.close();
  await idleSrv.stop();

  /* ==================================================== the wrong server ====
   * "THE ADMINISTRATOR COULD NOT ADD USERS, AND SIGN OUT SAID HTTP 404."
   *
   * That was the field report, and it was one cause wearing two faces: the
   * folder was being served by a plain file server rather than by
   * server/server.js, so GET / returned 200, every /api/* returned a code-less
   * 404, and the client — which trusted location.protocol and nothing else —
   * booted all the way into a usable-looking editor that could not touch an
   * account. Booting into a broken editor IS the bug; these checks are here so
   * it cannot come back quietly.
   *
   * The fixture is not a stub. It is `python3 -m http.server` on the
   * repository root: exactly what the reporter had.
   * ---------------------------------------------------------------------- */
  section('Accounts — the wrong server is answering');

  const stat = startStaticServer();
  const statUp = await waitForStatic(stat);
  check('a plain file server is serving the repository root',
    statUp === true, statUp ? stat.base : stat.log().slice(0, 300));

  const statRoot = await req(stat, 'GET', '/');
  const statApi = await req(stat, 'GET', '/api/auth/state');
  /* The fixture has to reproduce the misconfiguration before anything about
   * the response to it means very much: 200 for the app, and a reply with no
   * `code` in it for the API. That absent `code` is the whole classifier —
   * AUTH-API §9 — so it is asserted rather than assumed. */
  check('it hands over the app with 200 and answers the API with a code-less 404',
    statRoot.status === 200 && /St\. Peter/i.test(statRoot.text) &&
    statApi.status === 404 && !(statApi.json && statApi.json.code),
    `/ -> ${statRoot.status}, /api/auth/state -> ${statApi.status} ` +
    JSON.stringify(statApi.json));

  const noApiCtx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  /* Counted, because how MANY times the client asks is itself a requirement
   * further down. continue() only, so nothing is faked. */
  let statePolls = 0;
  await noApiCtx.route('**/api/auth/state*', (route) => {
    statePolls++;
    return route.continue();
  });
  const noApiPage = await noApiCtx.newPage();
  const noApiErrors = [];
  noApiPage.on('pageerror', e => noApiErrors.push('pageerror: ' + e.message));

  await noApiPage.goto(stat.base + '/', { waitUntil: 'domcontentloaded' });
  await noApiPage.waitForFunction(() => {
    const g = document.getElementById('auth-gate');
    return !!g && g.hidden === false;
  }, null, { timeout: 20000 }).catch(() => {});
  await noApiPage.waitForTimeout(900);
  const pollsAtBoot = statePolls;

  const wrongSrv = await noApiPage.evaluate(() => {
    const app = document.getElementById('app');
    const gate = document.getElementById('auth-gate');
    const txt = id => ((document.getElementById(id) || {}).textContent || '')
      .replace(/\s+/g, ' ').trim();
    return {
      gateShown: !!gate && gate.hidden === false,
      papers: document.querySelectorAll('#page-stage .paper').length,
      appDisplay: app ? getComputedStyle(app).display : null,
      appInert: app ? app.hasAttribute('inert') : null,
      formHidden: (document.getElementById('auth-form') || {}).hidden,
      retryShown: !!(document.getElementById('auth-retry') &&
        document.getElementById('auth-retry').hidden === false),
      title: txt('auth-title'),
      lead: txt('auth-lead'),
      note: txt('auth-note'),
      panel: (gate ? gate.textContent : '').replace(/\s+/g, ' ').trim()
    };
  });

  check('the blocking panel is up', wrongSrv.gateShown === true,
    String(wrongSrv.gateShown));
  /* The bug was not "an error appeared". The bug was that the editor opened. */
  check('the editor never opens — not one sheet is rendered',
    wrongSrv.papers === 0, 'papers=' + wrongSrv.papers);
  check('the app is hidden AND inert, not merely covered over',
    wrongSrv.appDisplay === 'none' && wrongSrv.appInert === true,
    `display=${wrongSrv.appDisplay} inert=${wrongSrv.appInert}`);
  /* A password box in front of a static file server would take a real
   * password, post it to something that has never heard of /api/auth/signin,
   * and report a failure that reads as "you typed it wrong". */
  check('no sign-in form is offered, because there is nothing behind it',
    wrongSrv.formHidden === true, String(wrongSrv.formHidden));
  check('a "Try again" button is offered, for when the real server is started',
    wrongSrv.retryShown === true, String(wrongSrv.retryShown));
  check('the message names the cause — the wrong program is answering',
    /not the St\. Peter/i.test(wrongSrv.title) &&
    /is being served by something that is not/i.test(wrongSrv.note),
    wrongSrv.title);
  check('it says how to get accounts back, by name',
    /node server\/server\.js/.test(wrongSrv.note),
    wrongSrv.note.slice(0, 120));
  /* Failing closed with no way forward would be a different bug: the
   * newsletter itself works perfectly from disk and accounts are no part of
   * it, so the offline route has to be on the panel. */
  check('and how to carry on without them, so nobody is trapped',
    /index\.html/.test(wrongSrv.note), wrongSrv.note.slice(0, 160));
  /* "The server sent a reply this app could not read (HTTP 404)" was true,
   * useless, and blamed the server for something the server never did. */
  check('the old "could not read" wording appears nowhere on the panel',
    !/could not read/i.test(wrongSrv.panel),
    wrongSrv.panel.slice(0, 140));

  /* AUTH-API §9: a code-less reply is POSITIVE evidence and is identical next
   * time, so it is not retried — three attempts against a file server would
   * only make somebody wait three times as long for the same explanation. The
   * transient case, which IS retried, is the section after this one. */
  check('a code-less reply is not retried — one request, one verdict',
    pollsAtBoot === 1, 'state requests during boot: ' + pollsAtBoot);

  const noApiCalls = await noApiPage.evaluate(async () => {
    const A = window.Keys.Auth;
    return {
      signOut: await A.signOut(),
      addUser: await A.addUser('Someone New', 'a-good-passphrase', 'user'),
      users: await A.users(),
      removeUser: await A.removeUser('Someone New'),
      changePassword: await A.changePassword('a-good-passphrase', 'another-passphrase')
    };
  });
  /* The two faces of the report, and the three neighbours that would have
   * failed the same way. Each resolves the actionable sentence, not a status:
   * a caller branching on `code` gets NO_API, and a person reading the error
   * gets told to run the server. */
  for (const call of ['signOut', 'addUser', 'users', 'removeUser', 'changePassword']) {
    const r = noApiCalls[call] || {};
    check(`${call}() resolves NO_API with the sentence that names the fix`,
      r.code === 'NO_API' && /node server\/server\.js/.test(r.error || '') &&
      !/could not read/i.test(r.error || ''),
      JSON.stringify(r).slice(0, 170));
  }

  const noApiDiag = await noApiPage.evaluate(() => window.Keys.Auth.diagnose());
  /* First line, ahead of every other reading in the object: "not signed in"
   * and "no accounts" are meaningless when they were read from a program that
   * has never heard of an account, and whoever is reading diagnose() is
   * reading it because accounts are behaving oddly. */
  check('diagnose() names the misconfiguration before anything else',
    /^wrong server/i.test(String(noApiDiag.summary || '').trim()),
    String(noApiDiag.summary).slice(0, 120));
  check('diagnose() reports the API as absent',
    noApiDiag.apiPresent === false, 'apiPresent=' + noApiDiag.apiPresent);

  check('no unhandled page errors while the panel is up',
    noApiErrors.length === 0, noApiErrors.slice(0, 3).join(' | '));

  await noApiCtx.close();
  await stat.stop();

  /* ============================================== absent vs transient ======
   * THE DISCRIMINATION THAT MATTERS MOST.
   *
   * "Absent" and "unreachable" are different, and conflating them loses work.
   * A code-less reply is evidence about the program on the other end; a
   * rejected fetch is evidence about nothing at all. If the section above were
   * implemented by treating every failure as the wrong server, a momentary
   * network blip would evict an author from a half-written issue — which is a
   * worse bug than the one being fixed.
   *
   * Run against the REAL server, signed in, with Playwright aborting requests
   * so the transient class is genuinely transient: no status, no body,
   * nothing heard back.
   * ---------------------------------------------------------------------- */
  section('Accounts — a network blip is not a misconfiguration');

  const blipSrv = startServer({}, { port: extraPort() });
  const blipUp = await waitForServer(blipSrv);
  check('a real server starts for the blip checks', blipUp === true,
    blipUp ? blipSrv.base : blipSrv.log().slice(0, 300));

  const blipToken = fs.readFileSync(
    path.join(blipSrv.dir, 'setup-token.txt'), 'utf8').trim();

  const blipCtx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  /* One knob, read on every state request: how many of the next ones to drop.
   * abort() is a rejected fetch in the page — no status, no body — which is
   * exactly the class under test. */
  const blip = { polls: 0, dropNext: 0 };
  await blipCtx.route('**/api/auth/state*', (route) => {
    blip.polls++;
    if (blip.dropNext > 0) { blip.dropNext--; return route.abort('failed'); }
    return route.continue();
  });

  const blipPage = await blipCtx.newPage();
  const blipErrors = [];
  blipPage.on('pageerror', e => blipErrors.push('pageerror: ' + e.message));
  blipPage.on('console', m => { if (m.type() === 'error') blipErrors.push('console: ' + m.text()); });

  await blipPage.goto(blipSrv.base + '/', { waitUntil: 'domcontentloaded' });
  await blipPage.fill('#token', blipToken);
  await blipPage.fill('#name', ADMIN_NAME);
  await blipPage.fill('#password', ADMIN_PW);
  await blipPage.fill('#confirm', ADMIN_PW);
  await Promise.all([
    blipPage.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => {}),
    blipPage.click('#submit')
  ]);
  await blipPage.waitForFunction(
    () => document.querySelectorAll('#page-stage .paper').length > 0,
    null, { timeout: 20000 });
  await blipPage.waitForTimeout(600);

  /* --- one dropped request at boot --------------------------------------- */
  blip.polls = 0;
  blip.dropNext = 1;
  await blipPage.reload({ waitUntil: 'domcontentloaded' });
  await blipPage.waitForFunction(
    () => document.querySelectorAll('#page-stage .paper').length > 0,
    null, { timeout: 20000 }).catch(() => {});
  await blipPage.waitForTimeout(900);

  const afterBlip = await blipPage.evaluate(() => ({
    papers: document.querySelectorAll('#page-stage .paper').length,
    gateHidden: (document.getElementById('auth-gate') || {}).hidden,
    locked: document.body.classList.contains('is-locked'),
    me: (window.Keys.Auth.currentUser() || {}).name,
    title: ((document.getElementById('auth-title') || {}).textContent || '').trim()
  }));
  /* Getting this wrong means one unlucky request at load evicts an author
   * from their work and shows them a panel accusing their administrator of
   * running the wrong program. */
  check('a single dropped request at boot is retried, and the app boots normally',
    afterBlip.papers === 4 && afterBlip.gateHidden === true &&
    afterBlip.locked === false && afterBlip.me === ADMIN_NAME,
    JSON.stringify(afterBlip));
  check('the retry is a second request, not a second guess',
    blip.polls === 2, 'state requests: ' + blip.polls);

  /* --- a genuine refusal, on the same server, unchanged ------------------- */
  const badPw = await blipPage.evaluate(
    n => window.Keys.Auth.signIn(n, 'definitely-not-the-passphrase'), ADMIN_NAME);
  const badPwDiag = await blipPage.evaluate(() => window.Keys.Auth.diagnose());
  /* The classifier is response SHAPE, not status code, and that has to leave
   * the server's own refusals completely alone. A 401 that carries a `code` is
   * the server talking, and its sentence is the one to show. */
  check('a wrong password still gives the server\'s own sentence, not the wrong-server panel',
    badPw.code === 'BAD_CREDENTIALS' &&
    /do not match/i.test(badPw.error || '') &&
    !/not the St\. Peter/i.test(badPw.error || ''),
    JSON.stringify(badPw).slice(0, 170));
  check('and the API is still considered present after a genuine refusal',
    badPwDiag.apiPresent === true && badPwDiag.gateShowing === false,
    `apiPresent=${badPwDiag.apiPresent} gate=${badPwDiag.gateShowing}`);

  /* --- dropped requests mid-session -------------------------------------- */
  blip.dropNext = 6;                      // every state request from here
  const midBlip = await blipPage.evaluate(async () => {
    const verdict = await window.Keys.Auth.checkIdle();
    await new Promise(r => setTimeout(r, 500));
    const gate = document.getElementById('auth-gate');
    return {
      verdict,
      gateShown: !!gate && gate.hidden === false,
      relocked: document.body.classList.contains('is-relocked'),
      papers: document.querySelectorAll('#page-stage .paper').length,
      me: (window.Keys.Auth.currentUser() || {}).name
    };
  });
  blip.dropNext = 0;

  /* AUTH-API §9: only a server that actually answers may end a session.
   * 'unknown' means we could not reach it; 'expired' means it was reached and
   * said no. Collapsing the two puts the gate over somebody's unsaved issue
   * because their wifi dropped for a moment. */
  check('an unreachable server leaves checkIdle() at \'unknown\', never \'expired\'',
    midBlip.verdict === 'unknown', String(midBlip.verdict));
  check('and the gate stays down over a running editor',
    midBlip.gateShown === false && midBlip.relocked === false &&
    midBlip.papers === 4 && midBlip.me === ADMIN_NAME,
    JSON.stringify(midBlip));

  const blipRealErrors = blipErrors.filter(e => !REFUSALS.test(e) &&
    !/Failed to fetch|net::ERR_FAILED|ERR_ABORTED/i.test(e));
  check('no unexpected page or console errors through the blips',
    blipRealErrors.length === 0, blipRealErrors.slice(0, 4).join(' | '));

  await blipCtx.close();
  await blipSrv.stop();

  /* ======================================================= local mode ======
   * THE DESKTOP APP (KEYS_LOCAL=1), and the one interlock it rests on.
   *
   * Local mode has no authentication whatsoever: no gate, no accounts, no
   * sessions, no setup token. What makes that safe is a single rule in
   * server/server.js — the listen address is 127.0.0.1, full stop, and the
   * server refuses to start if KEYS_HOST asks for anything else. "No
   * authentication" plus 0.0.0.0 publishes the newsletter, and a working
   * editor for it, to every machine on the network, and looks — from the
   * machine that started it — exactly like a working desktop app. The failure
   * is total and silent, which is why the interlock is checked first and from
   * both sides: the process must not run, AND no socket must appear.
   * ---------------------------------------------------------------------- */
  section('Accounts — the desktop app (local mode): the loopback interlock');

  const lan = lanAddress();
  const refusedHosts = ['0.0.0.0', 'localhost', '::1'];
  if (lan) refusedHosts.push(lan);
  else warn('no LAN address on this machine to test the interlock against');

  for (const host of refusedHosts) {
    const attempt = await startServerExpectingExit(
      { KEYS_LOCAL: '1', KEYS_HOST: host });
    const reachable = await tcpProbe('127.0.0.1', attempt.port);
    check(`KEYS_LOCAL=1 with KEYS_HOST=${host} exits non-zero and binds nothing`,
      attempt.code !== 0 && attempt.timedOut === false &&
      reachable === 'ECONNREFUSED',
      `exit=${attempt.code} signal=${attempt.signal} port ${attempt.port} -> ${reachable}`);
  }

  const refusalLog = (await startServerExpectingExit(
    { KEYS_LOCAL: '1', KEYS_HOST: '0.0.0.0' })).log;
  /* The refusal has to explain the danger, not merely cite the rule. Somebody
   * who set KEYS_HOST=0.0.0.0 was trying to reach the app from another
   * machine, and "refusing to start" on its own reads as a bug in the server
   * rather than as a warning about what they very nearly did. */
  check('the refusal explains the danger, not just the rule',
    /refusing to start/i.test(refusalLog) &&
    /every machine on the network/i.test(refusalLog) &&
    /127\.0\.0\.1/.test(refusalLog),
    refusalLog.replace(/\s+/g, ' ').slice(0, 200));

  const explicitLoopback = startServer(
    { KEYS_LOCAL: '1', KEYS_DATA: undefined }, { port: extraPort() });
  const explicitUp = await waitForServer(explicitLoopback);
  check('KEYS_HOST=127.0.0.1 — the one accepted spelling — starts normally',
    explicitUp === true, explicitUp ? explicitLoopback.base
      : explicitLoopback.log().slice(0, 300));
  await explicitLoopback.stop();

  /* envFlag() accepts the word as well as the digit, and desktop/README and
   * the launchers are free to use either — so both have to work. */
  const wordForm = startServer(
    { KEYS_LOCAL: 'true', KEYS_HOST: undefined, KEYS_DATA: undefined },
    { port: extraPort() });
  const wordUp = await waitForServer(wordForm);
  const wordState = await req(wordForm, 'GET', '/api/auth/state');
  check('KEYS_LOCAL=true, the word, is honoured exactly like the digit',
    wordUp === true && wordState.json && wordState.json.mode === 'local',
    wordUp ? JSON.stringify(wordState.json && wordState.json.mode)
      : wordForm.log().slice(0, 300));
  await wordForm.stop();

  section('Accounts — the desktop app (local mode)');

  /* KEYS_HOST unset, which is how desktop/launch.js runs it, and KEYS_DATA
   * unset too so the "nothing is created" check below has something to prove.
   * There is deliberately no accounts file, no token and no session anywhere
   * in this section. */
  const localSrv = startServer(
    { KEYS_LOCAL: '1', KEYS_HOST: undefined, KEYS_DATA: undefined },
    { port: extraPort() });
  const localUp = await waitForServer(localSrv);
  check('with KEYS_HOST unset, the desktop server starts', localUp === true,
    localUp ? localSrv.base : localSrv.log().slice(0, 400));

  const bound = listeningAddresses(localSrv.proc.pid);
  if (bound === null) {
    warn('lsof unavailable — the listening address was checked over TCP only');
  } else {
    /* `*:8858` is the shape of the disaster: one wildcard bind is the whole
     * difference between a desktop app and an unauthenticated editor published
     * to the parish network. */
    check('it is listening on 127.0.0.1 only, not on *',
      bound.length === 1 && bound[0] === '127.0.0.1:' + localSrv.port,
      bound.join(', ') || 'nothing listening');
  }
  if (lan) {
    const fromLan = await tcpProbe(lan, localSrv.port);
    /* The same question the OS was asked above, asked again over TCP, because
     * this is the one that would actually hurt: a wildcard bind ACCEPTS this
     * connection (verified — it resolves 'connected'), and loopback-only never
     * does. Whether the refusal arrives as ECONNREFUSED or as silence depends
     * on the host firewall and is not the app's business; "no connection" is. */
    check('and nothing answers at this machine\'s own network address',
      fromLan !== 'connected', lan + ':' + localSrv.port + ' -> ' + fromLan);
  }

  /* --- the routes, per AUTH-API §4a -------------------------------------- */
  const localRoot = await req(localSrv, 'GET', '/');
  check('GET / is the app itself — 200, no gate, no redirect',
    localRoot.status === 200 && /St\. Peter/i.test(localRoot.text) &&
    /id="page-stage"/.test(localRoot.text) && !localRoot.headers.location,
    localRoot.status + ' ' + (localRoot.headers['content-type'] || ''));

  for (const p of ['/login', '/setup']) {
    const res = await req(localSrv, 'GET', p);
    /* Not a 404: a bookmark from the served version should land somewhere
     * useful rather than looking like a broken install. */
    check(`${p} sends a bookmark from the served version to the app`,
      res.status === 302 && res.headers.location === '/',
      res.status + ' -> ' + res.headers.location);
  }

  for (const p of ['/assets/js/app.js', '/assets/js/auth.js', '/assets/css/app.css']) {
    const res = await req(localSrv, 'GET', p);
    check(`${p} is served without any authentication`,
      res.status === 200 && res.text.length > 100,
      res.status + ' ' + res.text.length + ' bytes');
  }

  const localState = await req(localSrv, 'GET', '/api/auth/state');
  const ls = localState.json || {};
  check('/api/auth/state answers mode "local", already signed in',
    localState.status === 200 && ls.mode === 'local' && ls.signedIn === true &&
    ls.hasAccounts === true && ls.user && ls.user.name === 'Local' &&
    ls.user.role === 'user',
    JSON.stringify(ls).slice(0, 170));
  /* 0 means "no timeout", and it is only ever sent here. A client that quoted
   * five minutes and then never followed through would teach people to ignore
   * the next warning that mattered. */
  check('and reports no clocks at all — idleMs 0, maxAgeMs 0',
    ls.idleMs === 0 && ls.maxAgeMs === 0,
    `idleMs=${ls.idleMs} maxAgeMs=${ls.maxAgeMs}`);

  const localTouch = await req(localSrv, 'POST', '/api/auth/touch', { json: {} });
  check('touch is a no-op rather than a refusal, so an older client costs nothing',
    localTouch.status === 200 && (localTouch.json || {}).idleFor === 0 &&
    (localTouch.json || {}).expiresInMs === 0,
    localTouch.status + ' ' + JSON.stringify(localTouch.json));

  /* Every account route, refused specifically. Not 404 — "no such endpoint"
   * sends somebody looking for a typo — and emphatically not a silent success:
   * pretending to add a user who cannot exist is worse than saying no. */
  const accountRoutes = [
    ['POST', '/api/auth/signin', { name: 'Local', password: 'a-good-passphrase' }],
    ['POST', '/api/auth/signout', {}],
    ['POST', '/api/auth/setup', { token: 'X', name: 'A', password: 'a-good-passphrase' }],
    ['POST', '/api/auth/password', { current: 'aaaaaaaa', next: 'bbbbbbbb' }],
    ['GET', '/api/users', null],
    ['POST', '/api/users', { name: 'Someone', password: 'a-good-passphrase' }],
    ['DELETE', '/api/users/Someone', {}]
  ];
  for (const [method, p, body] of accountRoutes) {
    const res = await req(localSrv, method, p,
      body === null ? {} : { json: body });
    check(`${method} ${p} is refused 403 LOCAL_MODE`,
      res.status === 403 && (res.json || {}).code === 'LOCAL_MODE' &&
      /desktop version/i.test((res.json || {}).error || ''),
      res.status + ' ' + JSON.stringify(res.json).slice(0, 90));
  }

  /* Local mode must not touch the accounts file at all — no accounts.json, no
   * setup-token.txt, nothing left behind on somebody's laptop. KEYS_DATA was
   * left unset above precisely so the default location can be checked. */
  const defaultDataDir = path.join(ROOT, 'server', 'data');
  check('server/data is never created — local mode has no accounts to store',
    fs.existsSync(defaultDataDir) === false, defaultDataDir);

  /* DNS rebinding: a hostile page can point a name it controls at 127.0.0.1
   * and become same-origin with an unauthenticated server. The Host header is
   * what gives that away. */
  const spoofedHost = await req(localSrv, 'GET', '/',
    { headers: { Host: 'evil.example' } });
  check('a request with a spoofed Host header is refused',
    spoofedHost.status === 400, String(spoofedHost.status));
  const namedHost = await req(localSrv, 'GET', '/',
    { headers: { Host: 'localhost:' + localSrv.port } });
  check('while the launcher\'s own names still work',
    namedHost.status === 200, String(namedHost.status));

  /* --- the desktop copy in a real browser -------------------------------- */
  const localCtx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  /* Installed before any page script runs. The heartbeat is the one thing that
   * has to be proven ABSENT, and the only honest way to do that is to watch
   * for the timer it would need and the request it would send. */
  await localCtx.addInitScript(() => {
    window.__intervals = [];
    const realInterval = window.setInterval;
    window.setInterval = function (fn, ms) {
      window.__intervals.push(Number(ms));
      return realInterval.apply(this, arguments);
    };
    window.__fetches = [];
    const realFetch = window.fetch;
    window.fetch = function () {
      window.__fetches.push(String(arguments[0]));
      return realFetch.apply(this, arguments);
    };
  });
  const localPage = await localCtx.newPage();
  const localErrors = [];
  localPage.on('pageerror', e => localErrors.push('pageerror: ' + e.message));
  localPage.on('console', m => { if (m.type() === 'error') localErrors.push('console: ' + m.text()); });

  await localPage.goto(localSrv.base + '/', { waitUntil: 'domcontentloaded' });
  await localPage.waitForFunction(
    () => document.querySelectorAll('#page-stage .paper').length > 0,
    null, { timeout: 20000 }).catch(() => {});
  await localPage.waitForTimeout(900);

  const localBoot = await localPage.evaluate(() => ({
    papers: document.querySelectorAll('#page-stage .paper').length,
    fields: document.querySelectorAll('#editor-scroll .rt').length,
    gateHidden: (document.getElementById('auth-gate') || {}).hidden,
    locked: document.body.classList.contains('is-locked'),
    relocked: document.body.classList.contains('is-relocked'),
    inert: document.getElementById('app').hasAttribute('inert'),
    mode: window.Keys.Auth.mode,
    idleMs: window.Keys.Auth.IDLE_MS,
    me: window.Keys.Auth.currentUser()
  }));

  check('the desktop copy opens straight into the editor',
    localBoot.papers === 4 && localBoot.fields > 0,
    `papers=${localBoot.papers} fields=${localBoot.fields}`);
  check('there is no gate, and nothing is locked or inert',
    localBoot.gateHidden === true && localBoot.locked === false &&
    localBoot.relocked === false && localBoot.inert === false,
    JSON.stringify(localBoot));
  /* AUTH-API §0: the client still sees http://, so its own mode is unchanged.
   * Local mode is a property of the server, and nothing about the client's
   * mode detection moves. */
  check('the client still calls this served mode — local mode is the server\'s business',
    localBoot.mode === 'served', String(localBoot.mode));
  check('nothing claims a timeout that cannot fire',
    localBoot.idleMs === 0, 'IDLE_MS=' + localBoot.idleMs);

  /* --- the honesty requirements ------------------------------------------ */
  const localSettings = await localPage.evaluate(async () => {
    window.Keys.Auth.openSettings();
    await new Promise(r => setTimeout(r, 400));
    const vis = el => !!(el && !el.hidden && el.offsetParent !== null);
    const txt = el => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
    const out = {
      open: document.getElementById('settings-dialog').open,
      noteShown: vis(document.getElementById('settings-offline')),
      note: txt(document.getElementById('settings-offline')),
      signout: vis(document.getElementById('settings-signout')),
      password: vis(document.getElementById('settings-password-section')),
      account: vis(document.getElementById('settings-account-section')),
      people: vis(document.getElementById('settings-people')),
      rosterNodes: document.querySelectorAll('#settings-user-list *').length,
      removeButtons: document.querySelectorAll('[data-auth="remove"]').length,
      who: txt(document.getElementById('settings-who'))
    };
    window.Keys.Auth.closeSettings();
    return out;
  });

  check('Settings explains that this is the desktop copy',
    localSettings.open === true && localSettings.noteShown === true &&
    /desktop copy/i.test(localSettings.note),
    localSettings.note.slice(0, 120));
  /* The offline copy's sentence would be a lie here. There IS a server — it is
   * what is serving the page — and the safety comes from where it listens, so
   * that is the promise to state. */
  check('the note does not claim "there is no server", because there is one',
    !/there is no server/i.test(localSettings.note),
    localSettings.note.slice(0, 120));
  check('it says the server is unreachable from other machines, and names 127.0.0.1',
    /127\.0\.0\.1/.test(localSettings.note) &&
    /not reachable/i.test(localSettings.note),
    localSettings.note.slice(0, 160));
  check('no sign-out button — there is nobody to sign out',
    localSettings.signout === false);
  check('no change-password form, and no people to add or remove',
    localSettings.password === false && localSettings.account === false &&
    localSettings.people === false,
    JSON.stringify({ pw: localSettings.password, acct: localSettings.account,
                     people: localSettings.people }));
  /* Hidden is not enough. A roster built from a placeholder user and then
   * hidden is markup describing accounts that do not exist, one CSS mistake
   * away from being on screen. */
  check('no roster markup is built at all',
    localSettings.rosterNodes === 0 && localSettings.removeButtons === 0,
    `nodes=${localSettings.rosterNodes} remove=${localSettings.removeButtons}`);
  /* The server answers with a placeholder user called "Local" so the client
   * boots. Repeating that name back as though it were an account holder would
   * send somebody looking for an account that cannot exist. */
  check('it does not name a phantom account holder',
    /this computer only/i.test(localSettings.who) &&
    !/\bLocal\b/.test(localSettings.who), localSettings.who);

  /* --- editing, which is the whole point of the thing -------------------- */
  const localEdit = await localPage.evaluate(async () => {
    const el = document.querySelector('#editor-scroll .rt[data-path="masthead.motto"]');
    if (!el) return { err: 'no editor field' };
    el.focus();
    el.innerHTML = 'THE DESKTOP COPY EDITS';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1200));
    el.blur();
    return {
      onPage: (document.querySelector(
        '#page-stage [data-bind="masthead.motto"]') || {}).textContent,
      autosaved: /THE DESKTOP COPY EDITS/.test(
        localStorage.getItem('stpeters.keys.autosave.v2') || '')
    };
  });
  check('typing reaches the preview',
    localEdit.onPage === 'THE DESKTOP COPY EDITS', String(localEdit.onPage));
  check('and is autosaved to this origin\'s storage',
    localEdit.autosaved === true, JSON.stringify(localEdit));

  /* --- no heartbeat ------------------------------------------------------- */
  const beat = await localPage.evaluate(async () => {
    const before = window.__fetches.length;
    /* Activity is the only thing that justifies a touch, so provoke some. In
     * local mode nothing is even listening for it. */
    for (let i = 0; i < 5; i++) {
      document.dispatchEvent(new Event('mousemove', { bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
      await new Promise(r => setTimeout(r, 300));
    }
    return {
      intervals: window.__intervals.slice(),
      after: window.__fetches.slice(before)
    };
  });
  /* Nothing can expire, so a request a minute forever would be pure waste —
   * and a warning that "you will be signed out in about 30 seconds" would be
   * simply false in a copy with no sign-in. */
  check('no idle heartbeat timer is ever started',
    beat.intervals.indexOf(30000) === -1, 'intervals: ' + beat.intervals.join(', '));
  check('and activity provokes no touch, because there is no session to keep',
    beat.after.every(u => !/\/api\/auth\/touch/.test(u)),
    beat.after.join(', ') || 'no requests at all');

  const localDiag = await localPage.evaluate(() => window.Keys.Auth.diagnose());
  check('diagnose() identifies the desktop copy',
    /desktop copy/i.test(localDiag.summary || '') &&
    /KEYS_LOCAL=1/.test(localDiag.summary || ''),
    String(localDiag.summary).slice(0, 130));
  check('diagnose() quotes no timeout, rather than the client default',
    localDiag.idleTimeoutMinutes === 0,
    'minutes=' + localDiag.idleTimeoutMinutes);
  check('diagnose() reports the server\'s mode',
    localDiag.serverMode === 'local', String(localDiag.serverMode));

  check('no console or page errors anywhere in the desktop copy',
    localErrors.length === 0, localErrors.slice(0, 4).join(' | '));

  /* Asked again at the end: a stray write during the browser session would be
   * as bad as one at startup, and this is where it would show up. */
  check('and still no server/data after a whole session in the desktop copy',
    fs.existsSync(defaultDataDir) === false, defaultDataDir);

  await localCtx.close();
  await localSrv.stop();

  /* ---------------------------------------------------------------- shots--
   * Screenshots and the PDF must show a PRISTINE document. The tests above
   * deliberately mutate state (including loading a legacy v1 file), and the
   * app autosaves on beforeunload — so clearing localStorage and reloading in
   * this page would just re-persist the mutated doc on the way out. A fresh
   * browser context gets its own storage, sidestepping that entirely.
   * ---------------------------------------------------------------------- */
  if (WANT_SHOTS || WANT_PDF) {
    const cleanCtx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
    const clean = await cleanCtx.newPage();
    const cleanErrors = [];
    clean.on('pageerror', e => cleanErrors.push(e.message));
    await clean.goto(URL, { waitUntil: 'load' });
    await clean.waitForTimeout(900);

    const seeded = await clean.evaluate(() => ({
      title: (document.querySelector('#page-stage [data-bind="masthead.title"]') || {}).textContent,
      restored: !!document.querySelector('#toasts .toast')
    }));
    section('Clean-context render');
    check('screenshot context shows the seeded document, not test residue',
      /PETER/i.test(seeded.title || ''), 'title=' + JSON.stringify(seeded.title));
    check('clean context boots without errors', cleanErrors.length === 0,
      cleanErrors.join('\n      '));

    if (WANT_SHOTS) await takeShots(clean);
    if (WANT_PDF) await exportPdf(clean);
    await cleanCtx.close();
  }

  async function takeShots(page) {
    section('Screenshots');
    await page.screenshot({ path: path.join(OUT, 'app.png') });
    ok('app.png');
    for (let n = 1; n <= 4; n++) {
      await page.evaluate(async (i) => {
        window.Keys.Flip.go(i, { animate: false });
        window.Keys.Fit.refitAll({ force: true });
        await new Promise(r => setTimeout(r, 260));
      }, n);
      await page.waitForTimeout(320);
      const el = await page.$(`#page-stage .paper[data-page="${n}"]`);
      await el.screenshot({ path: path.join(OUT, `page-${n}.png`) });
      ok(`page-${n}.png`);
    }
    // Mid-turn frames, to eyeball the animation. The easing front-loads the
    // rotation, so the leaf crosses 90deg — where backface-visibility hides
    // it — at roughly 200ms of the 620ms turn. Sample before that.
    for (const t of [90, 150]) {
      await page.evaluate(() => window.Keys.Flip.go(1, { animate: false }));
      await page.waitForTimeout(250);
      await page.evaluate(() => window.Keys.Flip.next());
      await page.waitForTimeout(t);
      await page.screenshot({ path: path.join(OUT, `turn-${t}ms.png`) });
      ok(`turn-${t}ms.png`);
      await page.waitForTimeout(700);
    }
  }

  /* ------------------------------------------------------------------ pdf--
   * Deliberately does NOT call App.prepareForPrint(). Playwright's page.pdf()
   * fires no beforeprint event, so this exercises the weaker path: print.css
   * alone having to beat the inline styles flip.js leaves on the stage and
   * sheets. If this passes, a raw browser Ctrl/Cmd+P passes too.
   * ---------------------------------------------------------------------- */
  async function exportPdf(page) {
    section('PDF export (print.css only, no JS assist)');
    // Add an extra announcement page so the export is exercised at a sheet
    // count the app does not hard-code anywhere.
    await page.evaluate(async () => {
      window.Keys.App.addAnnouncementPage();
      await new Promise(r => setTimeout(r, 500));
    });
    const expectedSheets = await page.evaluate(() => window.Keys.App.totalPages());
    check('the issue now has an extra sheet to export', expectedSheets === 5,
      'sheets=' + expectedSheets);
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(500);
    const pdfPath = path.join(OUT, 'keys.pdf');
    await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: true });
    const size = fs.statSync(pdfPath).size;
    check('PDF written', size > 5000, size + ' bytes');
    await page.emulateMedia({ media: 'screen' });

    // Verify the exported sheet geometry with poppler: 4 pages, the first
    // three portrait letter and the last landscape letter.
    try {
      const { execFileSync } = require('child_process');
      const info = execFileSync('/opt/homebrew/bin/pdfinfo', [pdfPath], { encoding: 'utf8' });
      const pages = Number((info.match(/^Pages:\s+(\d+)/m) || [])[1]);
      check('PDF sheet count matches the issue', pages === expectedSheets,
        'got ' + pages + ', expected ' + expectedSheets);

      const sizes = [];
      for (let n = 1; n <= Math.max(pages, 0); n++) {
        const one = execFileSync('/opt/homebrew/bin/pdfinfo',
          ['-f', String(n), '-l', String(n), pdfPath], { encoding: 'utf8' });
        const m = one.match(/Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/);
        if (m) sizes.push([Math.round(+m[1]), Math.round(+m[2])]);
      }
      const near = (a, b) => Math.abs(a - b) <= 3;
      sizes.forEach((s, i) => {
        const wantLandscape = i === sizes.length - 1;   // the calendar is last
        const okGeom = wantLandscape ? (near(s[0], 792) && near(s[1], 612))
                                     : (near(s[0], 612) && near(s[1], 792));
        check(`PDF sheet ${i + 1} is letter ${wantLandscape ? 'landscape' : 'portrait'}`,
          okGeom, `got ${s[0]}x${s[1]}pt`);
      });

      // Content sanity: the exported text should carry known strings.
      const txt = execFileSync('/opt/homebrew/bin/pdftotext', [pdfPath, '-'], { encoding: 'utf8' });
      const markers = ['PETER', 'CLASSROOM CORNER', 'THIS WEEK', 'LOOKING AHEAD',
        'FIELD DAY', 'Total Enclosed', 'Sunday', 'Saturday', 'JUNE 2026'];
      const missing = markers.filter(m => !txt.toUpperCase().includes(m.toUpperCase()));
      check('PDF text contains the expected content markers',
        missing.length === 0, 'missing: ' + missing.join(', '));
    } catch (e) {
      warn('poppler PDF inspection skipped', e.message.split('\n')[0]);
    }
    ok('pdf at ' + path.relative(ROOT, pdfPath));

    /* The same export under the Modern template. print.css only re-asserts
     * `overflow` on .paper-flow, so Modern's flex flow and multi-column
     * announcements have to survive the print path untouched — and the
     * calendar has to stay landscape even though the template changed. */
    section('PDF export — Modern template');
    await page.evaluate(async () => {
      window.Keys.App.chooseTemplate('modern');
      await new Promise(r => setTimeout(r, 700));
      window.Keys.Fit.refitAll({ force: true });
      await new Promise(r => setTimeout(r, 400));
    });
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(500);
    const modernPdf = path.join(OUT, 'keys-modern.pdf');
    await page.pdf({ path: modernPdf, printBackground: true, preferCSSPageSize: true });
    check('Modern PDF written', fs.statSync(modernPdf).size > 5000,
      fs.statSync(modernPdf).size + ' bytes');
    await page.emulateMedia({ media: 'screen' });

    try {
      const { execFileSync } = require('child_process');
      const info = execFileSync('/opt/homebrew/bin/pdfinfo', [modernPdf], { encoding: 'utf8' });
      const pages = Number((info.match(/^Pages:\s+(\d+)/m) || [])[1]);
      check('Modern PDF sheet count matches the issue', pages === expectedSheets,
        'got ' + pages + ', expected ' + expectedSheets);

      const sizes = [];
      for (let n = 1; n <= Math.max(pages, 0); n++) {
        const one = execFileSync('/opt/homebrew/bin/pdfinfo',
          ['-f', String(n), '-l', String(n), modernPdf], { encoding: 'utf8' });
        const m = one.match(/Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/);
        if (m) sizes.push([Math.round(+m[1]), Math.round(+m[2])]);
      }
      const near = (a, b) => Math.abs(a - b) <= 3;
      const geomOk = sizes.every((s, i) => i === sizes.length - 1
        ? (near(s[0], 792) && near(s[1], 612))
        : (near(s[0], 612) && near(s[1], 792)));
      check('Modern keeps portrait sheets and a landscape calendar',
        geomOk, sizes.map(s => s.join('x')).join(', '));

      const txt = execFileSync('/opt/homebrew/bin/pdftotext',
        [modernPdf, '-'], { encoding: 'utf8' }).toUpperCase();
      // Modern-only regions, the shared sheets, and the running foot numbers.
      const markers = ["ST. PETER'S KEYS", 'NEW KEYS', 'BIBLE INSPO',
        'CONTACT US', 'discoverstpeters.org', 'THIS WEEK', 'FIELD DAY',
        'Total Enclosed', 'Sunday', 'JUNE 2026'];
      const missing = markers.filter(m => !txt.includes(m.toUpperCase()));
      check('the Modern PDF carries its own regions and the shared sheets',
        missing.length === 0, 'missing: ' + missing.join(', '));
      // Contemporary-only text must not be printed under Modern.
      check('the Modern PDF omits the Contemporary-only motto and verse',
        !txt.includes('PRAY AND BELIEVE') && !txt.includes('PHILIPPIANS 1:6'),
        'motto/verse leaked into the Modern export');
    } catch (e) {
      warn('poppler Modern PDF inspection skipped', e.message.split('\n')[0]);
    }
    ok('modern pdf at ' + path.relative(ROOT, modernPdf));
  }

  await browser.close();
  /* Belt and braces: each served section stops its own server, but a run that
   * bailed out early may have left one. Only ever the processes this file
   * spawned — nothing else on the machine is signalled. */
  await stopAllServers();

  /* --------------------------------------------------------------- report-- */
  console.log('\n' + '─'.repeat(64));
  console.log(`\x1b[1m${pass} passed\x1b[0m` +
    (failures.length ? `, \x1b[31m${failures.length} failed\x1b[0m` : '') +
    (warnings.length ? `, \x1b[33m${warnings.length} warning(s)\x1b[0m` : ''));
  if (failures.length) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    failures.forEach(f => console.log(`  • ${f.name}${f.detail ? '\n    ' + f.detail : ''}`));
  }
  if (warnings.length) {
    console.log('\n\x1b[33mWarnings:\x1b[0m');
    warnings.forEach(w => console.log(`  • ${w.name}${w.detail ? ' — ' + w.detail : ''}`));
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch(async e => {
  console.error(e);
  await stopAllServers().catch(() => {});
  process.exit(2);
});
