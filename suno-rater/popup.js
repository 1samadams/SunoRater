'use strict';
const color = (r) => `hsl(${(225 + ((r - 1) / 9) * 135) % 360} 78% 48%)`;
const $ = (id) => document.getElementById(id);
let songs = [];

const minSel = $('min');
for (let i = 0; i <= 10; i++) {
  const o = document.createElement('option');
  o.value = i;
  o.textContent = i === 0 ? 'All' : i + '+';
  minSel.appendChild(o);
}

function load() {
  chrome.storage.local.get(null, (all) => {
    songs = Object.entries(all || {})
      .filter(([k]) => k.startsWith('s:'))
      .map(([k, v]) => ({ id: k.slice(2), r: v.r || 0, n: v.n || '', t: v.t || '', u: v.u || 0 }));
    render();
  });
}

function render() {
  const q = $('q').value.trim().toLowerCase();
  const min = Number(minSel.value);
  const byRecent = $('sort').value === 'recent';
  const rows = songs
    .filter((s) => s.r >= min && (!q || (s.t + ' ' + s.n).toLowerCase().includes(q)))
    .sort((a, b) => (byRecent ? b.u - a.u : b.r - a.r || b.u - a.u));

  const list = $('list');
  list.textContent = '';
  if (!rows.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = songs.length ? 'Nothing matches.' : 'No ratings yet. Click the + badge next to a song on suno.com.';
    list.appendChild(e);
  }
  for (const s of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.textContent = s.r || '\u2013';
    if (s.r) chip.style.background = color(s.r);
    const body = document.createElement('div');
    const a = document.createElement('a');
    a.href = 'https://suno.com/song/' + s.id;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = s.t || s.id;
    body.appendChild(a);
    if (s.n) {
      const n = document.createElement('div');
      n.className = 'note';
      n.textContent = s.n;
      body.appendChild(n);
    }
    const m = document.createElement('div');
    m.className = 'meta';
    m.textContent = s.u ? new Date(s.u).toLocaleString() : '';
    body.appendChild(m);
    row.append(chip, body);
    list.appendChild(row);
  }
  $('stats').textContent = `${rows.length} of ${songs.length} songs`;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

$('exp').onclick = () =>
  download(`suno-ratings-${stamp()}.json`, JSON.stringify({ version: 1, songs }, null, 2), 'application/json');

$('csv').onclick = () => {
  const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  const lines = ['rating,title,note,url,updated'].concat(
    songs.map((s) => [s.r, esc(s.t), esc(s.n), 'https://suno.com/song/' + s.id, s.u ? new Date(s.u).toISOString() : ''].join(','))
  );
  download(`suno-ratings-${stamp()}.csv`, lines.join('\n'), 'text/csv');
};

$('tab').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
$('imp').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const incoming = Array.isArray(data) ? data : data.songs;
    const have = new Map(songs.map((s) => [s.id, s]));
    const out = {};
    for (const s of incoming) {
      if (!s || !/^[0-9a-f-]{36}$/i.test(s.id)) continue;
      const cur = have.get(s.id);
      if (cur && cur.u >= (s.u || 0)) continue; // newest edit wins
      out['s:' + s.id.toLowerCase()] = {
        r: Math.min(10, Math.max(0, Number(s.r) || 0)),
        n: String(s.n || '').slice(0, 256),
        t: String(s.t || '').slice(0, 120),
        u: s.u || Date.now(),
      };
    }
    chrome.storage.local.set(out, load);
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
  e.target.value = '';
};

for (const id of ['q', 'min', 'sort']) $(id).addEventListener('input', render);
chrome.storage.onChanged.addListener(load);
load();
