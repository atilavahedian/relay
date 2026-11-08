// Scripted demo: two agent sessions talking through relay.
(function () {
  'use strict';

  var $ = function (s, root) { return (root || document).querySelector(s); };
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- copy buttons ----------
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var label = btn.querySelector('span');
      var done = function () {
        label.textContent = 'Copied';
        setTimeout(function () { label.textContent = 'Copy'; }, 1600);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(btn.getAttribute('data-copy')).then(done, done);
      else done();
    });
  });

  // ---------- demo engine ----------
  function win(sel) {
    var el = $(sel);
    return { el: el, body: $('[data-body]', el), input: $('[data-input]', el) };
  }
  var W = { claude: win('#w-claude'), codex: win('#w-codex') };
  if (!W.claude.el) return;
  var hub = $('#hub');
  var packet = $('#packet');
  var ring = $('#ring');
  var channel = packet.parentNode;
  var caption = $('#caption');
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));

  var run = 0;
  var timers = [];
  function Cancelled() {}
  var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };

  function api(id) {
    var check = function () { if (id !== run) throw new Cancelled(); };
    var wait = function (ms) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () { id === run ? resolve() : reject(new Cancelled()); }, reduce ? 0 : ms);
      });
    };
    var a = {
      wait: wait,
      line: function (w, html, cls) {
        check();
        var d = document.createElement('div');
        d.className = 'ln' + (cls ? ' ' + cls : '');
        d.innerHTML = html;
        // keep the live status line pinned to the bottom, like the real CLIs
        var pin = W[w].spinLine;
        if (pin && pin.parentNode === W[w].body) W[w].body.insertBefore(d, pin);
        else W[w].body.appendChild(d);
        while (W[w].body.children.length > 80) W[w].body.removeChild(W[w].body.firstChild);
        return d;
      },
      type: function (w, text) {
        var i = 0;
        var step = function () {
          check();
          if (i >= text.length) return wait(380);
          W[w].input.textContent += text[i++];
          return wait(22 + Math.random() * 42).then(step);
        };
        return step();
      },
      submit: function (w) {
        var t = W[w].input.textContent;
        W[w].input.textContent = '';
        return t;
      },
      focus: function (w) {
        Object.keys(W).forEach(function (k) {
          W[k].el.classList.toggle('active', k === w);
          W[k].el.classList.toggle('idle', !!w && k !== w);
        });
      },
      // A live status line like the real CLIs show while working. Returns a stop() handle.
      spin: function (w, label, speed) {
        var line = a.line(w, '');
        var glyphs = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
        var start = Date.now();
        var i = 0;
        var render = function () {
          var secs = Math.floor(((Date.now() - start) / 1000) * (speed || 4));
          line.innerHTML = w === 'claude'
            ? '<span class="o">' + glyphs[i++ % glyphs.length] + ' ' + label + '…</span> <span class="d">(' + secs + 's · esc to interrupt)</span>'
            : '<span class="d">•</span> <span class="shimmer">' + label + '</span> <span class="d">(' + secs + 's • esc to interrupt)</span>';
        };
        render();
        W[w].spinLine = line;
        var timer = setInterval(render, 110);
        timers.push(timer);
        return {
          stop: function () {
            clearInterval(timer);
            line.remove();
            if (W[w].spinLine === line) W[w].spinLine = null;
          },
        };
      },
      // Work visibly travels through relay: the labeled packet slides from one agent to the
      // other along a streaming rail, relay pulses as it passes, and both windows light up.
      send: function (to, label) {
        check();
        var from = to === 'codex' ? 'claude' : 'codex';
        var dir = to === 'codex' ? 'to-codex' : 'to-claude';
        packet.textContent = label;
        packet.className = 'packet ' + dir;
        channel.classList.remove('to-codex', 'to-claude');
        channel.classList.add(dir);
        W[from].el.classList.add('sending');
        var horizontal = window.matchMedia('(min-width: 960px)').matches;
        var start = to === 'codex' ? -15 : 115;
        var end = to === 'codex' ? 115 : -15;
        var at = function (p, o) {
          return horizontal ? { left: p + '%', top: '50%', opacity: o } : { top: p + '%', left: '50%', opacity: o };
        };
        if (packet.animate && !reduce) {
          packet.animate(
            [at(start, 0), at(start + (end - start) * 0.15, 1), at(start + (end - start) * 0.85, 1), at(end, 0)],
            { duration: 1000, easing: 'cubic-bezier(.4,0,.3,1)', fill: 'forwards' },
          );
        }
        return wait(450)
          .then(function () {
            ring.classList.remove('go');
            void ring.offsetWidth;
            ring.classList.add('go');
            W[from].el.classList.remove('sending');
            W[to].el.classList.add('sending');
            return wait(600);
          })
          .then(function () {
            W[to].el.classList.remove('sending');
            channel.classList.remove('to-codex', 'to-claude');
          });
      },
      caption: function (n, html) {
        check();
        caption.innerHTML = '<span class="step">' + n + '</span>' + html;
      },
      done: function (dot) {
        if (!dot) return;
        dot.classList.remove('blink');
        dot.classList.add('g');
      },
    };
    return a;
  }

  function reset() {
    timers.forEach(clearInterval);
    timers = [];
    W.claude.spinLine = null;
    W.codex.spinLine = null;
    W.claude.body.innerHTML =
      '<div class="ln cc-welcome"><span class="o">✻</span> <span class="t">Welcome to Claude Code!</span>\n\n' +
      '  <span class="d">/help for help, /status for your current setup</span>\n\n' +
      '  <span class="d">cwd: ~/app</span></div>';
    W.codex.body.innerHTML =
      '<div class="ln cx-header"><span class="c">&gt;_</span> <span class="b">Codex</span>\n\n' +
      '<span class="d">directory:</span> ~/app\n' +
      '<span class="d">mcp:</span>       relay <span class="g">✓</span></div>';
    W.claude.input.textContent = '';
    W.codex.input.textContent = '';
    W.claude.el.classList.remove('active', 'idle');
    W.codex.el.classList.remove('active', 'idle');
    channel.classList.remove('to-codex', 'to-claude');
    W.claude.el.classList.remove('sending');
    W.codex.el.classList.remove('sending');
    caption.innerHTML = '&nbsp;';
  }

  // Claude Code line helpers
  var cc = {
    you: function (t) { return '<span class="m">&gt; ' + esc(t) + '</span>'; },
    say: function (t) { return '<span class="b">⏺</span> ' + t; },
    tool: function (name, args, running) {
      return '<span class="' + (running ? 'm blink' : 'g') + '" data-dot>⏺</span> <span class="b">' + name + '</span><span class="d">' + args + '</span>';
    },
    out: function (t) { return '<span class="d">  ⎿  </span>' + t; },
  };
  // Codex line helpers
  var cx = {
    you: function (t) { return '<span class="c">›</span> ' + esc(t); },
    bullet: function (t) { return '<span class="d">•</span> ' + t; },
    sub: function (t) { return '<span class="d">  └ </span>' + t; },
  };

  var SCENES = [
    // 0. Review: Claude asks Codex to review the diff
    async function (a) {
      a.focus('claude');
      a.caption(1, 'In <b>Claude Code</b>, you ask for a review from <b>Codex</b>.');
      await a.wait(700);
      await a.type('claude', 'ask codex to review my changes');
      a.line('claude', cc.you(a.submit('claude')));
      await a.wait(600);
      a.line('claude', cc.say("I'll ask Codex to review the uncommitted changes."), 'gap');
      await a.wait(500);
      var tool = a.line('claude', cc.tool('relay - review', ' (MCP)(to: "codex", focus: "auth")', true), 'gap');
      var wait1 = a.spin('claude', 'Relaying', 5);
      a.caption(2, 'relay sends <b>Codex</b> the task, the diff and the history. Nothing to paste.');
      await a.send('codex', 'task · diff · chat');

      a.focus('codex');
      a.line('codex', cx.you('[relay] claude: review the uncommitted changes in ~/app (focus: auth)'));
      a.caption(3, '<b>Codex</b> reviews it in the same repo, with its own tools.');
      var work = a.spin('codex', 'Working', 5);
      await a.wait(1500);
      a.line('codex', cx.bullet('<span class="b">Explored</span>'), 'gap');
      a.line('codex', cx.sub('<span class="d">Read</span> src/auth.ts, src/session.ts'));
      await a.wait(1200);
      a.line('codex', cx.bullet('<span class="b">Ran</span> npm test -- auth'), 'gap');
      a.line('codex', cx.sub('<span class="g">12 passed</span> <span class="d">(1.8s)</span>'));
      await a.wait(1400);
      work.stop();
      a.line('codex', cx.bullet('Found 1 issue:'), 'gap');
      a.line('codex', '  1. <span class="b">src/auth.ts:42</span>: session.exp is in seconds but is compared to Date.now() in ms, so sessions never expire. Compare against Date.now() / 1000.');
      a.line('codex', '  Everything else looks good.');
      a.line('codex', '<span class="rule">Worked for 41s</span>', 'gap');
      await a.wait(1000);

      a.caption(4, 'The reply lands back in <b>Claude</b>, which fixes the bug.');
      await a.send('claude', 'reply');
      a.focus('claude');
      wait1.stop();
      a.done(tool.querySelector('[data-dot]'));
      a.line('claude', cc.out('codex replied after 41s:'));
      a.line('claude', '<span class="d">     1. src/auth.ts:42 session.exp is in seconds but is…</span>');
      await a.wait(800);
      a.line('claude', cc.say('Codex found a real bug: the expiry check mixes seconds and milliseconds. Fixing it.'), 'gap');
      var think = a.spin('claude', 'Editing', 3);
      await a.wait(1300);
      think.stop();
      a.line('claude', cc.tool('Update', '(src/auth.ts)'), 'gap');
      a.line('claude', cc.out('Updated <span class="b">src/auth.ts</span> with 1 addition and 1 removal'));
      a.line('claude', '     42 -  if (session.exp &lt; Date.now()) {', 'diff del');
      a.line('claude', '     42 +  if (session.exp &lt; Date.now() / 1000) {', 'diff add');
      await a.wait(1000);
      a.line('claude', cc.tool('Bash', '(npm test)'), 'gap');
      a.line('claude', cc.out('<span class="g">13 passed</span>'));
      await a.wait(700);
      a.line('claude', cc.say('Fixed. Sessions now expire correctly, and I added a regression test.'), 'gap');
      a.caption('✓', 'A full review loop, <b>without copying a single line.</b>');
    },

    // 1. Handoff: Codex gives the tests to Claude
    async function (a) {
      a.focus('codex');
      a.caption(1, 'In <b>Codex</b>, you hand the tests to <b>Claude</b>.');
      await a.wait(700);
      await a.type('codex', 'hand the tests for src/auth.ts to claude');
      a.line('codex', cx.you(a.submit('codex')));
      await a.wait(600);
      a.line('codex', cx.bullet("I'll hand this to Claude along with the repo context."), 'gap');
      await a.wait(500);
      var call = a.line('codex', '<span class="m blink" data-dot>•</span> <span class="b">Calling</span> relay.handoff', 'gap');
      a.line('codex', cx.sub('<span class="d">to:</span> "claude"  <span class="d">task:</span> "Write tests for src/auth.ts: expiry, refresh, revoked tokens"'));
      var waiting = a.spin('codex', 'Waiting for claude', 6);
      a.caption(2, 'relay starts <b>Claude</b> in the same repo, with the task and the context.');
      await a.send('claude', 'task · context');

      a.focus('claude');
      a.line('claude', cc.you('[relay] codex is handing this to you: Write tests for src/auth.ts (expiry, refresh, revoked tokens)'));
      a.caption(3, '<b>Claude</b> does the work: reads the code, writes tests, runs them.');
      var t = a.spin('claude', 'Thinking', 6);
      await a.wait(1300);
      t.stop();
      a.line('claude', cc.tool('Read', '(src/auth.ts)'), 'gap');
      a.line('claude', cc.out('Read <span class="b">88</span> lines'));
      t = a.spin('claude', 'Writing', 6);
      await a.wait(1300);
      t.stop();
      a.line('claude', cc.tool('Write', '(src/auth.test.ts)'), 'gap');
      a.line('claude', cc.out('Wrote <span class="b">64</span> lines to <span class="b">src/auth.test.ts</span>'));
      a.line('claude', '      1 + import { isExpired, refresh, revoke } from "./auth";', 'diff add');
      a.line('claude', '      2 + ', 'diff add');
      a.line('claude', '      3 + describe("session expiry", () => {', 'diff add');
      a.line('claude', '<span class="d">     … +61 lines</span>');
      t = a.spin('claude', 'Running tests', 6);
      await a.wait(1300);
      t.stop();
      a.line('claude', cc.tool('Bash', '(npm test)'), 'gap');
      a.line('claude', cc.out('<span class="g">18 passed</span> <span class="d">(6 new)</span>'));
      await a.wait(600);
      a.line('claude', cc.say('Added 6 tests for expiry, refresh and revoked tokens. All 18 pass.'), 'gap');
      await a.wait(900);

      a.caption(4, 'The result goes straight back to <b>Codex</b>.');
      await a.send('codex', 'reply');
      a.focus('codex');
      waiting.stop();
      a.done(call.querySelector('[data-dot]'));
      a.line('codex', cx.sub('claude replied after 1m 12s'));
      await a.wait(700);
      a.line('codex', cx.bullet('Claude added 6 tests in <span class="b">src/auth.test.ts</span> covering expiry, refresh and revoked tokens. Full suite: <span class="g">18/18 passing</span>.'), 'gap');
      a.line('codex', '<span class="rule">Worked for 1m 14s</span>', 'gap');
      a.caption('✓', 'Codex delegated real work to Claude, <b>and got the result back.</b>');
    },

    // 2. Second opinion: Claude asks Codex a read-only question
    async function (a) {
      a.focus('claude');
      a.caption(1, 'Before a risky migration, you ask <b>Codex</b> for a second opinion.');
      await a.wait(700);
      await a.type('claude', 'ask codex if this migration is safe to run on prod');
      a.line('claude', cc.you(a.submit('claude')));
      await a.wait(600);
      var tool = a.line('claude', cc.tool('relay - ask', ' (MCP)(to: "codex", question: "Is migrations/0042_orders_index.sql safe on prod?")', true), 'gap');
      var wait1 = a.spin('claude', 'Relaying', 3);
      a.caption(2, 'relay passes the question along with the repo context.');
      await a.send('codex', 'question · chat');

      a.focus('codex');
      a.line('codex', cx.you('[relay] claude asks: Is migrations/0042_orders_index.sql safe to run on prod? (read-only)'));
      a.caption(3, '<b>Codex</b> investigates, read-only. It cannot touch your files.');
      var work = a.spin('codex', 'Working', 3);
      await a.wait(1400);
      a.line('codex', cx.bullet('<span class="b">Explored</span>'), 'gap');
      a.line('codex', cx.sub('<span class="d">Read</span> migrations/0042_orders_index.sql, db/schema.sql'));
      a.line('codex', cx.sub('<span class="d">Search</span> "orders" in docs/runbooks'));
      await a.wait(1400);
      work.stop();
      a.line('codex', cx.bullet('<span class="b">Not as written.</span> CREATE INDEX on orders (~40M rows per docs/runbooks/db.md) blocks writes for the whole build.'), 'gap');
      a.line('codex', '  Use CREATE INDEX CONCURRENTLY and move it outside the transaction block.');
      a.line('codex', '<span class="rule">Worked for 23s</span>', 'gap');
      await a.wait(900);

      a.caption(4, 'The answer comes back to <b>Claude</b>, which applies it.');
      await a.send('claude', 'reply');
      a.focus('claude');
      wait1.stop();
      a.done(tool.querySelector('[data-dot]'));
      a.line('claude', cc.out('codex replied after 23s:'));
      a.line('claude', '<span class="d">     Not as written. CREATE INDEX on orders (~40M rows)…</span>');
      await a.wait(800);
      a.line('claude', cc.say('Good catch: that would have blocked writes on <span class="b">orders</span>. Updating the migration.'), 'gap');
      await a.wait(1000);
      a.line('claude', cc.tool('Update', '(migrations/0042_orders_index.sql)'), 'gap');
      a.line('claude', cc.out('Updated with 2 additions and 1 removal'));
      a.line('claude', '      1 -  CREATE INDEX idx_orders_user ON orders (user_id);', 'diff del');
      a.line('claude', '      1 +  -- no-transaction', 'diff add');
      a.line('claude', '      2 +  CREATE INDEX CONCURRENTLY idx_orders_user ON orders (user_id);', 'diff add');
      await a.wait(700);
      a.line('claude', cc.say('Done. The index now builds without blocking writes.'), 'gap');
      a.caption('✓', 'A second opinion in <b>23 seconds</b>, without leaving Claude.');
    },
  ];

  var current = 0;
  var autoplay = !reduce;
  var nextTimer;

  function select(i) {
    tabs.forEach(function (t, j) {
      t.setAttribute('aria-selected', String(i === j));
      var bar = $('.bar', t);
      bar.style.transition = 'none';
      bar.style.width = '0';
    });
  }

  function play(i) {
    clearTimeout(nextTimer);
    run += 1;
    var id = run;
    current = i;
    select(i);
    reset();
    var bar = $('.bar', tabs[i]);
    // a rough progress bar for the running scene
    requestAnimationFrame(function () {
      bar.style.transition = reduce ? 'none' : 'width 26s linear';
      bar.style.width = '100%';
    });
    SCENES[i](api(id)).then(
      function () {
        if (id !== run) return;
        bar.style.transition = 'width .3s ease';
        bar.style.width = '100%';
        if (autoplay) nextTimer = setTimeout(function () { play((i + 1) % SCENES.length); }, 4200);
      },
      function (err) {
        if (!(err instanceof Cancelled)) throw err;
      },
    );
  }

  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { play(i); });
  });
  $('#replay').addEventListener('click', function () { play(current); });

  reset();
  var started = false;
  var start = function () { if (!started) { started = true; play(0); } };
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries, obs) {
      if (entries[0].isIntersecting) { obs.disconnect(); start(); }
    }, { threshold: 0.25 }).observe($('.stage'));
  } else {
    start();
  }
})();
