(() => {
  'use strict';

  // ---- config -------------------------------------------------------------
  const UUID_RE = /\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const NOTE_MAX = 256;
  const KEY = (id) => 's:' + id;

  // 1 = blue, 10 = red (blue -> violet -> magenta -> red). Swap this one
  // function if you want a different ramp.
  const color = (r) => `hsl(${(225 + ((r - 1) / 9) * 135) % 360} 78% 48%)`;

  // ==== SHARED SYNC: keep this block identical in the extension and the userscript ====
  // Syncs ratings to one JSON file the user picks (ideally inside a Google Drive /
  // OneDrive / Dropbox folder). The file handle is remembered in IndexedDB.
  // adapter = { snapshot(): {id: rec}, apply(changes: {id: rec}) }
  const live = (v) => (v && !v.d && (v.r || v.n) ? v : null);

  const Sync = (() => {
    const TOMB_TTL = 90 * 864e5; // forget deletion markers after 90 days
    const host = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    let adapter = null, handle = null, state = 'off', lastSync = 0, lastError = '';
    let busy = false, queued = false, nagged = false, timer = 0, card = null;

    const picker = (name) => {
      const o = typeof window[name] === 'function' ? window : host;
      return typeof o[name] === 'function' ? (opts) => o[name](opts) : null;
    };
    const supported = () => !!(picker('showOpenFilePicker') && picker('showSaveFilePicker') && window.indexedDB);

    function idb(mode, fn) {
      return new Promise((res, rej) => {
        const open = indexedDB.open('suno-rater', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('kv');
        open.onerror = () => rej(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('kv', mode);
          const rq = fn(tx.objectStore('kv'));
          tx.oncomplete = () => { db.close(); res(rq && rq.result); };
          tx.onerror = () => { db.close(); rej(tx.error); };
        };
      });
    }
    const kvGet = (k) => idb('readonly', (s) => s.get(k));
    const kvSet = (k, v) => idb('readwrite', (s) => s.put(v, k));
    const kvDel = (k) => idb('readwrite', (s) => s.delete(k));

    function clean(s) {
      const u = Number(s.u) || 0;
      if (s.d) return { d: 1, u };
      return {
        r: Math.min(10, Math.max(0, Math.round(Number(s.r)) || 0)),
        n: String(s.n || '').slice(0, 256),
        t: String(s.t || '').slice(0, 120),
        u,
      };
    }

    async function readFile() {
      const text = await (await handle.getFile()).text();
      if (!text.trim()) return {};
      const data = JSON.parse(text); // a corrupt file throws here, so we never overwrite it
      const arr = Array.isArray(data) ? data : data && data.songs;
      if (!Array.isArray(arr)) throw new Error('Not a Suno Rater file.');
      const map = {};
      for (const s of arr) {
        if (s && /^[0-9a-f-]{36}$/i.test(s.id)) map[s.id.toLowerCase()] = clean(s);
      }
      return map;
    }

    async function run(interactive) {
      if (!handle) return;
      if (busy) { queued = true; return; }
      busy = true;
      try {
        let p = await handle.queryPermission({ mode: 'readwrite' });
        if (p !== 'granted' && interactive) p = await handle.requestPermission({ mode: 'readwrite' });
        if (p !== 'granted') { state = 'needs-permission'; return; }

        const fileMap = await readFile();
        const localMap = adapter.snapshot();
        const merged = { ...fileMap };
        const toLocal = {};
        let fileDirty = false;
        for (const [id, rec] of Object.entries(localMap)) {
          if (!fileMap[id] || (rec.u || 0) > (fileMap[id].u || 0)) { merged[id] = rec; fileDirty = true; }
        }
        for (const [id, rec] of Object.entries(fileMap)) {
          if (!localMap[id] || (rec.u || 0) > (localMap[id].u || 0)) toLocal[id] = rec;
        }
        if (Object.keys(toLocal).length) adapter.apply(toLocal);
        if (fileDirty) {
          const cutoff = Date.now() - TOMB_TTL;
          const songs = Object.entries(merged)
            .filter(([, v]) => !v.d || v.u > cutoff)
            .map(([id, v]) => ({ id, ...v }));
          const w = await handle.createWritable();
          await w.write(JSON.stringify({ version: 1, songs }, null, 1));
          await w.close();
        }
        state = 'ok'; lastSync = Date.now(); lastError = '';
      } catch (e) {
        state = 'error'; lastError = (e && e.message) || String(e);
      } finally {
        busy = false;
        if (state === 'needs-permission' && !interactive && !nagged) { nagged = true; show(); }
        render();
        if (queued) { queued = false; changed(); }
      }
    }

    async function connect(kind) {
      try {
        const types = [{ description: 'JSON', accept: { 'application/json': ['.json'] } }];
        if (kind === 'new') {
          handle = await picker('showSaveFilePicker')({ suggestedName: 'suno-ratings.json', types });
        } else {
          [handle] = await picker('showOpenFilePicker')({ types, mode: 'readwrite' });
        }
        await kvSet('handle', handle);
        await kvSet('choice', 'file');
        await run(true);
      } catch (e) {
        if (!e || e.name !== 'AbortError') { state = 'error'; lastError = (e && e.message) || String(e); }
        render();
      }
    }

    async function disconnect() {
      handle = null; state = 'off';
      try { await kvDel('handle'); await kvSet('choice', 'local'); } catch (_) {}
      render();
    }

    function btn(label, fn, primary) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (primary) b.className = 'sr-primary';
      b.addEventListener('click', fn);
      return b;
    }

    function render() {
      if (!card || card.hidden) return;
      card.textContent = '';
      const title = document.createElement('div');
      title.className = 'sr-sync-title';
      title.textContent = 'Suno Rater sync';
      const text = document.createElement('div');
      text.className = 'sr-sync-text';
      const row = document.createElement('div');
      row.className = 'sr-sync-row';
      const close = btn('Close', hide);

      if (state === 'unsupported') {
        text.textContent = "This browser can't write to a file you pick (Chrome, Edge, Brave and Arc can). Use Export / Import to move ratings instead.";
        row.append(close);
      } else if (!handle) {
        text.textContent = 'Keep your ratings in one file so they follow you across browsers and machines. Save it inside a folder that Google Drive, OneDrive or Dropbox already syncs. First machine: create the file. Other machines: use the existing one.';
        row.append(
          btn('Create new file', () => connect('new'), true),
          btn('Use existing file', () => connect('open')),
          btn('Not now', async () => { try { await kvSet('choice', 'local'); } catch (_) {} hide(); })
        );
      } else if (state === 'needs-permission') {
        text.textContent = `Sync file: ${handle.name}. The browser wants permission again. Pick "Allow on every visit" and it stops asking.`;
        row.append(btn('Reconnect', () => run(true), true), btn('Disconnect', disconnect), close);
      } else if (state === 'error') {
        text.textContent = `Sync problem with ${handle.name}: ${lastError}`;
        row.append(btn('Retry', () => run(true), true), btn('Disconnect', disconnect), close);
      } else {
        text.textContent = busy ? `Syncing ${handle.name}\u2026`
          : `Syncing to ${handle.name}. Last sync ${lastSync ? new Date(lastSync).toLocaleTimeString() : 'pending'}.`;
        row.append(btn('Sync now', () => run(true), true), btn('Disconnect', disconnect), close);
      }
      card.append(title, text, row);
    }

    function show() {
      if (!card) {
        card = document.createElement('div');
        card.className = 'sr-sync';
        for (const ev of ['pointerdown', 'mousedown', 'click', 'keydown']) {
          card.addEventListener(ev, (e) => e.stopPropagation());
        }
        document.body.appendChild(card);
      }
      card.hidden = false;
      render();
    }
    function hide() { if (card) card.hidden = true; }

    // Call after every local edit. Debounced so a burst of edits is one write.
    function changed() {
      if (!handle || state !== 'ok') return;
      clearTimeout(timer);
      timer = setTimeout(() => run(false), 2000);
    }

    async function init(a) {
      adapter = a;
      if (!supported()) { state = 'unsupported'; return; }
      try {
        handle = (await kvGet('handle')) || null;
        const choice = await kvGet('choice');
        if (handle) await run(false);
        else if (!choice) setTimeout(show, 1500); // first run: ask once
      } catch (_) {}
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && handle && Date.now() - lastSync > 30000) run(false);
      });
    }

    return { init, show, changed };
  })();
  // ==== END SHARED SYNC ====

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
    const next = { ...(live(cache.get(id)) || {}), ...patch, u: Date.now() };
    // Cleared entries become deletion markers so sync can't resurrect them.
    const rec = (!next.r && !next.n) ? { d: 1, u: next.u } : next;
    cache.set(id, rec);
    try {
      chrome.storage.local.set({ [KEY(id)]: rec });
      Sync.changed();
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
    const d = live(cache.get(badge.dataset.srId)) || {};
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
    clear.className = 'sr-link';
    clear.textContent = 'Clear rating';
    clear.addEventListener('click', () => { save(pop.id, { r: 0 }); syncPopover(); });
    const count = document.createElement('span');
    count.className = 'sr-count';
    const sync = document.createElement('button');
    sync.type = 'button';
    sync.className = 'sr-link';
    sync.textContent = 'Sync';
    sync.addEventListener('click', () => { closePopover(); Sync.show(); });
    foot.append(clear, sync, count);

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

  const titleFor = () => (pop.anchor && pop.anchor.dataset.srTitle) || (live(cache.get(pop.id)) || {}).t || '';

  function updateCount() {
    const n = pop.note.value.length;
    pop.count.textContent = `${n}/${NOTE_MAX}`;
    pop.count.classList.toggle('sr-full', n >= NOTE_MAX);
  }

  function flushNote() {
    clearTimeout(pop.timer);
    if (!pop.id) return;
    const n = pop.note.value.trim().slice(0, NOTE_MAX);
    if (n !== ((live(cache.get(pop.id)) || {}).n || '')) save(pop.id, { n, t: titleFor() });
  }

  function syncPopover() {
    const d = live(cache.get(pop.id)) || {};
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
    Sync.init({
      snapshot: () => Object.fromEntries(cache),
      apply: (changes) => {
        const out = {};
        for (const [id, rec] of Object.entries(changes)) { cache.set(id, rec); out[KEY(id)] = rec; }
        try { chrome.storage.local.set(out); } catch (_) {}
        paintAll();
        if (pop.id && document.activeElement !== pop.note) syncPopover();
      },
    });
    scan();
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  });
})();
