/* =============================================================================
 * calendar.js — Page 4: the monthly calendar.
 *
 * Exposes window.Keys.Calendar. Depends on nothing at load time (it may call
 * Keys.State only from inside functions, and in fact does not need to — the
 * `cal` object is always passed in by the caller).
 *
 * Public API (see docs/SPEC.md section 6):
 *     Keys.Calendar.MONTHS                    ['January' … 'December']
 *     Keys.Calendar.DAY_NAMES                 ['Sunday' … 'Saturday']
 *     Keys.Calendar.monthMatrix(year, month)  month is 0-indexed
 *     Keys.Calendar.previewHTML(cal)          innerHTML for page 4 .paper-flow
 *     Keys.Calendar.editorHTML(cal)           innerHTML for editor page-4 section
 *
 * Date handling rules (load-bearing):
 *   - Dates are ALWAYS built with `new Date(year, month, day)` (local time) and
 *     ISO strings are formatted BY HAND with zero padding. `toISOString()` is
 *     never used: it converts to UTC and shifts the calendar by a day for every
 *     negative-offset timezone (i.e. all of the Americas).
 *   - Weeks run Sunday (leftmost) → Saturday (rightmost).
 *   - Only the weeks the month actually needs are emitted (4, 5 or 6) — never a
 *     hardcoded 6.
 *   - Day events are keyed by ABSOLUTE ISO date (`calendar.days.2026-06-05`), so
 *     switching month and switching back never loses content.
 * ========================================================================== */
