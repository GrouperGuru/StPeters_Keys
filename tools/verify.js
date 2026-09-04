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
    thumbs: document.querySelectorAll('#thumb-rail .thumb').length,
    landscape: document.querySelectorAll('#page-stage .paper[data-orientation="landscape"]').length
  }));
  check('4 pages rendered', counts.papers === 4, 'got ' + counts.papers);
  check('4 editor sections', counts.sections === 4, 'got ' + counts.sections);
  check('page 4 is landscape', counts.landscape === 1, 'got ' + counts.landscape);
  check('thumbnail rail built', counts.thumbs === 4, 'got ' + counts.thumbs);
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
    const LOREM = ('The quick brown fox jumped over the lazy dog and kept ' +
      'running all the way to the end of the very long sentence. ').repeat(${mult});
    const LONGWORD = ${withLongWord} ? ('Unbreakable' + 'x'.repeat(180)) : '';
    const join = (a, b) => b ? (a + '<br>' + b) : a;

    S.doc.thisWeek.rows.forEach(r => { r.date = '99/99'; r.event = join(LOREM, LONGWORD); });
    S.doc.lookingAhead.rows.forEach(r => { r.event = LOREM; });
    if (LONGWORD) S.doc.lookingAhead.note = LONGWORD;
    S.doc.masthead.title = 'ST. PETER\\u2019S KEYS' + (LONGWORD ? ' ' + LONGWORD : '');
    S.doc.masthead.schoolInfo = LOREM;
    S.doc.classroom.verse = LOREM;
    S.doc.classroom.body = '<p>' + LOREM + LOREM + '</p>' +
      (LONGWORD ? '<p>' + LONGWORD + '</p>' : '');
    S.doc.articles.page1.forEach(a => { a.body = '<p>' + LOREM + LOREM + '</p>'; });
    S.doc.articles.page2.forEach(a => { a.body = '<p>' + LOREM + LOREM + '</p>'; });
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

  async function flood(mult, withLongWord) {
    await page.evaluate(() => window.Keys.App.structuralChange(function () {
      window.Keys.State.replace(window.Keys.State.defaultDoc());
    }));
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
    const dow = Array.from(document.querySelectorAll('#page-stage .paper[data-page="4"] .cal-dayname'))
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
    const titleFeb = document.querySelector('#page-stage .paper[data-page="4"] .cal-month');
    const sel2 = document.querySelector('#editor-scroll .pt[data-path="calendar.month"]');
    sel2.value = '5';
    sel2.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const after = window.Keys.State.get('calendar.days.2026-06-05');
    const titleJun = document.querySelector('#page-stage .paper[data-page="4"] .cal-month');
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
    const nBoxes = () => document.querySelectorAll('#page-stage .paper[data-page="3"] .slip').length;
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

    const cols = Array.from(document.querySelectorAll('#page-stage .paper[data-page="3"] .slip-col'))
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
      '#page-stage .paper[data-page="3"] .slip-namerow').length;
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
      '#page-stage .paper[data-page="3"] .slip--afterschool');
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
      '#page-stage .paper[data-page="3"] .slip--afterschool .slip-as-days')[0]
      .querySelectorAll('.slip-as-daycell')]
      .map(td => td.classList.contains('slip-as-daycell--xxx') ? 'xxx' : 'blank');

    // Every sign-up line must agree — closure is a property of the week.
    const allGrids = [...document.querySelectorAll(
      '#page-stage .paper[data-page="3"] .slip--afterschool .slip-as-days')]
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
      '#page-stage .paper[data-page="3"] .slip--afterschool .slip-as-days').length;
    const termRows = () => document.querySelectorAll(
      '#page-stage .paper[data-page="3"] .slip--afterschool .slip-as-terms tr').length;

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
      '#page-stage .paper[data-page="3"] .slip--afterschool').length;
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
        '#page-stage .paper[data-page="3"] .slip--afterschool').length,
      grids0: document.querySelectorAll(
        '#page-stage .paper[data-page="3"] .slip--afterschool')[0]
        .querySelectorAll('.slip-as-days').length,
      grids1: document.querySelectorAll(
        '#page-stage .paper[data-page="3"] .slip--afterschool')[1]
        .querySelectorAll('.slip-as-days').length
    };
  });
  check('malformed After School data renders without throwing',
    as5.threw === null && as5.boxes === 2, 'threw=' + as5.threw);
  check('a negative sign-up count clamps to none, a huge one is capped',
    as5.grids0 === 0 && as5.grids1 > 0 && as5.grids1 <= 12,
    `grids ${as5.grids0} / ${as5.grids1}`);

  await resetDoc();

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
  await selectAllIn('articles.page2.0.body', 'page2');
  const fontSize = await page.evaluate(async () => {
    const wait = () => new Promise(r => setTimeout(r, 320));
    const dd = document.querySelector('#format-group .tb-select[data-fmt="fontSize"]');
    dd.value = '7';
    dd.dispatchEvent(new Event('change', { bubbles: true }));
    await wait();
    window.Keys.Fit.refitAll({ force: true });
    await wait();
    const stored = String(window.Keys.State.get('articles.page2.0.body'));
    return {
      hasFontTag: /<font[\s>]/i.test(stored),
      hasEm: /font-size:\s*[\d.]+em/i.test(stored),
      measure: window.Keys.Fit.measure(
        document.querySelector('#page-stage .paper[data-page="2"]'))
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
    '#page-stage .paper[data-page="4"] .cal-cell[data-iso="2026-06-15"]',
    { yFrac: 0.88 });
  check('clicking the blank part of a calendar day focuses that day',
    c3.focusedPath === 'calendar.days.2026-06-15',
    'focused ' + c3.focusedPath);
  check('the calendar jump opens the page-4 section',
    c3.sectionKey === 'page4' && c3.sectionOpen === true,
    `section=${c3.sectionKey} open=${c3.sectionOpen}`);

  // A slip's padding, not its text.
  const c4 = await clickPreview(
    '#page-stage .paper[data-page="3"] .slip[data-slip-id="slip-pizza"]',
    { yFrac: 0.03 });
  check('clicking a slip box focuses one of its fields',
    typeof c4.focusedPath === 'string' && /^slips\.\d+\./.test(c4.focusedPath),
    'focused ' + c4.focusedPath);
  check('the slip jump opens the page-3 section', c4.sectionKey === 'page3',
    'section=' + c4.sectionKey);

  const c5 = await clickPreview(
    '#page-stage .paper[data-page="2"] [data-bind="articles.page2.1.title"]');
  check('clicking a page-2 heading focuses that heading',
    c5.focusedPath === 'articles.page2.1.title', 'focused ' + c5.focusedPath);
  check('the jump leaves the preview on the page that was clicked',
    c5.page === 2, 'on page ' + c5.page);

  // The calendar's month/year title is DERIVED, so it has no data-bind. It
  // must still jump to the month dropdown rather than to a neighbouring field.
  const c8 = await clickPreview('#page-stage .paper[data-page="4"] .cal-month');
  check('clicking the calendar month/year opens the month dropdown',
    c8.focusedPath === 'calendar.month', 'focused ' + c8.focusedPath);
  check('that jump opens the calendar section', c8.sectionKey === 'page4' &&
    c8.sectionOpen === true, `section=${c8.sectionKey} open=${c8.sectionOpen}`);

  const c8b = await page.evaluate(() => {
    const title = document.querySelector('#page-stage .paper[data-page="4"] .cal-month');
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
    const t = document.querySelector('#page-stage .paper[data-page="4"] .cal-month');
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
    '#page-stage .paper[data-page="4"] [data-bind="calendar.schoolName"]');
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
    thumbs: document.querySelectorAll('#thumb-rail .thumb').length,
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
      check('PDF has exactly 4 sheets', pages === 4, 'got ' + pages);

      const sizes = [];
      for (let n = 1; n <= Math.max(pages, 0); n++) {
        const one = execFileSync('/opt/homebrew/bin/pdfinfo',
          ['-f', String(n), '-l', String(n), pdfPath], { encoding: 'utf8' });
        const m = one.match(/Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/);
        if (m) sizes.push([Math.round(+m[1]), Math.round(+m[2])]);
      }
      const near = (a, b) => Math.abs(a - b) <= 3;
      sizes.forEach((s, i) => {
        const wantLandscape = i === 3;
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
  }

  await browser.close();

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

main().catch(e => { console.error(e); process.exit(2); });
