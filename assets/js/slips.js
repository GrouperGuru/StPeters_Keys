/* =============================================================================
 * slips.js — Page 3: lunch order slips & sign-up boxes.
 *
 * Exposes window.Keys.Slips. Depends on Keys.State only for `uid()`, and only
 * from inside functions (never at load time).
 *
 * Page 3 is an ORDER-SENSITIVE list of bordered boxes laid out in two columns.
 * Each box is one entry in `Keys.State.doc.slips`; the `column` property picks
 * the column and array order decides the stacking order within it.
 *
 * Three box types (see docs/SPEC.md section 7):
 *   'lunch'      heading + optional Name/Gr rule row + option lines + total +
 *                footer. The standard tear-off order slip.
 *   'custom'     heading + free-form rich HTML body (e.g. After School sign up).
 *   'starburst'  inline-SVG burst with centred bold text.
 *
 * All user text is an HTML string and is interpolated into element BODIES
 * verbatim (that is the whole point — the editor writes inline markup). Anything
 * that lands in an HTML ATTRIBUTE goes through escAttr(); anything machine-
 * generated that must read as literal text goes through escText(). A loaded
 * JSON file is untrusted input, so ids/types/kinds are always escaped.
 * ========================================================================== */
(function (global) {
  'use strict';

  var Keys = global.Keys = global.Keys || {};

  /* ---------------------------------------------------------------------------
   * Type + field metadata
   * ------------------------------------------------------------------------ */

  /** Box types, in the order the editor toolbar offers them. */
  var TYPES = {
    lunch:       { label: 'Lunch Slip',            icon: '✂' },  /* scissors  */
    afterschool: { label: 'After School Sign Up',  icon: '🕒' }, /* clock     */
    custom:      { label: 'Custom Box',            icon: '▭' },  /* rectangle */
    starburst:   { label: 'Starburst',             icon: '✹' }   /* burst     */
  };

  var TYPE_ORDER = ['lunch', 'afterschool', 'custom', 'starburst'];

  /* --- After School Sign Up ------------------------------------------------
   * The weekly hours grid. Each weekday is either a blank rule to write hours
   * on, or XXX for a day with no after-school care (a holiday or a half day).
   * The author picks per day from a dropdown rather than typing underscores
   * and spaces into a free-text box and hand-aligning the columns.
   * Values are load-bearing (stored in the save file). */
  var DAY_STATES = ['blank', 'xxx'];

  /* Kept short on purpose: these sit in a ~84px column of the weekday grid, so
   * a longer label is simply truncated to something cryptic. The full meaning
   * is spelled out in the hint under the grid and in each select's aria-label. */
  var DAY_STATE_LABELS = {
    blank: 'Blank line',
    xxx:   'XXX (closed)'
  };

  var DEFAULT_DAY_LABELS = ['Mon', 'Tues', 'Wed', 'Thurs', 'Fri'];

  /* Guard rails on the repeatable parts, so a hand-edited file cannot ask for
   * ten thousand sign-up lines. */
  var MAX_STUDENTS = 12;
  var MAX_DAYS = 7;

  /** Option-line kinds for `lunch` slips. Values are load-bearing (stored). */
  var FIELD_KINDS = ['blank-before', 'blank-after', 'text', 'inline'];

  var FIELD_KIND_LABELS = {
    'blank-before': 'Blank, then label',
    'blank-after':  'Label, then blank',
    'text':         'Plain text line',
    'inline':       'Inline choices (a | b | c)'
  };

  var DEFAULT_KIND = 'blank-before';

  /* Tier-1 fit bounds, used only when a slip opts into an explicit height. */
  var FIT_MAX = '11';
  var FIT_MIN = '5';

  /* ---------------------------------------------------------------------------
   * Escaping / coercion helpers
   * ------------------------------------------------------------------------ */

  /** For values placed inside an HTML attribute (ids, indices, titles, paths). */
  function escAttr(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** For machine-generated / untrusted strings shown as literal text. */
  function escText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** Rich HTML passthrough — normalises null/undefined to ''. */
  function html(value) {
    return value == null ? '' : String(value);
  }

  /** A loaded file may carry booleans as strings ("false", "0", ""). */
  function truthy(value) {
    if (typeof value === 'string') {
      var s = value.trim().toLowerCase();
      return !(s === '' || s === 'false' || s === '0' || s === 'no' || s === 'off');
    }
    return !!value;
  }

  function isArray(value) {
    return Object.prototype.toString.call(value) === '[object Array]';
  }

  function normalizeColumn(value) {
    return String(value == null ? '' : value).toLowerCase() === 'right'
      ? 'right' : 'left';
  }

  function normalizeType(value) {
    var t = String(value == null ? '' : value);
    return TYPES[t] ? t : null;
  }

  function normalizeKind(value) {
    var k = String(value == null ? '' : value);
    return FIELD_KINDS.indexOf(k) >= 0 ? k : 'text';
  }

  /** Slips tolerate a missing/malformed `fields` array. */
  function fieldsOf(slip) {
    return isArray(slip && slip.fields) ? slip.fields : [];
  }

  /* --- After School accessors ----------------------------------------------
   * Every one of these is total: a loaded file can carry anything, and a
   * render pass must never throw. They are the reason the renderer below has
   * no shape checks of its own. */

  function termsOf(slip) {
    var list = isArray(slip && slip.terms) ? slip.terms : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && typeof list[i] === 'object' && !isArray(list[i])) {
        out.push(list[i]);
      }
    }
    return out;
  }

  /** Day column headings, always exactly as long as the day-state array. */
  function dayLabelsOf(slip) {
    var raw = isArray(slip && slip.dayLabels) ? slip.dayLabels : null;
    var n = dayCountOf(slip);
    var out = [];
    for (var i = 0; i < n; i++) {
      var v = raw && raw[i] != null ? String(raw[i]) : null;
      out.push(v != null ? v : (DEFAULT_DAY_LABELS[i] || ''));
    }
    return out;
  }

  function dayCountOf(slip) {
    var days = isArray(slip && slip.days) ? slip.days : null;
    var labels = isArray(slip && slip.dayLabels) ? slip.dayLabels : null;
    var n = days ? days.length : (labels ? labels.length : DEFAULT_DAY_LABELS.length);
    if (!isFinite(n) || n < 1) n = DEFAULT_DAY_LABELS.length;
    return Math.min(Math.floor(n), MAX_DAYS);
  }

  /** Per-day state, normalised to a known value. */
  function daysOf(slip) {
    var raw = isArray(slip && slip.days) ? slip.days : null;
    var n = dayCountOf(slip);
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(normalizeDayState(raw ? raw[i] : null));
    }
    return out;
  }

  function normalizeDayState(value) {
    var s = value == null ? '' : String(value).trim().toLowerCase();
    return DAY_STATES.indexOf(s) === -1 ? 'blank' : s;
  }

  /** How many "Name + hours" sign-up blocks to print. */
  function studentsOf(slip) {
    var n = Number(slip && slip.students);
    if (!isFinite(n)) n = 2;
    n = Math.floor(n);
    if (n < 0) n = 0;
    return Math.min(n, MAX_STUDENTS);
  }

  function uid() {
    var State = Keys.State;
    if (State && typeof State.uid === 'function') return State.uid('slip');
    /* Defensive only — state.js always loads first. */
    return 'slip-' + Date.now().toString(36) + '-' +
      Math.floor(Math.random() * 1e6).toString(36);
  }

  /* ---------------------------------------------------------------------------
   * blank(type) — a new slip with sensible placeholder content
   * ------------------------------------------------------------------------ */
  function blank(type) {
    var t = normalizeType(type) || 'custom';
    var slip = { id: uid(), type: t, column: 'left' };

    if (t === 'lunch') {
      slip.heading =
        'NEXT DAY, 0/00<br>FOR LUNCH<br>NEW ITEM<br>(Orders due Wednesday)';
      slip.nameRow = true;
      slip.fields = [{ kind: 'blank-before', label: 'Item @ $2.00' }];
      slip.total = true;
      slip.totalLabel = 'Total Enclosed';
      slip.footer =
        'Please provide exact change.<br>Proceeds to benefit<br>PTL';
    } else if (t === 'afterschool') {
      slip.heading =
        'AFTER SCHOOL SIGN UP<br>' +
        '<span class="slip-sub">*Week of 0/00</span><br>' +
        '<span class="slip-sub"><u>Due Thursday, 0/00</u></span>';
      slip.rates =
        '<i><u>Pre-Reg (per day)</u></i>&nbsp; 1 hour@ $5,<br>' +
        '2 hours@ $10,  3 hours @ $ 15';
      slip.notes = '<i>Family Reg for the year is $35.00.</i>';
      slip.terms = [
        { label: '<i>Emergency</i>', value: '(family not registered)<br>$7.00 per hour' },
        { label: 'Late Enrollees', value: 'add $1.00 per child per day after Thursday.' }
      ];
      slip.dayLabels = DEFAULT_DAY_LABELS.slice();
      slip.days = ['blank', 'blank', 'blank', 'blank', 'blank'];
      slip.students = 2;
      slip.total = true;
      slip.totalLabel = 'TOTAL ENCLOSED';
      slip.footer = '';
    } else if (t === 'starburst') {
      slip.text = 'IMPORTANT<br>REMINDER';
    } else {
      slip.heading = 'NEW SIGN UP<br><span class="slip-sub">*Details here</span>';
      slip.body = '<p>Add the details for this box here.</p>';
    }
    return slip;
  }

  /* ---------------------------------------------------------------------------
   * Star burst geometry
   *
   * A pure inline SVG polygon — no image files, no network. Inner vertices are
   * nudged around the circle (`skew`) so the spikes lean, which is what makes
   * the reference burst read as hand-drawn rather than as a clip-art gear.
   * preserveAspectRatio="none" lets the burst stretch to whatever box the
   * column gives it, matching the wide burst in docs/pg-3.png.
   * ------------------------------------------------------------------------ */
  function starPoints(spikes, outer, inner, skew) {
    var cx = 100, cy = 100, pts = [], i, r, ang;
    for (i = 0; i < spikes * 2; i++) {
      var isOuter = (i % 2) === 0;
      r = isOuter ? outer : inner;
      ang = (Math.PI * i) / spikes - Math.PI / 2 + (isOuter ? 0 : skew);
      pts.push(
        (Math.round((cx + r * Math.cos(ang)) * 100) / 100) + ',' +
        (Math.round((cy + r * Math.sin(ang)) * 100) / 100)
      );
    }
    return pts.join(' ');
  }

  var BURST_POINTS = starPoints(13, 98, 54, 0.075);

  function burstHTML(slip, path) {
    return '' +
      '<div class="slip-burst">' +
        '<svg class="slip-burst-svg" viewBox="0 0 200 200" ' +
             'preserveAspectRatio="none" aria-hidden="true" focusable="false">' +
          '<polygon class="slip-burst-star" points="' + escAttr(BURST_POINTS) + '"/>' +
        '</svg>' +
        '<div class="slip-burst-text rt-out" data-bind="' + escAttr(path) + '">' +
          html(slip.text) +
        '</div>' +
      '</div>';
  }

  /* ---------------------------------------------------------------------------
   * Preview fragments
   * ------------------------------------------------------------------------ */

  /** Name ____________________  Gr ____ — bordered spans, never underscores,
   *  so the rules print as clean hairlines at any zoom. */
  function nameRowHTML() {
    return '' +
      '<div class="slip-namerow">' +
        '<span class="slip-namerow-label">Name</span>' +
        '<span class="slip-rule slip-rule--grow"></span>' +
        '<span class="slip-namerow-label">Gr</span>' +
        '<span class="slip-rule slip-rule--sm"></span>' +
      '</div>';
  }

  /** Re-balance a fragment of HTML by round-tripping it through the parser.
   *
   *  Splitting on '|' cuts the raw string without regard for markup, so a
   *  format applied across a pipe ("<b>Ketchup | Mustard</b>") yields pieces
   *  with unclosed or orphaned tags. Feeding each piece back through the
   *  parser closes what is open and drops what is orphaned, so a stray tag can
   *  never leak into the following choice. */
  function balance(fragment) {
    if (fragment.indexOf('<') === -1) return fragment;
    if (typeof document === 'undefined') return fragment;
    try {
      var tpl = document.createElement('template');
      tpl.innerHTML = fragment;
      return tpl.innerHTML;
    } catch (e) {
      return fragment;
    }
  }

  /** Pipe-delimited label -> "____ Ketchup   ____ Mustard   ____ Relish".
   *  Exported so app.js can re-split the row after an inline label edit. */
  function inlineHTML(label) {
    var parts = html(label).split('|');
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      var piece = balance(parts[i])
                          .replace(/^(?:\s|&nbsp;|&#160;)+/, '')
                          .replace(/(?:\s|&nbsp;|&#160;)+$/, '');
      if (!piece) continue;
      out +=
        '<span class="slip-inline-item">' +
          '<span class="slip-rule slip-rule--sm"></span>' +
          '<span class="slip-inline-text">' + piece + '</span>' +
        '</span>';
    }
    if (!out) {
      out = '<span class="slip-inline-item">' +
              '<span class="slip-rule slip-rule--sm"></span>' +
            '</span>';
    }
    return out;
  }

  function fieldHTML(field, path) {
    var kind = normalizeKind(field && field.kind);
    var label = html(field && field.label);
    var bind = escAttr(path);
    var labelSpan = '<span class="slip-label rt-out" data-bind="' + bind + '">' +
      label + '</span>';

    if (kind === 'blank-before') {
      return '<div class="slip-field slip-field--blank-before">' +
        '<span class="slip-rule slip-rule--sm"></span>' + labelSpan + '</div>';
    }
    if (kind === 'blank-after') {
      return '<div class="slip-field slip-field--blank-after">' +
        labelSpan + '<span class="slip-rule slip-rule--sm"></span></div>';
    }
    if (kind === 'inline') {
      /* The binding contract writes the raw path value into [data-bind], so the
       * row itself carries the binding. data-slip-inline marks it so app.js can
       * re-run Keys.Slips.inlineHTML() after a live edit. */
      return '<div class="slip-field slip-field--inline rt-out" ' +
        'data-bind="' + bind + '" data-slip-inline="1">' +
        inlineHTML(label) + '</div>';
    }
    return '<div class="slip-field slip-field--text">' + labelSpan + '</div>';
  }

  function totalHTML(slip, path) {
    return '' +
      '<div class="slip-total">' +
        '<span class="slip-total-label rt-out" data-bind="' + escAttr(path) + '">' +
          html(slip.totalLabel) +
        '</span>' +
        '<span class="slip-rule slip-rule--md"></span>' +
      '</div>';
  }

  function lunchInnerHTML(slip, base) {
    var out = '';
    var fields = fieldsOf(slip);

    out += '<div class="slip-heading rt-out" data-bind="' +
      escAttr(base + '.heading') + '">' + html(slip.heading) + '</div>';

    if (truthy(slip.nameRow)) out += nameRowHTML();

    if (fields.length) {
      out += '<div class="slip-fields">';
      for (var j = 0; j < fields.length; j++) {
        out += fieldHTML(fields[j], base + '.fields.' + j + '.label');
      }
      out += '</div>';
    }

    if (truthy(slip.total)) out += totalHTML(slip, base + '.totalLabel');

    out += '<div class="slip-footer rt-out" data-bind="' +
      escAttr(base + '.footer') + '">' + html(slip.footer) + '</div>';

    return out;
  }

  /* ---------------------------------------------------------------------------
   * After School Sign Up
   *
   * The whole point of this type: the ruled lines, the weekday columns and the
   * XXX markers are GENERATED from structured data. The author picks each
   * day's state from a dropdown and never has to type underscores or pad with
   * spaces to line the columns up — the table does the alignment.
   * ------------------------------------------------------------------------ */

  /** One "Mon Tues Wed Thurs Fri" heading + hours row. */
  function dayGridHTML(slip, base) {
    var labels = dayLabelsOf(slip);
    var states = daysOf(slip);
    var head = '<tr class="slip-as-dayhead"><td class="slip-as-rowlabel"></td>';
    var row = '<tr class="slip-as-dayrow">' +
      '<td class="slip-as-rowlabel">Hrs.</td>';

    for (var i = 0; i < labels.length; i++) {
      head += '<td class="slip-as-dayname rt-out" data-bind="' +
        escAttr(base + '.dayLabels.' + i) + '">' + html(labels[i]) + '</td>';

      if (states[i] === 'xxx') {
        row += '<td class="slip-as-daycell slip-as-daycell--xxx">XXX</td>';
      } else {
        row += '<td class="slip-as-daycell">' +
          '<span class="slip-rule slip-rule--xs"></span></td>';
      }
    }
    return '<table class="slip-as-days"><tbody>' +
      head + '</tr>' + row + '</tr></tbody></table>';
  }

  function afterschoolInnerHTML(slip, base) {
    var out = '';

    out += '<div class="slip-heading rt-out" data-bind="' +
      escAttr(base + '.heading') + '">' + html(slip.heading) + '</div>';

    if (String(html(slip.rates)).trim()) {
      out += '<div class="slip-as-rates rt-out" data-bind="' +
        escAttr(base + '.rates') + '">' + html(slip.rates) + '</div>';
    }
    if (String(html(slip.notes)).trim()) {
      out += '<div class="slip-as-notes rt-out" data-bind="' +
        escAttr(base + '.notes') + '">' + html(slip.notes) + '</div>';
    }

    var terms = termsOf(slip);
    if (terms.length) {
      out += '<table class="slip-as-terms"><tbody>';
      for (var t = 0; t < terms.length; t++) {
        out += '<tr>' +
          '<td class="slip-as-term rt-out" data-bind="' +
            escAttr(base + '.terms.' + t + '.label') + '">' +
            html(terms[t].label) + '</td>' +
          '<td class="slip-as-termval rt-out" data-bind="' +
            escAttr(base + '.terms.' + t + '.value') + '">' +
            html(terms[t].value) + '</td>' +
          '</tr>';
      }
      out += '</tbody></table>';
    }

    var students = studentsOf(slip);
    for (var s = 0; s < students; s++) {
      out += '<div class="slip-as-student">' +
        '<div class="slip-namerow">' +
          '<span class="slip-namerow-label">Name</span>' +
          '<span class="slip-rule slip-rule--grow"></span>' +
        '</div>' +
        dayGridHTML(slip, base) +
        '</div>';
    }

    if (truthy(slip.total)) out += totalHTML(slip, base + '.totalLabel');

    if (String(html(slip.footer)).trim()) {
      out += '<div class="slip-footer rt-out" data-bind="' +
        escAttr(base + '.footer') + '">' + html(slip.footer) + '</div>';
    }
    return out;
  }

  function customInnerHTML(slip, base) {
    return '' +
      '<div class="slip-heading rt-out" data-bind="' +
        escAttr(base + '.heading') + '">' + html(slip.heading) + '</div>' +
      '<div class="slip-body rt-out" data-bind="' +
        escAttr(base + '.body') + '">' + html(slip.body) + '</div>';
  }

  /* Fit wrapper.
   *
   * SPEC 4 tier 1 compares fit-inner.scrollHeight against fit.clientHeight, so
   * it can only ever shrink a box with a DEFINITE height. Slips are stacked in
   * a column and size to their content, so clientHeight === scrollHeight and a
   * blanket [data-fit] would be a permanent no-op. Overflow protection for
   * page 3 therefore comes from tier 2 (.paper[data-fit-page] scaling
   * .paper-flow). A slip opts into tier 1 by setting a `height` string
   * ("3.2in", "260px"); only then do we emit [data-fit]. */
  var LENGTH_RE = /^\d+(?:\.\d+)?(?:in|cm|mm|px|pt|pc|em|rem|vh)$/;

  /** A `height` from a loaded file must never become arbitrary CSS (a
   *  background:url() there would be a network request). Only a bare CSS
   *  length passes; a bare number is read as inches. */
  function safeHeight(value) {
    if (value == null) return '';
    var s = String(value).trim().toLowerCase();
    if (s === '') return '';
    if (/^\d+(?:\.\d+)?$/.test(s)) s += 'in';
    return LENGTH_RE.test(s) ? s : '';
  }

  function openFit(slip) {
    var h = safeHeight(slip && slip.height);
    if (h) {
      return '<div class="slip-fit fit" data-fit' +
        ' data-fit-max="' + escAttr(FIT_MAX) + '"' +
        ' data-fit-min="' + escAttr(FIT_MIN) + '"' +
        ' style="height:' + escAttr(h) + '">' +
        '<div class="fit-inner">';
    }
    return '<div class="slip-fit"><div class="fit-inner">';
  }

  function closeFit() {
    return '</div></div>';
  }

  function slipPreviewHTML(slip, index) {
    var base = 'slips.' + index;
    var id = escAttr(slip && slip.id != null ? slip.id : base);
    var type = normalizeType(slip && slip.type);

    if (!slip || typeof slip !== 'object' || !type) {
      var raw = slip && typeof slip === 'object' ? slip.type : slip;
      return '<div class="slip slip--unknown" data-slip-id="' + id + '">' +
        '<div class="slip-unknown">Unknown slip type: &ldquo;' +
        escText(raw) + '&rdquo;</div></div>';
    }

    if (type === 'starburst') {
      /* Not a [data-fit] box: the burst is a fixed-aspect graphic whose text
       * must stay centred on it. Page-level fit handles it. */
      return '<div class="slip slip--starburst" data-slip-id="' + id + '">' +
        burstHTML(slip, base + '.text') + '</div>';
    }

    var inner;
    if (type === 'lunch') inner = lunchInnerHTML(slip, base);
    else if (type === 'afterschool') inner = afterschoolInnerHTML(slip, base);
    else inner = customInnerHTML(slip, base);

    return '<div class="slip slip--' + escAttr(type) + '" data-slip-id="' + id + '">' +
      openFit(slip) + inner + closeFit() +
      '</div>';
  }

  /**
   * previewHTML(slips) -> innerHTML for page 3's .paper-flow.
   * Groups by `column`, preserving array order within each column. Both
   * columns are always emitted, even when empty, so the grid stays stable.
   */
  function previewHTML(slips) {
    var list = isArray(slips) ? slips : [];
    var cols = { left: '', right: '' };

    for (var i = 0; i < list.length; i++) {
      var slip = list[i];
      var col = normalizeColumn(slip && slip.column);
      cols[col] += slipPreviewHTML(slip, i);
    }

    return '' +
      '<div class="slip-cols">' +
        '<div class="slip-col" data-col="left">' + cols.left + '</div>' +
        '<div class="slip-col" data-col="right">' + cols.right + '</div>' +
      '</div>';
  }

  /* ---------------------------------------------------------------------------
   * Editor fragments
   *
   * No inline onclick anywhere. Every button carries data-act (+ data-id /
   * data-type / data-index / data-value) and app.js delegates on the container.
   * ------------------------------------------------------------------------ */

  function btn(act, attrs, cls, title, label) {
    var out = '<button type="button" class="slip-btn' + (cls ? ' ' + cls : '') +
      '" data-act="' + escAttr(act) + '"';
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== null) {
        out += ' ' + k + '="' + escAttr(attrs[k]) + '"';
      }
    }
    if (title) out += ' title="' + escAttr(title) + '" aria-label="' + escAttr(title) + '"';
    return out + '>' + label + '</button>';
  }

  function rtField(label, path, opts) {
    var o = opts || {};
    return '' +
      '<label class="slip-f">' +
        '<span class="slip-f-label">' + escText(label) + '</span>' +
        '<div class="rt' + (o.cls ? ' ' + o.cls : '') + '" contenteditable="true"' +
          ' data-path="' + escAttr(path) + '" data-page="3"' +
          (o.single ? ' data-single="true"' : '') + '>' +
          html(o.value) +
        '</div>' +
      '</label>';
  }

  function checkField(label, path, value) {
    return '' +
      '<label class="slip-check">' +
        '<input type="checkbox" class="pt" data-path="' + escAttr(path) + '"' +
          ' data-page="3" data-value-type="bool"' +
          (truthy(value) ? ' checked' : '') + '>' +
        '<span>' + escText(label) + '</span>' +
      '</label>';
  }

  function kindSelectHTML(path, current) {
    var sel = normalizeKind(current);
    var out = '<select class="pt slip-opt-kind" data-path="' + escAttr(path) +
      '" data-page="3" aria-label="Line style">';
    for (var i = 0; i < FIELD_KINDS.length; i++) {
      var k = FIELD_KINDS[i];
      out += '<option value="' + escAttr(k) + '"' +
        (k === sel ? ' selected' : '') + '>' +
        escText(FIELD_KIND_LABELS[k] || k) + '</option>';
    }
    return out + '</select>';
  }

  function optionLinesHTML(slip, index, id) {
    var fields = fieldsOf(slip);
    var base = 'slips.' + index + '.fields.';
    var out = '<div class="slip-opts">' +
      '<div class="slip-opts-head">Option lines</div>';

    if (!fields.length) {
      out += '<p class="slip-empty">No option lines yet.</p>';
    }

    for (var j = 0; j < fields.length; j++) {
      var f = fields[j] && typeof fields[j] === 'object' ? fields[j] : {};
      var isInline = normalizeKind(f.kind) === 'inline';
      out += '<div class="slip-opt" data-index="' + escAttr(j) + '">' +
        kindSelectHTML(base + j + '.kind', f.kind) +
        '<div class="rt slip-opt-label" contenteditable="true"' +
          ' data-path="' + escAttr(base + j + '.label') + '" data-page="3"' +
          ' data-single="true">' + html(f.label) + '</div>' +
        btn('field-del', { 'data-id': id, 'data-index': j },
            'slip-btn--icon slip-btn--danger', 'Remove line', '×') +
        (isInline
          ? '<p class="slip-opt-hint">Separate the choices with | (pipe).</p>'
          : '') +
        '</div>';
    }

    out += btn('field-add', { 'data-id': id }, 'slip-btn--ghost', null,
      '+ Add option line');
    return out + '</div>';
  }

  /* --- After School editor fragments -------------------------------------- */

  /** The repeatable two-column terms table (Emergency / Late Enrollees ...). */
  function termLinesHTML(slip, index, id) {
    var terms = termsOf(slip);
    var base = 'slips.' + index + '.terms.';
    var out = '<div class="slip-opts">' +
      '<div class="slip-opts-head">Rate / policy lines</div>';

    if (!terms.length) out += '<p class="slip-empty">No rate lines yet.</p>';

    for (var i = 0; i < terms.length; i++) {
      out += '<div class="slip-term" data-index="' + escAttr(i) + '">' +
        '<div class="rt slip-term-label" contenteditable="true"' +
          ' data-path="' + escAttr(base + i + '.label') + '" data-page="3"' +
          ' data-single="true" data-placeholder="Label">' +
          html(terms[i].label) + '</div>' +
        '<div class="rt slip-term-value" contenteditable="true"' +
          ' data-path="' + escAttr(base + i + '.value') + '" data-page="3"' +
          ' data-placeholder="Detail">' + html(terms[i].value) + '</div>' +
        btn('term-del', { 'data-id': id, 'data-index': i },
            'slip-btn--icon slip-btn--danger', 'Remove line', '×') +
        '</div>';
    }

    out += btn('term-add', { 'data-id': id }, 'slip-btn--ghost', null,
      '+ Add rate line');
    return out + '</div>';
  }

  function dayStateSelectHTML(path, current, dayName) {
    var sel = normalizeDayState(current);
    var out = '<select class="pt slip-day-state" data-path="' + escAttr(path) +
      '" data-page="3" aria-label="' + escAttr(dayName + ' column') + '">';
    for (var i = 0; i < DAY_STATES.length; i++) {
      var v = DAY_STATES[i];
      out += '<option value="' + escAttr(v) + '"' +
        (v === sel ? ' selected' : '') + '>' +
        escText(DAY_STATE_LABELS[v] || v) + '</option>';
    }
    return out + '</select>';
  }

  /** The weekday grid editor: one column per day, each with an editable
   *  heading and a state dropdown. This is what replaces hand-aligning
   *  underscores and XXX inside a free-text box. */
  function dayGridEditorHTML(slip, index) {
    var labels = dayLabelsOf(slip);
    var states = daysOf(slip);
    var base = 'slips.' + index;
    var out = '<div class="slip-opts">' +
      '<div class="slip-opts-head">Days of the week</div>' +
      '<div class="slip-days-ed">';

    for (var i = 0; i < labels.length; i++) {
      out += '<div class="slip-day-ed">' +
        '<div class="rt slip-day-name" contenteditable="true"' +
          ' data-path="' + escAttr(base + '.dayLabels.' + i) + '"' +
          ' data-page="3" data-single="true"' +
          ' aria-label="Day ' + (i + 1) + ' heading">' +
          html(labels[i]) + '</div>' +
        dayStateSelectHTML(base + '.days.' + i, states[i],
                           String(labels[i]).replace(/<[^>]*>/g, '')) +
        '</div>';
    }

    out += '</div>' +
      '<p class="slip-opt-hint">Pick <strong>XXX</strong> for a day with no ' +
      'after school — a holiday or a half day.</p>' +
      '</div>';
    return out;
  }

  /** Sign-up line count — the "Name ____ / Hrs." blocks. */
  function studentCountHTML(slip, id) {
    var n = studentsOf(slip);
    return '<div class="slip-opts">' +
      '<div class="slip-opts-head">Sign-up lines</div>' +
      '<div class="slip-stepper">' +
        btn('student-del', { 'data-id': id, disabled: n <= 0 ? 'disabled' : null },
            'slip-btn--icon', 'Remove a sign-up line', '−') +
        '<span class="slip-stepper-value">' + n +
          (n === 1 ? ' line' : ' lines') + '</span>' +
        btn('student-add',
            { 'data-id': id, disabled: n >= MAX_STUDENTS ? 'disabled' : null },
            'slip-btn--icon', 'Add a sign-up line', '+') +
      '</div>' +
      '<p class="slip-opt-hint">One <em>Name</em> line and hours grid per ' +
      'child signing up.</p>' +
      '</div>';
  }

  function columnSwitchHTML(id, column) {
    var cur = normalizeColumn(column);
    var out = '<span class="slip-colswitch" role="group" aria-label="Column">';
    var opts = [['left', 'Left'], ['right', 'Right']];
    for (var i = 0; i < opts.length; i++) {
      var v = opts[i][0];
      out += '<button type="button" class="slip-btn slip-btn--toggle' +
        (v === cur ? ' is-active' : '') + '"' +
        ' data-act="slip-col" data-id="' + escAttr(id) + '"' +
        ' data-value="' + escAttr(v) + '"' +
        ' aria-pressed="' + (v === cur ? 'true' : 'false') + '"' +
        ' title="Move to ' + opts[i][1] + ' column">' + opts[i][1] + '</button>';
    }
    return out + '</span>';
  }

  function slipCardHTML(slip, index, total) {
    var isObj = slip && typeof slip === 'object';
    var type = normalizeType(isObj ? slip.type : null);
    var id = isObj && slip.id != null ? slip.id : '';
    var meta = type ? TYPES[type] : null;
    var col = normalizeColumn(isObj ? slip.column : null);
    var base = 'slips.' + index;

    var out = '<section class="slip-card slip-card--' +
      escAttr(type || 'unknown') + '" data-slip-id="' + escAttr(id) +
      '" data-slip-index="' + escAttr(index) + '">';

    /* --- header ------------------------------------------------------- */
    out += '<header class="slip-card-head">' +
      '<span class="slip-card-icon" aria-hidden="true">' +
        escText(meta ? meta.icon : '?') + '</span>' +
      '<span class="slip-card-title">' +
        escText(meta ? meta.label : 'Unknown type') + '</span>' +
      '<span class="slip-card-pos">' + escText((index + 1) + ' of ' + total) +
        ' · ' + escText(col === 'right' ? 'right column' : 'left column') +
      '</span>' +
      '<span class="slip-card-tools">' +
        btn('slip-up', { 'data-id': id, disabled: index === 0 ? 'disabled' : null },
            'slip-btn--icon', 'Move up', '↑') +
        btn('slip-down',
            { 'data-id': id, disabled: index === total - 1 ? 'disabled' : null },
            'slip-btn--icon', 'Move down', '↓') +
        columnSwitchHTML(id, col) +
        btn('slip-dup', { 'data-id': id }, 'slip-btn--icon', 'Duplicate', '⧉') +
        btn('slip-del', { 'data-id': id }, 'slip-btn--icon slip-btn--danger',
            'Delete this box', '✕') +
      '</span>' +
      '</header>';

    /* --- body --------------------------------------------------------- */
    out += '<div class="slip-card-body">';

    if (!type) {
      out += '<p class="slip-warn">This box has an unrecognised type &mdash; ' +
        'it renders as a placeholder on page 3. Delete it, or fix the saved ' +
        'file.</p>';
    } else if (type === 'lunch') {
      out += rtField('Heading', base + '.heading', { value: slip.heading,
        cls: 'slip-rt--heading' });
      out += '<div class="slip-checks">' +
        checkField('Name / grade row', base + '.nameRow', slip.nameRow) +
        checkField('Total line', base + '.total', slip.total) +
        '</div>';
      out += optionLinesHTML(slip, index, id);
      if (truthy(slip.total)) {
        out += rtField('Total label', base + '.totalLabel',
          { value: slip.totalLabel, single: true });
      }
      out += rtField('Footer', base + '.footer', { value: slip.footer });
    } else if (type === 'afterschool') {
      out += rtField('Heading', base + '.heading', { value: slip.heading,
        cls: 'slip-rt--heading' });
      out += rtField('Rate lines', base + '.rates', { value: slip.rates });
      out += rtField('Note', base + '.notes', { value: slip.notes,
        single: true });
      out += termLinesHTML(slip, index, id);
      out += dayGridEditorHTML(slip, index);
      out += studentCountHTML(slip, id);
      out += '<div class="slip-checks">' +
        checkField('Total line', base + '.total', slip.total) +
        '</div>';
      if (truthy(slip.total)) {
        out += rtField('Total label', base + '.totalLabel',
          { value: slip.totalLabel, single: true });
      }
      out += rtField('Footer notes', base + '.footer', { value: slip.footer });
    } else if (type === 'custom') {
      out += rtField('Heading', base + '.heading', { value: slip.heading,
        cls: 'slip-rt--heading' });
      out += rtField('Body', base + '.body', { value: slip.body,
        cls: 'slip-rt--body' });
    } else if (type === 'starburst') {
      out += rtField('Burst text', base + '.text', { value: slip.text,
        cls: 'slip-rt--burst' });
    }

    /* Optional tier-1 fit opt-in: a definite height makes [data-fit] work. */
    if (type === 'lunch' || type === 'custom' || type === 'afterschool') {
      out += '<label class="slip-f slip-f--inline">' +
        '<span class="slip-f-label">Fixed height (optional)</span>' +
        '<input type="text" class="pt slip-height" data-path="' +
          escAttr(base + '.height') + '" data-page="3"' +
          ' placeholder="auto — e.g. 3.2in" value="' +
          escAttr(slip.height == null ? '' : slip.height) + '">' +
        '</label>';
    }

    out += '</div></section>';
    return out;
  }

  /**
   * editorHTML(slips) -> innerHTML for the editor's page-3 section.
   * Toolbar first, then one card per slip in array order.
   */
  function editorHTML(slips) {
    var list = isArray(slips) ? slips : [];
    var out = '<div class="slip-editor">';

    out += '<div class="slip-toolbar">';
    for (var t = 0; t < TYPE_ORDER.length; t++) {
      var type = TYPE_ORDER[t];
      out += btn('slip-add', { 'data-type': type }, 'slip-btn--add',
        'Add a ' + TYPES[type].label,
        '+ ' + escText(TYPES[type].label));
    }
    out += '</div>';

    out += '<div class="slip-list">';
    if (!list.length) {
      out += '<p class="slip-empty">No boxes on page 3 yet. Add one above.</p>';
    }
    for (var i = 0; i < list.length; i++) {
      out += slipCardHTML(list[i], i, list.length);
    }
    out += '</div>';

    return out + '</div>';
  }

  /* ---------------------------------------------------------------------------
   * Mutation helpers
   *
   * Every one operates on the passed array IN PLACE and returns true when it
   * changed something, false otherwise. app.js wraps the call in
   * Keys.App.structuralChange() (and confirms before slip-del).
   * ------------------------------------------------------------------------ */

  function indexOf(slips, id) {
    if (!isArray(slips)) return -1;
    var key = String(id);
    for (var i = 0; i < slips.length; i++) {
      if (slips[i] && String(slips[i].id) === key) return i;
    }
    return -1;
  }

  function find(slips, id) {
    var i = indexOf(slips, id);
    return i < 0 ? null : slips[i];
  }

  /** Append a new slip of `type` to `column` (default 'left'). */
  function add(slips, type, column) {
    if (!isArray(slips)) return false;
    var slip = blank(type);
    slip.column = normalizeColumn(column);
    slips.push(slip);
    return true;
  }

  function remove(slips, id) {
    var i = indexOf(slips, id);
    if (i < 0) return false;
    slips.splice(i, 1);
    return true;
  }

  /** Reorder within the whole array (not within the column). */
  function move(slips, id, delta) {
    var i = indexOf(slips, id);
    if (i < 0) return false;
    var d = parseInt(delta, 10);
    if (!d) return false;
    var j = i + d;
    if (j < 0) j = 0;
    if (j > slips.length - 1) j = slips.length - 1;
    if (j === i) return false;
    slips.splice(j, 0, slips.splice(i, 1)[0]);
    return true;
  }

  /** Deep clone (JSON round-trip) with a fresh uid, inserted directly after. */
  function duplicate(slips, id) {
    var i = indexOf(slips, id);
    if (i < 0) return false;
    var copy;
    try {
      copy = JSON.parse(JSON.stringify(slips[i]));
    } catch (e) {
      return false;
    }
    if (!copy || typeof copy !== 'object') return false;
    copy.id = uid();
    slips.splice(i + 1, 0, copy);
    return true;
  }

  function setColumn(slips, id, col) {
    var slip = find(slips, id);
    if (!slip) return false;
    var next = normalizeColumn(col);
    if (normalizeColumn(slip.column) === next) return false;
    slip.column = next;
    return true;
  }

  /** Lunch slips only. Creates the `fields` array if a loaded file lacked it. */
  function addField(slips, id) {
    var slip = find(slips, id);
    if (!slip || normalizeType(slip.type) !== 'lunch') return false;
    if (!isArray(slip.fields)) slip.fields = [];
    slip.fields.push({ kind: DEFAULT_KIND, label: 'New option @ $0.00' });
    return true;
  }

  function removeField(slips, id, index) {
    var slip = find(slips, id);
    if (!slip || !isArray(slip.fields)) return false;
    var j = parseInt(index, 10);
    if (isNaN(j) || j < 0 || j >= slip.fields.length) return false;
    slip.fields.splice(j, 1);
    return true;
  }

  /* --- After School mutations ---------------------------------------------
   * Each returns true only if something actually changed, so app.js can avoid
   * a pointless re-render and never show a "done" state for a no-op. */

  function addTerm(slips, id) {
    var slip = find(slips, id);
    if (!slip) return false;
    if (!isArray(slip.terms)) slip.terms = termsOf(slip);
    slip.terms.push({ label: 'Label', value: 'Detail' });
    return true;
  }

  function removeTerm(slips, id, index) {
    var slip = find(slips, id);
    if (!slip || !isArray(slip.terms)) return false;
    var j = parseInt(index, 10);
    if (isNaN(j) || j < 0 || j >= slip.terms.length) return false;
    slip.terms.splice(j, 1);
    return true;
  }

  function addStudent(slips, id) {
    var slip = find(slips, id);
    if (!slip) return false;
    var n = studentsOf(slip);
    if (n >= MAX_STUDENTS) return false;
    slip.students = n + 1;
    return true;
  }

  function removeStudent(slips, id) {
    var slip = find(slips, id);
    if (!slip) return false;
    var n = studentsOf(slip);
    if (n <= 0) return false;
    slip.students = n - 1;
    return true;
  }

  /** Set one weekday's state. Kept as an API for completeness; the editor
   *  drives this through the generic `.pt` select binding instead. */
  function setDayState(slips, id, index, state) {
    var slip = find(slips, id);
    if (!slip) return false;
    var i = parseInt(index, 10);
    var days = daysOf(slip);
    if (isNaN(i) || i < 0 || i >= days.length) return false;
    days[i] = normalizeDayState(state);
    slip.days = days;
    return true;
  }

  /* ---------------------------------------------------------------------------
   * Public API
   * ------------------------------------------------------------------------ */
  Keys.Slips = {
    TYPES: TYPES,
    TYPE_ORDER: TYPE_ORDER,
    FIELD_KINDS: FIELD_KINDS,
    FIELD_KIND_LABELS: FIELD_KIND_LABELS,

    blank: blank,
    previewHTML: previewHTML,
    editorHTML: editorHTML,

    /* re-render helper for live edits of an 'inline' option label */
    inlineHTML: inlineHTML,

    /* lookup */
    indexOf: indexOf,
    find: find,

    /* mutations — in place, return true when something changed */
    add: add,
    remove: remove,
    move: move,
    duplicate: duplicate,
    setColumn: setColumn,
    addField: addField,
    removeField: removeField,

    /* After School Sign Up */
    DAY_STATES: DAY_STATES,
    DAY_STATE_LABELS: DAY_STATE_LABELS,
    DEFAULT_DAY_LABELS: DEFAULT_DAY_LABELS,
    MAX_STUDENTS: MAX_STUDENTS,
    termsOf: termsOf,
    daysOf: daysOf,
    dayLabelsOf: dayLabelsOf,
    studentsOf: studentsOf,
    addTerm: addTerm,
    removeTerm: removeTerm,
    addStudent: addStudent,
    removeStudent: removeStudent,
    setDayState: setDayState,

    /* shared escaping (app.js/render.js may reuse) */
    escAttr: escAttr,
    escText: escText
  };
})(window);