(function (global) {
  'use strict';

  var Keys = global.Keys = global.Keys || {};

  var MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  var DAY_NAMES = [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
  ];

  /* Per-cell fit bounds in px (Tier 1 — see SPEC section 4).
   *
   * MAX is a CEILING, not a target: it must match the size paper.css gives
   * .cal-cell (.715em of 14px = 10px = 7.5pt, the reference event-text size).
   * A lower ceiling makes the fit pass shrink every cell, including the ones
   * that already fit, and the whole calendar prints too small. */
  var CELL_FIT_MAX = '10';
  var CELL_FIT_MIN = '4';

  /* Year dropdown span, relative to the current year. */
  var YEAR_BACK = 2;
  var YEAR_FWD = 5;

  /* ---------------------------------------------------------------------------
   * Small helpers
   * ------------------------------------------------------------------------ */

  /** Escape a value destined for an HTML *attribute*. Element content is
   *  intentionally interpolated raw (it is user-authored rich HTML), but
   *  anything landing inside title="…" / aria-label="…" must be escaped. */
  function escAttr(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Strip tags/entities from a rich-text value so it can be used as a label
   *  or attribute (e.g. the accessible name of the header block). */
  function plain(html) {
    return String(html == null ? '' : html)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&mdash;/gi, '—')
      .replace(/&ndash;/gi, '–')
      .replace(/&rsquo;/gi, '’')
      .replace(/&lsquo;/gi, '‘')
      .replace(/&rdquo;/gi, '”')
      .replace(/&ldquo;/gi, '“')
      .replace(/&hellip;/gi, '…')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** Zero-padded 4+ digit year (years < 1000 still produce a sortable key). */
  function padYear(y) {
    var neg = y < 0;
    var s = String(Math.abs(y));
    while (s.length < 4) s = '0' + s;
    return (neg ? '-' : '') + s;
  }

  /** Build a local Date safely, including years 0–99 (which the Date(y, m, d)
   *  constructor would otherwise map into 1900–1999). */
  function localDate(year, month, day) {
    var d = new Date(year, month, day);
    if (year >= 0 && year <= 99) d.setFullYear(year, month, day);
    return d;
  }

  /** 'YYYY-MM-DD' from local date parts — never via toISOString(). */
  function isoFromParts(year, month, day) {
    return padYear(year) + '-' + pad2(month + 1) + '-' + pad2(day);
  }

  /** ISO key for the given y/m/d, normalising any month/day overflow through
   *  the local Date constructor (so month 12 rolls into January of y+1). */
  function isoFor(year, month, day) {
    var d = localDate(year, month, day);
    return isoFromParts(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /** Day count of a month. `new Date(y, m + 1, 0)` is the last day of month m,
   *  which is leap-year correct by construction. */
  function daysInMonth(year, month) {
    return localDate(year, month + 1, 0).getDate();
  }

  function toInt(value, fallback) {
    var n = Number(value);
    return (typeof n === 'number' && isFinite(n)) ? Math.trunc(n) : fallback;
  }

  /** Coerce a possibly-stringy, possibly-missing calendar block into usable
   *  numbers. A `<select>` always hands back strings, and a hand-edited save
   *  file may contain anything at all. */
  function normalize(cal) {
    var now = new Date();
    var src = cal || {};
    var year = toInt(src.year, now.getFullYear());
    var month = toInt(src.month, now.getMonth());

    /* Roll an out-of-range month into the neighbouring year rather than
     * throwing it away. */
    if (month < 0 || month > 11) {
      var d = localDate(year, month, 1);
      year = d.getFullYear();
      month = d.getMonth();
    }

    return {
      year: year,
      month: month,
      schoolName: src.schoolName == null ? '' : src.schoolName,
      website: src.website == null ? '' : src.website,
      contact: src.contact == null ? '' : src.contact,
      days: (src.days && typeof src.days === 'object') ? src.days : {}
    };
  }

  function emptyCell() {
    return { iso: null, day: null, inMonth: false };
  }

  /* ---------------------------------------------------------------------------
   * monthMatrix — the correctness core
   *
   * Returns an array of week arrays. Every week has exactly 7 cells, index 0 =
   * Sunday … index 6 = Saturday. Cells before the 1st and after the last day of
   * the month are { iso: null, day: null, inMonth: false }.
   *
   * The number of weeks is whatever the month needs:
   *     ceil((startDayOfWeek + daysInMonth) / 7)   →  4, 5 or 6
   * e.g. Feb 2026 (Sun start, 28 days) = 4 rows;
   *      a 31-day month starting Friday = 6 rows.
   * ------------------------------------------------------------------------ */
  function monthMatrix(year, month) {
    var now = new Date();
    var y = toInt(year, now.getFullYear());
    var m = toInt(month, now.getMonth());

    /* Normalise the (y, m) pair — handles m < 0 / m > 11 and 2-digit years. */
    var first = localDate(y, m, 1);
    y = first.getFullYear();
    m = first.getMonth();

    var startDow = first.getDay();          /* 0 = Sunday … 6 = Saturday */
    var total = daysInMonth(y, m);

    var weeks = [];
    var week = [];
    var i;

    for (i = 0; i < startDow; i++) week.push(emptyCell());

    for (var day = 1; day <= total; day++) {
      week.push({ iso: isoFromParts(y, m, day), day: day, inMonth: true });
      if (week.length === 7) {
        weeks.push(week);
        week = [];
      }
    }

    if (week.length > 0) {
      while (week.length < 7) week.push(emptyCell());
      weeks.push(week);
    }

    return weeks;
  }

  /** Flat list of in-month cells, in date order (used by the editor). */
  function monthDays(year, month) {
    var out = [];
    monthMatrix(year, month).forEach(function (week) {
      week.forEach(function (cell, dow) {
        if (cell.inMonth) out.push({ iso: cell.iso, day: cell.day, dow: dow });
      });
    });
    return out;
  }

  /** 'JUNE 2026' — derived from cal.month / cal.year, never separately edited. */
  function monthTitle(cal) {
    var c = normalize(cal);
    return (MONTHS[c.month] + ' ' + c.year).toUpperCase();
  }

  /* ---------------------------------------------------------------------------
   * Logo mark — inline SVG cross-in-heart placeholder.
   * No external image files, no network requests (SPEC section 0).
   * ------------------------------------------------------------------------ */
  function logoSVG() {
    return '' +
      '<svg class="cal-logo-svg" viewBox="0 0 100 92" role="img" ' +
      'aria-label="St. Peter\'s cross and heart mark" focusable="false">' +
      '<defs>' +
      '<radialGradient id="calHeartFill" cx="38%" cy="30%" r="78%">' +
      '<stop offset="0%" stop-color="#f4b8c4"/>' +
      '<stop offset="45%" stop-color="#c21f3c"/>' +
      '<stop offset="100%" stop-color="#6d0f20"/>' +
      '</radialGradient>' +
      '</defs>' +
      '<path class="cal-logo-heart" fill="url(#calHeartFill)" stroke="#5c0a18" ' +
      'stroke-width="2" d="M50 88 C22 68 6 51 6 32 C6 17 17 6 31 6 C40 6 46 11 ' +
      '50 18 C54 11 60 6 69 6 C83 6 94 17 94 32 C94 51 78 68 50 88 Z"/>' +
      '<path class="cal-logo-cross" fill="#ffffff" stroke="#5c0a18" ' +
      'stroke-width="1.5" d="M43 16 H57 V33 H76 V47 H57 V78 H43 V47 H24 V33 ' +
      'H43 Z"/>' +
      '</svg>';
  }

  /* ---------------------------------------------------------------------------
   * previewHTML — innerHTML for page 4's .paper-flow
   * ------------------------------------------------------------------------ */
  function previewHTML(cal) {
    var c = normalize(cal);
    var weeks = monthMatrix(c.year, c.month);
    var title = monthTitle(c);
    var html = [];

    html.push('<div class="cal-sheet">');

    /* --- Header band: logo | ruled title box | contact block ------------- */
    html.push('<header class="cal-head">');

    html.push('<div class="cal-logo">' + logoSVG() + '</div>');

    html.push('<div class="cal-titlebox">');
    /* The title is DERIVED from month + year, so it has no data-bind and is
     * not directly editable. data-edits tells app.js's click-to-edit which
     * field to jump to instead — the month dropdown, which sits beside the
     * year dropdown in the editor. See SPEC section 2. */
    html.push(
      '<div class="cal-month" data-edits="calendar.month"' +
      ' title="Click to change the month and year"' +
      ' aria-label="' + escAttr(title) + '">' +
      escAttr(title) + '</div>'
    );
    html.push('<div class="cal-ident">');
    html.push(
      '<div class="cal-schoolname rt-out" data-bind="calendar.schoolName">' +
      c.schoolName + '</div>'
    );
    html.push(
      '<div class="cal-website rt-out" data-bind="calendar.website">' +
      c.website + '</div>'
    );
    html.push('</div>');   /* .cal-ident */
    html.push('</div>');   /* .cal-titlebox */

    html.push(
      '<div class="cal-contact rt-out" data-bind="calendar.contact">' +
      c.contact + '</div>'
    );

    html.push('</header>');

    /* --- Ruled 7-column grid -------------------------------------------- */
    html.push(
      '<div class="cal-grid" data-weeks="' + weeks.length + '" ' +
      'role="table" aria-label="' + escAttr(title + ' calendar') + '">'
    );

    html.push('<div class="cal-dayrow" role="row">');
    for (var i = 0; i < 7; i++) {
      html.push(
        '<div class="cal-dayname" role="columnheader">' + DAY_NAMES[i] + '</div>'
      );
    }
    html.push('</div>');

    weeks.forEach(function (week) {
      html.push('<div class="cal-week" role="row">');
      week.forEach(function (cell, dow) {
        html.push(cellHTML(cell, dow, c));
      });
      html.push('</div>');
    });

    html.push('</div>');   /* .cal-grid */
    html.push('</div>');   /* .cal-sheet */

    return html.join('');
  }

  /* Every .cal-cell — in-month or not — carries Tier-1 fit treatment so long
   * event text can never overflow the ruled box. The day number lives inside
   * .fit-inner too, so number + events scale together. */
  function cellHTML(cell, dow, c) {
    var fitAttrs =
      ' data-fit data-fit-max="' + CELL_FIT_MAX +
      '" data-fit-min="' + CELL_FIT_MIN + '"';

    if (!cell.inMonth) {
      return '' +
        '<div class="cal-cell cal-cell--blank fit"' + fitAttrs +
        ' role="cell" aria-hidden="true">' +
        '<div class="fit-inner"></div>' +
        '</div>';
    }

    var label = DAY_NAMES[dow] + ', ' + MONTHS[c.month] + ' ' + cell.day +
      ', ' + c.year;
    var events = c.days[cell.iso];
    if (events == null) events = '';

    return '' +
      '<div class="cal-cell fit"' + fitAttrs + ' role="cell"' +
      ' data-iso="' + escAttr(cell.iso) + '"' +
      ' data-dow="' + dow + '"' +
      ' title="' + escAttr(label) + '">' +
      '<div class="fit-inner">' +
      '<div class="cal-daynum">' + cell.day + '</div>' +
      '<div class="cal-events rt-out" data-bind="calendar.days.' +
      escAttr(cell.iso) + '">' + events + '</div>' +
      '</div>' +
      '</div>';
  }

  /* ---------------------------------------------------------------------------
   * editorHTML — innerHTML for the editor's page-4 section
   *
   * Month/year are plain <select class="pt"> controls; changing either is a
   * STRUCTURAL change (the integrator routes it through
   * Keys.App.structuralChange). Day fields are keyed by absolute ISO date, so a
   * month round-trip preserves every event.
   * ------------------------------------------------------------------------ */
  function editorHTML(cal) {
    var c = normalize(cal);
    var html = [];

    html.push('<div class="cal-ed">');

    /* --- Month / year ---------------------------------------------------- */
    html.push('<div class="cal-ed-periods">');

    html.push('<div class="cal-ed-field cal-ed-field--month">');
    html.push('<label class="cal-ed-label" for="cal-ed-month">Month</label>');
    html.push(
      '<select class="pt" id="cal-ed-month" data-path="calendar.month" ' +
      'data-page="4" aria-label="Calendar month">'
    );
    MONTHS.forEach(function (name, index) {
      html.push(
        '<option value="' + index + '"' +
        (index === c.month ? ' selected' : '') + '>' + name + '</option>'
      );
    });
    html.push('</select>');
    html.push('</div>');

    html.push('<div class="cal-ed-field cal-ed-field--year">');
    html.push('<label class="cal-ed-label" for="cal-ed-year">Year</label>');
    html.push(
      '<select class="pt" id="cal-ed-year" data-path="calendar.year" ' +
      'data-page="4" aria-label="Calendar year">'
    );
    yearOptions(c.year).forEach(function (y) {
      html.push(
        '<option value="' + y + '"' +
        (y === c.year ? ' selected' : '') + '>' + y + '</option>'
      );
    });
    html.push('</select>');
    html.push('</div>');

    html.push('</div>');   /* .cal-ed-periods */

    html.push(
      '<p class="cal-ed-note">Heading reads <strong>' +
      escAttr(monthTitle(c)) + '</strong> &mdash; it follows the month and year ' +
      'above. Events are stored by date, so switching months and back keeps ' +
      'everything.</p>'
    );

    /* --- Header text fields ---------------------------------------------- */
    html.push('<div class="cal-ed-group">');
    html.push('<div class="cal-ed-grouptitle">Calendar header</div>');
    html.push(rtField('calendar.schoolName', 'School name', c.schoolName, true));
    html.push(rtField('calendar.website', 'Website', c.website, true));
    html.push(rtField('calendar.contact', 'Contact block', c.contact, false));
    html.push('</div>');

    /* --- One rich-text field per in-month day ---------------------------- */
    var days = monthDays(c.year, c.month);

    html.push('<div class="cal-ed-group cal-ed-group--days">');
    html.push(
      '<div class="cal-ed-grouptitle">' +
      escAttr(MONTHS[c.month] + ' ' + c.year) + ' events</div>'
    );
    html.push('<div class="cal-ed-days">');

    days.forEach(function (d) {
      var shortName = DAY_NAMES[d.dow].slice(0, 3);
      var shortLabel = shortName + ' ' + d.day;
      var fullLabel = DAY_NAMES[d.dow] + ', ' + MONTHS[c.month] + ' ' +
        d.day + ', ' + c.year;
      var value = c.days[d.iso];
      if (value == null) value = '';

      html.push('<div class="cal-ed-day" data-iso="' + escAttr(d.iso) + '">');
      html.push(
        '<div class="cal-ed-daylabel" title="' + escAttr(fullLabel) + '">' +
        '<span class="cal-ed-dayname">' + escAttr(shortName) + '</span>' +
        '<span class="cal-ed-daynum">' + d.day + '</span>' +
        '</div>'
      );
      html.push(
        '<div class="rt cal-ed-dayfield" contenteditable="true" ' +
        'data-path="calendar.days.' + escAttr(d.iso) + '" data-page="4" ' +
        'aria-label="' + escAttr(fullLabel + ' events') + '" ' +
        'data-placeholder="' + escAttr(shortLabel) + '">' + value + '</div>'
      );
      html.push('</div>');
    });

    html.push('</div>');   /* .cal-ed-days */
    html.push('</div>');   /* .cal-ed-group--days */

    html.push('</div>');   /* .cal-ed */

    return html.join('');
  }

  /** currentYear-2 … currentYear+5, plus cal.year itself when it falls outside
   *  that window, so loading an old (or far-future) file never drops its year. */
  function yearOptions(year) {
    var current = new Date().getFullYear();
    var years = [];
    for (var y = current - YEAR_BACK; y <= current + YEAR_FWD; y++) years.push(y);
    if (years.indexOf(year) === -1) {
      years.push(year);
      years.sort(function (a, b) { return a - b; });
    }
    return years;
  }

  /** A labelled rich-text editor field bound to `path`. */
  function rtField(path, label, value, single) {
    return '' +
      '<div class="cal-ed-field">' +
      '<label class="cal-ed-label" for="cal-ed-' + escAttr(path) + '">' +
      escAttr(label) + '</label>' +
      '<div class="rt cal-ed-rt" id="cal-ed-' + escAttr(path) + '" ' +
      'contenteditable="true" data-path="' + escAttr(path) + '" data-page="4"' +
      (single ? ' data-single="true"' : '') +
      ' aria-label="' + escAttr(label) + '">' + (value == null ? '' : value) +
      '</div>' +
      '</div>';
  }

  /* ---------------------------------------------------------------------------
   * Export
   * ------------------------------------------------------------------------ */
  Keys.Calendar = {
    MONTHS: MONTHS,
    DAY_NAMES: DAY_NAMES,

    monthMatrix: monthMatrix,
    previewHTML: previewHTML,
    editorHTML: editorHTML,

    /* Supporting helpers — handy for render.js / editor.js and the verifier. */
    monthDays: monthDays,
    monthTitle: monthTitle,
    daysInMonth: daysInMonth,
    isoFor: isoFor,
    yearOptions: yearOptions,
    normalize: normalize,
    escAttr: escAttr
  };
})(window);
