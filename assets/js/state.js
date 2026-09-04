/* =============================================================================
 * state.js — Single source of truth for newsletter content.
 *
 * Exposes window.Keys.State. Loaded FIRST; no dependencies.
 *
 * All user-authored text is stored as HTML strings (the editor uses
 * contenteditable + document.execCommand, so inline markup travels with the
 * value). Structure — how many rows, slips, articles — is plain data.
 *
 * Paths are dot-delimited and may contain array indices:
 *     "masthead.title"
 *     "thisWeek.rows.0.date"
 *     "slips.2.fields.1.label"
 *     "calendar.days.2026-06-05"
 * ========================================================================== */
(function (global) {
  'use strict';

  var Keys = global.Keys = global.Keys || {};

  var STORAGE_KEY = 'stpeters.keys.autosave.v2';
  var SCHEMA_VERSION = 2;

  /* ---------------------------------------------------------------------------
   * Default document — seeded with the May 26, 2026 issue so the app opens on
   * a realistic, full-density newsletter. This doubles as the overflow fixture:
   * if the longest real issue fits, the layout is sound.
   * ------------------------------------------------------------------------ */
  function defaultDoc() {
    return {
      meta: { version: SCHEMA_VERSION, savedAt: null },

      masthead: {
        tagline: "QUALITY CHRISTIAN EDUCATION WITH THE MASTER'S TOUCH",
        title: "ST. PETER'S KEYS",
        motto: 'PRAY AND BELIEVE!',
        date: 'May 26, 2026',
        sectionHeading: 'CLASSROOM CORNER',
        schoolInfo:
          "St. Peter's Lutheran School<br>" +
          '6168 Walmore  Road<br>' +
          'Sanborn, New York 14132<br>' +
          'Telephone:  716-731-4422<br>' +
          'Fax:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;716-731-1439<br>' +
          'Website:  discoverstpeters.org<br>' +
          'Financial Mgr.&mdash;Mrs. Jane Donato'
      },

      classroom: {
        verse:
          '&ldquo;Being confident of this, that he who began a good work in you ' +
          'will carry it on to completion until the day of Christ Jesus.&rdquo; ' +
          '&nbsp;Philippians 1:6',
        body:
          '<p>What a wonderful year we have had in kindergarten! Each student has ' +
          'grown so much and accomplished so many things. God has definitely begun ' +
          'a good work in each student both academically and spiritually.</p>' +
          '<p>Not only did we enjoy a wonderful field trip to the Buffalo Zoo, but ' +
          'we have also been working hard to complete much of our curriculum. In ' +
          'Bible, we are learning about the days after Jesus&rsquo; resurrection and ' +
          'His ascension.  In Reading, we continue to practice our many skills! We ' +
          'have started writing a question-and-answer book that we hope to share ' +
          'with the Preschool class when we are finished. Center time remains a ' +
          'highly anticipated part of our day! This is when the students are able ' +
          'to practice the skills we have learned in reading and math in a small ' +
          'group. There is also a group that gets to make a special craft that goes ' +
          'along with the theme of the week. In math, we have been learning about ' +
          'money specifically about how to identify the coins. After completing our ' +
          'Social Studies curriculum we will be ending the year celebrating the ' +
          'things that make the United States so special. Our science lessons this ' +
          'year will end with us learning about outer space and the planets. Whew! ' +
          'Kindergarten is definitely a busy place!</p>' +
          '<p>We are definitely looking forward to all of the special days ahead ' +
          'including kindergarten graduation! There is so much to excited about and ' +
          'thankful for as we finish the year. God is so good and has richly blessed ' +
          'us each and every day throughout this year!</p>',
        signature: 'Mrs. Smith<br>Kindergarten'
      },

      thisWeek: {
        heading: 'THIS WEEK',
        rows: [
          { date: '5/25', event: 'NO SCHOOL&mdash;MEMORIAL DAY' },
          { date: '5/26', event: 'Burger Lunch (Preorders Only)' },
          { date: '5/27', event: 'Staff Meeting&mdash;3:15 pm' },
          { date: '5/28', event: 'Chapel<br>Hotdog Lunch (Preorders Only)' },
          {
            date: '5/29',
            event:
              'Spanish Speaking Exam&mdash;Grade 8<br>' +
              'Pizza Lunch (Preorders only)<br>' +
              'Spice  Fundraiser  Pickup<br>' +
              '&nbsp;&nbsp;&nbsp;&nbsp;2:30 pm&mdash;5 pm  at Church'
          }
        ]
      },

      lookingAhead: {
        heading: 'LOOKING AHEAD',
        rows: [
          {
            date: '5/31',
            event:
              'Join us for Worship Service at<br>' +
              '8:30 am or  11 am<br>' +
              'No Sunday School'
          }
        ],
        note: 'SEE ATTACHED CALENDAR'
      },

      /* Full-width announcement sections. `page1` renders below the two-column
       * region on page 1; `page2` fills page 2. */
      articles: {
        page1: [
          {
            title: 'PTL&mdash;SPICE FUNDRAISER PICKUP',
            body:
              '<p>If you ordered spices from our Spice Fundraiser, pickup will be on ' +
              '<b>Friday, May 29th</b> from 2:30 pm until 5 pm in the Church.</p>' +
              '<p>Thank you to all who ordered!!</p>'
          },
          {
            title: 'END OF YEAR BASKET AUCTION',
            body:
              '<p>Our End of the Year Basket Auction will be held on the day of our ' +
              'end of the year Picnic and Music Program, June 7th.  It will be in the ' +
              'hallway of the &ldquo;new&rdquo; school area.  The basket auction will ' +
              'be open to anyone who would like to attend so be sure to spread the word ' +
              'and invite your family and friends!  It will begin at 9:30 am until 4 pm. ' +
              ' The doors will close at 4:30 pm.  Winners will be notified by Monday, ' +
              'June 8th for pickup.</p>' +
              '<p>Each of our classes will be putting a basket together.  Your ' +
              'child&rsquo;s teacher will contact you about what is needed.  At this ' +
              'time, we are also looking for donations of completed baskets, individual ' +
              'items that can be used for a basket, clear wrap, ribbon, gift cards, ' +
              'and/or money that can be used to purchase items needed.  Please send in ' +
              'any items by June 1st.</p>' +
              '<p>We are always extremely thankful for the generous donations that make ' +
              'our basket auction a wonderful event each year.  If you are interested in ' +
              'helping with setting up or on the day of the auction, please contact ' +
              'Mrs. Scibetta.</p>'
          }
        ],
        page2: [
          {
            title: 'FIELD DAY',
            body:
              '<p>Field Day for Grades K-8 (Pre-K will be in session and dismiss at ' +
              'regular times) will be held on Friday, June  5th at Fireman&rsquo;s Park ' +
              'at 1190 East and West Road, West Seneca, NY 14224.  Students will meet at ' +
              'school for attendance.  Normal morning buses will be provided.  Parent ' +
              'drivers will be needed to transport your child to the event and take home ' +
              'once the event is complete.  Students will stay with their class and ' +
              'travel to the events.  Assistance will be needed by teachers and parents ' +
              'to run events.  Once events are completed, parents will sign their child ' +
              'out with the teacher.  You may stay at the park and enjoy time there or ' +
              'head home/elsewhere.  We will NOT be returning to school, and there will ' +
              'NOT be afternoon buses and we will NOT be providing After School.</p>' +
              '<p>Completed forms were due last week.</p>'
          },
          {
            title: 'CHURCH AND SCHOOL PICNIC',
            body:
              '<p>Sunday, June 7th is our end of the year picnic and music ' +
              'program/concert.  We hope you can join us for any or all of the events. ' +
              ' The music program/concert is mandatory for all K-8 grade students.  A ' +
              'picnic form was sent home a few weeks ago.  It is important that each ' +
              'family attending completes a form and returns it by Friday, May 22nd.  ' +
              'Only one form is needed per family.  List students names and total number ' +
              'of family members attending along with # of hotdogs and # of hamburgers ' +
              'requested.  Please contact the office if you need an additional form.  ' +
              'Completed forms were due last week. <b><u>Please note dogs are not ' +
              'allowed at this event.</u></b></p>' +
              '<ul>' +
              '<li>Church Service at 8:30 am or 10:15 am</li>' +
              '<li>Basket Auction 9:30 am&mdash;4 pm in the hallway of the ' +
              '&ldquo;new&rdquo; school area.  Doors close at 4:30 pm and winners will ' +
              'be notified by Monday, June 8th for pickup.</li>' +
              '<li>Music Program/Concert (mandatory for K-8 students)  at 2 pm.  ' +
              'Students should be in the gym at 1:45 pm. Dress nicely for the music ' +
              'concert (no jeans, t-shirts or hoodies please):' +
              '<div class="indent">Boys:  Dress shorts/pants, shirt with collar<br>' +
              'Girls:  Dresses, skirts, capris, pants.  No shorts<br>' +
              'Adhere to Dress Code:  Sheer clothing, bare midriffs and spaghetti ' +
              'straps are not acceptable dress<br>' +
              'Skirts and dresses 3&rdquo; above the knee are acceptable<br>' +
              'You are welcome to bring a change of clothes for after the concert.  For ' +
              'safety reasons, sandals clogs, crocs and open toed shoes are prohibited ' +
              'on the playground.</div></li>' +
              '<li>Picnic begins immediately following the program and food will be ' +
              'served at 3 pm.</li>' +
              '</ul>' +
              '<p>St. Peter&rsquo;s Church will be providing all of the food and drinks ' +
              'at no cost.   There will be a list with everyone&rsquo;s order at the ' +
              'food tent.</p>' +
              '<p>We look forward to a fun filled day!</p>'
          }
        ]
      },

      /* Page 3 — order-sensitive list of boxes. See slips.js for per-type shape. */
      slips: [
        /* A first-class type, not a free-text box: the ruled lines, the weekday
         * columns and the XXX markers are generated from the structured data
         * below, so the office manager never hand-aligns underscores. */
        {
          id: 'slip-after-school',
          type: 'afterschool',
          column: 'left',
          heading:
            'AFTER SCHOOL SIGN UP<br>' +
            '<span class="slip-sub">*Week of June 1st</span><br>' +
            '<span class="slip-sub"><u>Due Thursday, May 28th</u></span>',
          rates:
            '<i><u>Pre-Reg (per day)</u></i>&nbsp; 1 hour@ $5,<br>' +
            '2 hours@ $10,  3 hours @ $ 15',
          notes: '<i>Family Reg for the year is $35.00.</i>',
          terms: [
            {
              label: '<i>Emergency</i>',
              value: '(family not registered)<br>$7.00 per hour'
            },
            {
              label: 'Late Enrollees',
              value: 'add $1.00 per child per day after Thursday.'
            }
          ],
          dayLabels: ['Mon', 'Tues', 'Wed', 'Thurs', 'Fri'],
          /* Friday of this week is Field Day — no after school, hence XXX. */
          days: ['blank', 'blank', 'blank', 'blank', 'xxx'],
          students: 2,
          total: true,
          totalLabel: 'TOTAL ENCLOSED',
          footer:
            'Field Day&mdash;June 5th&mdash;No After School<br>' +
            'Last Day of After School is Monday, June 15th<br>' +
            'Looking Ahead&hellip;<br>' +
            'No After School on the following 1/2 days:<br>' +
            'Tuesday, June 16th<br>Wednesday, June 17th<br>Thursday, June 18th'
        },
        {
          id: 'slip-hotdog',
          type: 'lunch',
          column: 'right',
          heading:
            'THIS THURSDAY, 5/28<br>FOR LUNCH<br>HOTDOG<br>(Orders due Wednesday,  5/27)',
          nameRow: true,
          fields: [
            { kind: 'text', label: 'Choose Toppings:' },
            { kind: 'inline', label: 'Ketchup | Mustard | Relish' },
            { kind: 'blank-after', label: '# of Hotdogs at $2.00 each' }
          ],
          total: true,
          totalLabel: 'Total Enclosed',
          footer:
            'Please provide exact change.<br>Proceeds to benefit<br>PTL'
        },
        {
          id: 'slip-pizza',
          type: 'lunch',
          column: 'right',
          heading:
            'THIS FRIDAY, 5/29<br>FOR LUNCH<br>PIZZA<br>(Orders due Wednesday,  5/27)',
          nameRow: true,
          fields: [
            { kind: 'blank-before', label: 'Slice Cheese @ $2.00' },
            { kind: 'blank-before', label: 'Slice Pepperoni @ $2.25' }
          ],
          total: true,
          totalLabel: 'Total Enclosed',
          footer: 'Please provide exact change.<br>Proceeds to benefit<br>PTL'
        },
        {
          id: 'slip-quesadilla',
          type: 'lunch',
          column: 'left',
          heading:
            'NEXT TUESDAY, 6/2<br>FOR LUNCH<br>BIENVENIDOS AL VERANO!<br>' +
            'CHEESE QUESADILLA,<br>NACHOS AND CHEESE,<br>' +
            'AND APPLE CINNAMON EMPANADA<br>(Orders due Wednesday, 5/27)',
          nameRow: true,
          fields: [
            { kind: 'blank-after', label: '<b>Add Chicken</b>' },
            { kind: 'blank-before', label: '1 Quesadilla, etc.  @ $4.00' },
            { kind: 'blank-before', label: '2 Quesadillas, etc.  @ $6.00' }
          ],
          total: true,
          totalLabel: 'Total Enclosed',
          footer:
            'Please provide exact change.<br>Proceeds to benefit<br>' +
            '7th and 8th NYC Trip<br>and Luther Reiman&rsquo;s Account'
        },
        {
          id: 'slip-burst',
          type: 'starburst',
          column: 'right',
          text: 'SHORT WEEK ALL<br>LUNCH ORDERS<br>ARE DUE ON<br>WEDNESDAY, MAY<br>27TH'
        }
      ],

      calendar: {
        month: 5, // 0-indexed: 5 = June
        year: 2026,
        schoolName: "St. Peter's Lutheran School",
        website: 'discoverstpeters.org',
        contact:
          '6168 Walmore Road<br>Sanborn, NY 14132<br>Phone: 716-731-4422<br>' +
          'Fax: 716-731-1439<br>E-mail: schooloffice@stpetersanborn.com',
        /* ISO date (YYYY-MM-DD) -> HTML. Keyed by absolute date so switching
         * months never destroys another month's events. */
        days: {
          '2026-06-02': 'Spanish Written Exam<br>Grade 8',
          '2026-06-03': 'Spanish Written Exam<br>Grade 8',
          '2026-06-04': 'Chapel',
          '2026-06-05':
            "Field Day at Fireman's<br>Park for K&mdash;8<br>Regular Pre-K Day<br>" +
            'No Afternoon Buses<br>No After School',
          '2026-06-07':
            'Worship 8:30 Or<br>10:15 am<br>No SS<br>Church and<br>School Picnic/' +
            '<br>Program and<br>Basket Auction',
          '2026-06-09': 'Parish Board Meeting<br>6 pm',
          '2026-06-11': 'Chapel<br>Kindergarten<br>Graduation<br>1 pm in Gym',
          '2026-06-12':
            'Last Day of Pre-K<br>(Note...change from<br>original calendar)<br>' +
            '4th Marking Period<br>Ends',
          '2026-06-14': 'Worship 8:30<br>Or<br>10:15 am<br>No SS',
          '2026-06-15': 'Last Day of After<br>School',
          '2026-06-16':
            '1/2 Day for K-8<br>Dismissal at 11:30 am<br>Normal Buses<br><br>' +
            'Silly Sports Day<br><br>NO AFTER SCHOOL',
          '2026-06-17':
            '1/2 Day for K-8<br>Dismissal at 11:30 am<br>Normal Buses<br>' +
            'Algebra Exam&mdash;am<br>NO AFTER SCHOOL<br><br>8th Grade Graduation<br>' +
            '7 pm in Church',
          '2026-06-18':
            '1/2 Day for K-8<br>Dismissal at 11:30 am<br>Normal Buses<br>' +
            'Final Chapel&mdash;8:45 am<br>Awards in Gym 10 am<br>LAST DAY OF SCHOOL<br>' +
            'NO AFTER SCHOOL<br>Hotdog Picnic Lunch at<br>Oppenheim Park<br>(Preorders Only)',
          '2026-06-19': 'NO SCHOOL FOR<br>STUDENTS<br>STAFF WORK DAY',
          '2026-06-21': 'Worship 8:30 Or<br>10:15 am, No SS',
          '2026-06-28': 'Worship 8:30 Or<br>10:15 am<br>No SS',
          '2026-06-24':
            'Looking Ahead....<br>Cleaning Night #1<br>August 4th<br>' +
            'Cleaning Night #2<br>August 18th'
        }
      }
    };
  }

  /* ---------------------------------------------------------------------------
   * Path access
   * ------------------------------------------------------------------------ */
  function parsePath(path) {
    return String(path).split('.');
  }

  function get(path, root) {
    var node = root || State.doc;
    var parts = parsePath(path);
    for (var i = 0; i < parts.length; i++) {
      if (node == null) return undefined;
      node = node[parts[i]];
    }
    return node;
  }

  function set(path, value, root) {
    var parts = parsePath(path);
    var node = root || State.doc;
    for (var i = 0; i < parts.length - 1; i++) {
      var key = parts[i];
      if (node[key] == null) {
        // Create an array when the *next* key looks like an index.
        node[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      }
      node = node[key];
    }
    node[parts[parts.length - 1]] = value;
    State.dirty = true;
    return value;
  }

  /* ---------------------------------------------------------------------------
   * Persistence
   * ------------------------------------------------------------------------ */
  function migrate(raw) {
    // v1 was the flat {"input-title": "..."} shape from the original prototype.
    if (raw && !raw.meta && raw['input-title'] !== undefined) {
      var doc = defaultDoc();
      var map = {
        'input-title': 'masthead.title',
        'input-date': 'masthead.date',
        'input-verse': 'classroom.verse',
        'input-main': 'classroom.body'
      };
      Object.keys(map).forEach(function (k) {
        if (raw[k] != null) set(map[k], raw[k], doc);
      });
      if (raw['input-announcements'] != null) {
        doc.articles.page1 = [
          { title: 'ANNOUNCEMENTS', body: raw['input-announcements'] }
        ];
      }
      if (raw['input-safety'] != null) {
        doc.articles.page2 = [
          { title: 'REMINDERS', body: raw['input-safety'] }
        ];
      }
      return doc;
    }
    return raw;
  }

  /* ---------------------------------------------------------------------------
   * Load-time hardening
   *
   * A .json file is UNTRUSTED input. It gets e-mailed between staff, and a
   * hand-edited or malformed one must never brick the app or reach the network.
   * Three separate concerns, all applied only on `replace()` — never while the
   * user is typing, which would fight the rich-text editor.
   * ------------------------------------------------------------------------ */

  /** Fields whose value must be an Array. `reconcile` replaces arrays
   *  wholesale, so a truthy non-array in the file would survive and then blow
   *  up the first `.forEach` in the renderer. */
  var LIST_PATHS = [
    'thisWeek.rows', 'lookingAhead.rows',
    'articles.page1', 'articles.page2', 'slips'
  ];

  /** Coerce anything into a sane array. Accepts a real array, or an
   *  object with numeric keys ({"0":{...}}) which is what hand-edited JSON and
   *  some serialisers produce. Anything else becomes empty. */
  function toArray(v) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      var keys = Object.keys(v).filter(function (k) { return /^\d+$/.test(k); });
      if (keys.length) {
        return keys
          .sort(function (a, b) { return a - b; })
          .map(function (k) { return v[k]; });
      }
    }
    return [];
  }

  /* --- HTML scrubbing ------------------------------------------------------
   * Content is intentionally rich HTML authored by the user, so it is
   * interpolated raw into the preview. That is fine for self-authored text but
   * not for a file that arrived from elsewhere: an <img src> or a
   * `background:url()` fires an outbound request (the app promises to make
   * none, and it would act as a read receipt on an e-mailed issue), and a
   * `position:fixed` span escapes `.paper`'s clip entirely — #page-stage is
   * transformed, which makes it the containing block, so a fixed-position
   * descendant is NOT clipped by the sheet and can cover the whole UI.
   *
   * Parsed with <template> rather than regex: regex HTML filtering is
   * defeatable, the parser is not. */
  var ALLOWED_TAGS = {
    B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, SMALL: 1,
    SUP: 1, SUB: 1, BR: 1, P: 1, DIV: 1, SPAN: 1, FONT: 1,
    UL: 1, OL: 1, LI: 1, BLOCKQUOTE: 1, PRE: 1, CODE: 1,
    TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1, TR: 1, TD: 1, TH: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HR: 1
  };
  /* Tags removed outright, content and all. */
  var DROP_TAGS = {
    SCRIPT: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, LINK: 1, STYLE: 1, META: 1,
    BASE: 1, IMG: 1, SVG: 1, VIDEO: 1, AUDIO: 1, SOURCE: 1, TRACK: 1,
    FORM: 1, INPUT: 1, BUTTON: 1, SELECT: 1, TEXTAREA: 1, CANVAS: 1,
    TEMPLATE: 1, PORTAL: 1, MATH: 1, FRAME: 1, FRAMESET: 1, APPLET: 1
  };
  /* Attributes kept. Everything else (src, href, on*, srcset, background,
   * formaction, …) is dropped. `size`/`face`/`color` are kept because
   * document.execCommand still emits <font> in some browsers. */
  var ALLOWED_ATTRS = {
    style: 1, class: 1, colspan: 1, rowspan: 1, align: 1, valign: 1,
    size: 1, face: 1, color: 1, width: 1
  };

  /** Strip declarations from an inline style that can fetch a resource or
   *  break out of the page box. */
  function safeStyle(value) {
    return String(value)
      .split(';')
      .filter(function (decl) {
        var d = decl.toLowerCase();
        if (!d.trim()) return false;
        if (d.indexOf('url(') !== -1) return false;      // network fetch
        if (d.indexOf('image-set') !== -1) return false;  // network fetch
        if (d.indexOf('expression') !== -1) return false; // legacy IE exec
        if (/(^|[^-])position\s*:/.test(d)) return false;  // escapes .paper
        if (/\bz-index\s*:/.test(d)) return false;
        if (/\b(?:inset|top|right|bottom|left)\s*:/.test(d)) return false;
        return true;
      })
      .join(';');
  }

  function scrubNode(root) {
    // Snapshot first: the list would mutate underneath us as we unwrap.
    var els = Array.prototype.slice.call(root.querySelectorAll('*'));
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.parentNode) continue;               // already removed with a parent
      var tag = el.tagName;

      if (DROP_TAGS[tag]) { el.parentNode.removeChild(el); continue; }

      if (!ALLOWED_TAGS[tag]) {
        // Unknown but not dangerous (e.g. <a>): keep the text, drop the tag.
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.parentNode.removeChild(el);
        continue;
      }

      var attrs = Array.prototype.slice.call(el.attributes);
      for (var j = 0; j < attrs.length; j++) {
        var name = attrs[j].name.toLowerCase();
        if (!ALLOWED_ATTRS[name]) { el.removeAttribute(attrs[j].name); continue; }
        if (name === 'style') {
          var safe = safeStyle(attrs[j].value);
          if (safe) el.setAttribute('style', safe);
          else el.removeAttribute('style');
        }
      }
    }
  }

  function sanitizeHTML(html) {
    if (typeof html !== 'string' || html.indexOf('<') === -1) return html;
    if (typeof document === 'undefined') return html;
    try {
      var tpl = document.createElement('template');
      tpl.innerHTML = html;
      scrubNode(tpl.content);
      return tpl.innerHTML;
    } catch (e) {
      // Last resort: strip all markup rather than pass it through unchecked.
      return String(html).replace(/<[^>]*>/g, '');
    }
  }

  /** Recursively sanitize every string in the document. */
  function sanitizeTree(node) {
    if (typeof node === 'string') return sanitizeHTML(node);
    if (Array.isArray(node)) return node.map(sanitizeTree);
    if (node && typeof node === 'object') {
      Object.keys(node).forEach(function (k) {
        node[k] = sanitizeTree(node[k]);
      });
    }
    return node;
  }

  /** Bring a loaded document back into the shape every renderer assumes.
   *  Anything unfixable is replaced with the default rather than left to throw
   *  somewhere deep in a render pass. */
  function normalizeDoc(doc) {
    // 1. Lists must be arrays of objects.
    LIST_PATHS.forEach(function (p) {
      var arr = toArray(get(p, doc)).filter(function (item) {
        return item && typeof item === 'object' && !Array.isArray(item);
      });
      set(p, arr, doc);
    });

    // 2. Every slip needs a unique, non-empty id — Slips.remove/move/duplicate
    //    all look slips up by id, so a missing or duplicated one makes the
    //    delete/reorder buttons silently no-ops.
    var seen = {};
    doc.slips.forEach(function (slip) {
      var id = slip.id == null ? '' : String(slip.id);
      if (!id || seen[id]) id = State.uid('slip');
      seen[id] = true;
      slip.id = id;
      // Repeatable parts must be arrays before any renderer touches them.
      // slips.js also has total accessors for these, so this is hygiene for
      // the saved file rather than the only line of defence.
      ['fields', 'terms', 'days', 'dayLabels'].forEach(function (k) {
        if (slip[k] != null && !Array.isArray(slip[k])) slip[k] = toArray(slip[k]);
      });
    });

    // 3. Calendar month/year must be in range, and must be written BACK to
    //    state — not just normalised for display. Otherwise the sheet renders
    //    one month while the dropdown holds an out-of-range value it has no
    //    option for, so it shows blank and the two disagree.
    var cal = doc.calendar;
    if (!cal || typeof cal !== 'object' || Array.isArray(cal)) {
      cal = doc.calendar = defaultDoc().calendar;
    }
    var now = new Date();
    var m = Math.trunc(Number(cal.month));
    var y = Math.trunc(Number(cal.year));
    if (!isFinite(y) || y < 1000 || y > 9999) y = now.getFullYear();
    if (!isFinite(m)) {
      m = now.getMonth();
    } else if (m < 0 || m > 11) {
      // Roll a legitimate overflow (13 -> Feb next year) into range; anything
      // absurd falls back to the current month.
      var total = y * 12 + m;
      if (total >= 1000 * 12 && total <= 9999 * 12) {
        y = Math.floor(total / 12);
        m = total - y * 12;
      } else {
        m = now.getMonth();
        y = now.getFullYear();
      }
    }
    cal.month = m;
    cal.year = y;

    if (!cal.days || typeof cal.days !== 'object' || Array.isArray(cal.days)) {
      cal.days = {};
    } else {
      // Drop keys that are not YYYY-MM-DD; they can never be reached by the UI.
      Object.keys(cal.days).forEach(function (k) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || typeof cal.days[k] !== 'string') {
          delete cal.days[k];
        }
      });
    }

    return doc;
  }

  /** Deep-merge a loaded doc over the defaults so older/partial files still
   *  produce a complete document. Arrays are replaced wholesale (their length
   *  is meaningful), objects are merged key-by-key. */
  function reconcile(base, incoming) {
    if (incoming === undefined || incoming === null) return base;
    if (Array.isArray(base) || Array.isArray(incoming)) return incoming;
    if (typeof base !== 'object' || typeof incoming !== 'object') return incoming;
    var out = {};
    Object.keys(base).forEach(function (k) {
      out[k] = reconcile(base[k], incoming[k]);
    });
    Object.keys(incoming).forEach(function (k) {
      if (!(k in out)) out[k] = incoming[k];
    });
    return out;
  }

  var State = {
    doc: defaultDoc(),
    dirty: false,

    defaultDoc: defaultDoc,
    get: get,
    set: set,

    /** True only for a plain object usable as a document root.
     *
     *  An Array passes `typeof x === 'object'`, and `reconcile` returns the
     *  incoming value whenever either side is an array — so an array root used
     *  to turn State.doc INTO an array. Everything then appeared to work
     *  (named properties can be set on an array) but JSON.stringify drops
     *  named properties on arrays, so both Save and autosave silently wrote
     *  "[]" and the newsletter was destroyed on the next reload. */
    isUsableDoc: function (v) {
      return !!v && typeof v === 'object' && !Array.isArray(v);
    },

    /** Replace the whole document (from a loaded file or autosave).
     *  Returns null and leaves the current document untouched if `incoming`
     *  cannot be used, so callers can report a real error. */
    replace: function (incoming) {
      if (!State.isUsableDoc(incoming)) return null;
      var migrated = migrate(incoming);
      if (!State.isUsableDoc(migrated)) return null;

      var merged = reconcile(defaultDoc(), migrated);
      if (!State.isUsableDoc(merged)) return null;

      // Untrusted-input hardening, in order: scrub markup, then repair shape.
      merged = normalizeDoc(sanitizeTree(merged));

      State.doc = merged;
      State.doc.meta = State.doc.meta || {};
      State.doc.meta.version = SCHEMA_VERSION;
      State.dirty = false;
      return State.doc;
    },

    /** Reset to the pristine seeded issue. Used by the boot recovery path. */
    reset: function () {
      State.doc = defaultDoc();
      State.dirty = false;
      return State.doc;
    },

    toJSON: function () {
      State.doc.meta = State.doc.meta || {};
      State.doc.meta.version = SCHEMA_VERSION;
      State.doc.meta.savedAt = new Date().toISOString();
      return JSON.stringify(State.doc, null, 2);
    },

    /* --- localStorage autosave (best-effort; never throws) --- */
    autosave: function () {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(State.doc));
        return true;
      } catch (e) {
        return false;
      }
    },
    restore: function () {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        return State.replace(JSON.parse(raw)) ? true : false;
      } catch (e) {
        return false;
      }
    },
    clearAutosave: function () {
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    },

    /* --- id helper for newly created slips/rows --- */
    uid: function (prefix) {
      return (prefix || 'id') + '-' +
        Date.now().toString(36) + '-' +
        Math.floor(Math.random() * 1e6).toString(36);
    },

    /* Exposed for tools/verify.js */
    sanitizeHTML: sanitizeHTML,
    normalizeDoc: normalizeDoc,
    toArray: toArray,

    STORAGE_KEY: STORAGE_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION
  };

  Keys.State = State;
})(window);
