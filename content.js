(() => {
  'use strict';

  // ---- config -------------------------------------------------------------
  const UUID_RE = /\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const NOTE_MAX = 256;
  const KEY = (id) => 's:' + id;

  // 1 = blue, 10 = red (blue -> violet -> magenta -> red). Swap this one
  // function if you want a different ramp.
  const color = (r) => `hsl(${(225 + ((r - 1) / 9) * 135) % 360} 78% 48%)`;

  // ---- storage ------------------------------------------------------------
  // One key per song: "s:<uuid>" -> { r: rating, n: note, t: title, u: updatedMs }
  const cache = new Map();

  function loadAll() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(null, (all) => {
          for (const [k, v] of Object.entries(all || {})) {
            if (k.startsWith('s:')) cache.set(k.slice(2), v);
          }
          resolve();
        });
      } catch (_) { resolve(); }
    });
  }

  function save(id, patch) {
    const next = { ...(cache.get(id) || {}), ...patch, u: Date.now() };
    try {
      if (!next.r && !next.n) {
        cache.delete(id);
        chrome.storage.local.remove(KEY(id));
      } else {
        cache.set(id, next);
        chrome.storage.local.set({ [KEY(id)]: next });
      }
    } catch (_) {
      // Extension was reloaded while this tab stayed open. Refresh the tab.
    }
    paintAll(id);
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const [k, c] of Object.entries(changes)) {
        if (!k.startsWith('s:')) continue;
        const id = k.slice(2);
        if (c.newValue) cache.set(id, c.newValue); else cache.delete(id);
        paintAll(id);
        if (pop.id === id && document.activeElement !== pop.note) syncPopover();
      }
    });
  } catch (_) {}

  // ---- badges -------------------------------------------------------------
  function paint(badge) {
    const d = cache.get(badge.dataset.srId) || {};
    badge.textContent = d.r ? String(d.r) : '+';
    badge.classList.toggle('sr-unrated', !d.r);
    badge.classList.toggle('sr-has-note', !!d.n);
    badge.style.setProperty('--sr-c', d.r ? color(d.r) : 'transparent');
    badge.title = d.n ? d.n : (d.r ? `Rated ${d.r}/10` : 'Rate this song');
  }

  function paintAll(id) {
    document.querySelectorAll('.sr-badge').forEach((b) => {
      if (!id || b.dataset.srId === id) paint(b);
    });
  }

  function makeBadge(id, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sr-badge';
    b.dataset.srId = id;
    b.dataset.srTitle = title || '';
    // Keep Suno's row handlers (play, navigate, drag) from seeing our clicks.
    for (const ev of ['pointerdown', 'mousedown', 'mouseup', 'dblclick']) {
      b.addEventListener(ev, (e) => e.stopPropagation());
    }
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pop.id === id && pop.anchor === b ? closePopover() : openPopover(b);
    });
    paint(b);
    return b;
  }

  function scan() {
    document.querySelectorAll('a[href*="/song/"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(UUID_RE);
      if (!m) return;
      const title = a.textContent.trim().slice(0, 120);
      if (!title) return; // cover-art links etc: only badge the text link
      const id = m[1].toLowerCase();
      const sib = a.nextElementSibling;
      if (sib && sib.classList.contains('sr-badge')) {
        if (sib.dataset.srId !== id) { // React recycled the row for another song
          sib.dataset.srId = id;
          sib.dataset.srTitle = title;
          paint(sib);
        }
        return;
      }
      a.insertAdjacentElement('afterend', makeBadge(id, title));
    });
    pageBadge();
  }

  // Floating badge on /song/<uuid> pages, where there is no list row to hook.
  function pageBadge() {
    const m = location.pathname.match(UUID_RE);
    let el = document.getElementById('sr-page-badge');
    if (!m) { if (el) el.remove(); return; }
    const id = m[1].toLowerCase();
    if (el && el.dataset.srId !== id) { el.remove(); el = null; }
    if (!el) {
      el = makeBadge(id, '');
      el.id = 'sr-page-badge';
      el.classList.add('sr-floating');
      document.body.appendChild(el);
    }
    el.dataset.srTitle = document.title.replace(/\s*[|\u2013-]\s*Suno.*$/i, '').slice(0, 120);
  }

  // ---- popover (one shared instance) --------------------------------------
  const pop = { el: null, id: null, anchor: null, note: null, count: null, btns: [], timer: 0 };

  function buildPopover() {
    const el = document.createElement('div');
    el.className = 'sr-pop';
    el.tabIndex = -1;
    el.hidden = true;

    const scale = document.createElement('div');
    scale.className = 'sr-scale';
    for (let r = 1; r <= 10; r++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = r;
      b.style.setProperty('--sr-c', color(r));
      b.addEventListener('click', () => save(pop.id, { r, t: titleFor() }) || syncPopover());
      pop.btns.push(b);
      scale.appendChild(b);
    }

    const note = document.createElement('textarea');
    note.className = 'sr-note';
    note.maxLength = NOTE_MAX;
    note.rows = 3;
    note.placeholder = 'Notes (256 max)';
    note.addEventListener('input', () => {
      updateCount();
      clearTimeout(pop.timer);
      pop.timer = setTimeout(flushNote, 400);
    });

    const foot = document.createElement('div');
    foot.className = 'sr-foot';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'sr-clear';
    clear.textContent = 'Clear rating';
    clear.addEventListener('click', () => { save(pop.id, { r: 0 }); syncPopover(); });
    const count = document.createElement('span');
    count.className = 'sr-count';
    foot.append(clear, count);

    el.append(scale, note, foot);

    // Swallow keys so Suno hotkeys (space = play, etc) don't fire while typing.
    for (const ev of ['keydown', 'keyup', 'keypress']) {
      el.addEventListener(ev, (e) => {
        e.stopPropagation();
        if (ev !== 'keydown') return;
        if (e.key === 'Escape') { closePopover(); return; }
        if (e.target !== note && /^[0-9]$/.test(e.key)) { // 1-9, 0 = 10
          save(pop.id, { r: e.key === '0' ? 10 : Number(e.key), t: titleFor() });
          syncPopover();
        }
      });
    }
    for (const ev of ['pointerdown', 'mousedown', 'click']) {
      el.addEventListener(ev, (e) => e.stopPropagation());
    }

    document.body.appendChild(el);
    pop.el = el; pop.note = note; pop.count = count;
  }

  const titleFor = () => (pop.anchor && pop.anchor.dataset.srTitle) || (cache.get(pop.id) || {}).t || '';

  function updateCount() {
    const n = pop.note.value.length;
    pop.count.textContent = `${n}/${NOTE_MAX}`;
    pop.count.classList.toggle('sr-full', n >= NOTE_MAX);
  }

  function flushNote() {
    clearTimeout(pop.timer);
    if (!pop.id) return;
    const n = pop.note.value.trim().slice(0, NOTE_MAX);
    if (n !== ((cache.get(pop.id) || {}).n || '')) save(pop.id, { n, t: titleFor() });
  }

  function syncPopover() {
    const d = cache.get(pop.id) || {};
    pop.btns.forEach((b, i) => b.classList.toggle('sr-on', d.r === i + 1));
    if (document.activeElement !== pop.note) pop.note.value = d.n || '';
    updateCount();
  }

  function openPopover(badge) {
    if (!pop.el) buildPopover();
    if (pop.id) flushNote();
    pop.id = badge.dataset.srId;
    pop.anchor = badge;
    pop.note.value = '';
    pop.el.hidden = false;
    syncPopover();
    const r = badge.getBoundingClientRect();
    const w = pop.el.offsetWidth, h = pop.el.offsetHeight;
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
    const left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
    pop.el.style.top = top + 'px';
    pop.el.style.left = left + 'px';
    pop.el.focus({ preventScroll: true });
  }

  function closePopover() {
    if (!pop.el || pop.el.hidden) return;
    flushNote();
    pop.el.hidden = true;
    pop.id = null;
    pop.anchor = null;
  }

  document.addEventListener('pointerdown', (e) => {
    if (!pop.el || pop.el.hidden) return;
    if (pop.el.contains(e.target) || (e.target.closest && e.target.closest('.sr-badge'))) return;
    closePopover();
  }, true);
  window.addEventListener('scroll', () => closePopover(), true);
  window.addEventListener('beforeunload', flushNote);

  // ---- boot ---------------------------------------------------------------
  let pending = 0;
  const schedule = () => { if (!pending) pending = setTimeout(() => { pending = 0; scan(); }, 250); };

  loadAll().then(() => {
    scan();
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  });
})();
