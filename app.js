/* Movie Vault — a static page that reads and writes a private GitHub repo.
 *
 * There is no server. The page holds no data of its own. On sign-in you supply
 * a fine-grained token, kept in this browser only, and every read and write is
 * a direct call to the GitHub API. Each edit becomes a real commit.
 *
 * The one rule that matters: edits are SURGICAL. We never parse the YAML and
 * re-serialise it, because that would reorder keys and reflow the long `plot`
 * blocks, producing huge diffs and mangling files hand-edited in Typora. We
 * replace exactly the lines we mean to and leave every other byte alone.
 */

'use strict';

const API = 'https://api.github.com';
const POSTER_CACHE = 'movie-vault-posters-v1';
const LS = { owner: 'mv_owner', repo: 'mv_repo', token: 'mv_token' };

const state = {
  owner: '', repo: '', token: '',
  films: [], approved: [], banned: [],
  filters: { q: '', genre: '', watchlist: '', decade: '', rating: '', format: '' },
  filtersOpen: false,
};

const $ = (sel) => document.querySelector(sel);
const el = (id) => document.getElementById(id);

/* ── small utilities ──────────────────────────────────────────────────── */

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** UTF-8 safe base64. btoa() alone corrupts accented titles. */
function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function fromB64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

let toastTimer;
function toast(msg, kind = '') {
  const t = el('toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'bad' ? 6000 : 2200);
}

function status(text, kind = '') {
  const s = el('sync');
  if (!s) return;
  s.textContent = text;
  s.className = 'sync ' + kind;
  if (kind === 'saved') setTimeout(() => { if (s.textContent === text) s.textContent = ''; }, 2500);
}

/* ── GitHub API ───────────────────────────────────────────────────────── */

function ghHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${state.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

const contentsURL = (path) =>
  `${API}/repos/${state.owner}/${state.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

async function ghError(res) {
  let detail = '';
  try { detail = (await res.json()).message || ''; } catch { /* no body */ }
  if (res.status === 401) return 'Token rejected — it may have been revoked.';
  if (res.status === 403) return 'Token lacks permission for this repo.';
  if (res.status === 404) return 'Not found — check the user and repo names.';
  if (res.status === 409) return 'File changed on GitHub. Try again.';
  return `GitHub error ${res.status}${detail ? ': ' + detail : ''}`;
}

/** Text of a file, plus the version id needed to write it back. */
async function readFile(path) {
  const res = await fetch(contentsURL(path), { headers: ghHeaders() });
  if (!res.ok) throw new Error(await ghError(res));
  const json = await res.json();
  return { text: fromB64(json.content), sha: json.sha };
}

/** Raw bytes — used for posters, which we never want base64-inflated. */
async function readBlob(path) {
  const res = await fetch(contentsURL(path), {
    headers: ghHeaders({ Accept: 'application/vnd.github.raw' }),
  });
  if (!res.ok) throw new Error(await ghError(res));
  return res.blob();
}

/**
 * Commit a file. The version id is fetched immediately beforehand rather than
 * reused from an earlier read, so a change pushed from a Mac in the meantime
 * cannot be silently overwritten.
 */
async function writeFile(path, text, message, { isNew = false, base64 = null } = {}) {
  let sha;
  if (!isNew) {
    const head = await fetch(contentsURL(path), { headers: ghHeaders() });
    if (head.ok) sha = (await head.json()).sha;
    else if (head.status !== 404) throw new Error(await ghError(head));
  }
  const res = await fetch(contentsURL(path), {
    method: 'PUT',
    headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, content: base64 ?? toB64(text), ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) throw new Error(await ghError(res));
  return res.json();
}

/** Wraps a save so a failure is always visible and never silent. */
async function save(label, fn) {
  status('Saving…', 'saving');
  try {
    await fn();
    status('Saved', 'saved');
    return true;
  } catch (err) {
    status('Not saved', 'failed');
    toast(`${label} failed — ${err.message}`, 'bad');
    return false;
  }
}

/* ── Surgical frontmatter editing (see frontmatter.js) ────────────── */

const { splitFile, joinFile, yamlValue, setScalar, setList, getList, setBody } = FM;

/* ── Posters ──────────────────────────────────────────────────────────── */

/**
 * Private repos cannot be used as an <img src>, so posters are fetched by JS
 * and cached. First sight of a film is a network call; every sight after that
 * is instant and offline.
 */
async function posterBlob(filename) {
  const key = `/poster/${filename}`;
  try {
    const cache = await caches.open(POSTER_CACHE);
    const hit = await cache.match(key);
    if (hit) return hit.blob();
    const blob = await readBlob(`posters/${filename}`);
    await cache.put(key, new Response(blob.slice()));
    return blob;
  } catch {
    return readBlob(`posters/${filename}`);  // caches unavailable (insecure context)
  }
}

/**
 * One object URL per poster, kept for the life of the page.
 *
 * These must NOT be revoked once the <img> has loaded. The browser is free to
 * discard the decoded bitmap of an off-screen image and re-read it from its
 * src; if the src has been revoked by then the poster silently disappears and
 * has to be fetched again every time you scroll back. Holding the URL also
 * makes re-rendering the grid free, since the same src is reused.
 */
const posterURLs = new Map();

async function posterURL(filename) {
  const existing = posterURLs.get(filename);
  if (existing) return existing;
  const url = URL.createObjectURL(await posterBlob(filename));
  posterURLs.set(filename, url);
  return url;
}

const posterObserver = new IntersectionObserver(async (entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const holder = entry.target;
    posterObserver.unobserve(holder);
    const file = holder.dataset.poster;
    if (!file || holder.querySelector('img')) continue;
    try {
      const img = new Image();
      img.alt = '';
      img.src = await posterURL(file);
      holder.querySelector('.fallback')?.remove();
      holder.prepend(img);
    } catch { /* leave the title fallback showing */ }
  }
}, { rootMargin: '400px' });

/* ── Loading the catalogue ────────────────────────────────────────────── */

async function loadCatalogue() {
  const { text } = await readFile('index.json');
  const data = JSON.parse(text);
  state.films = data.films || [];
  state.approved = (data.genres?.approved) || [];
  state.banned = (data.genres?.banned) || [];
}

/* ── Filtering ────────────────────────────────────────────────────────── */

const decadeOf = (f) => (Number.isInteger(f.release_year) ? Math.floor(f.release_year / 10) * 10 : null);
const ratingStr = (r) => (r === null || r === undefined ? '' : (Number.isInteger(r) ? String(r) : String(r)));

function visibleFilms() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  return state.films.filter((m) => {
    if (q) {
      const hay = [m.title, ...(m.director || []), ...(m.actors || [])].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.genre && !(m.genres || []).includes(f.genre)) return false;
    if (f.watchlist && !(m.watchlists || []).includes(f.watchlist)) return false;
    if (f.format && !(m.formats || []).includes(f.format)) return false;
    if (f.decade && String(decadeOf(m)) !== f.decade) return false;
    if (f.rating === 'unrated' && m.rating != null) return false;
    if (f.rating && f.rating !== 'unrated' && ratingStr(m.rating) !== f.rating) return false;
    return true;
  });
}

function uniqueValues(key) {
  const set = new Set();
  for (const m of state.films) for (const v of (m[key] || [])) set.add(v);
  return [...set].sort();
}

/* ── Library rendering ────────────────────────────────────────────────── */

function renderFilters() {
  const box = el('filters');
  box.hidden = !state.filtersOpen;
  if (!state.filtersOpen) return;

  const decades = [...new Set(state.films.map(decadeOf).filter((d) => d !== null))].sort((a, b) => b - a);
  const ratings = ['5', '4.5', '4', '3.5', '3', '2.5', '2', '1.5', '1', '0.5', 'unrated'];
  const groups = [
    ['Watchlist', 'watchlist', uniqueValues('watchlists')],
    ['Genre', 'genre', uniqueValues('genres')],
    ['Format', 'format', uniqueValues('formats')],
    ['Decade', 'decade', decades.map(String)],
    ['Rating', 'rating', ratings],
  ];

  box.innerHTML = groups.map(([label, key, values]) => `
    <h4>${label}</h4>
    <div class="chips">
      ${values.map((v) => {
        const on = state.filters[key] === v;
        const banned = key === 'genre' && state.banned.includes(v);
        const text = key === 'decade' ? `${v}s` : (v === 'unrated' ? 'Unrated' : v);
        return `<button class="chip ${on ? 'on' : ''} ${banned ? 'warn' : ''}"
                  data-key="${key}" data-val="${escapeHtml(v)}">${escapeHtml(text)}</button>`;
      }).join('')}
    </div>`).join('');

  box.querySelectorAll('.chip').forEach((chip) => {
    chip.onclick = () => {
      const { key, val } = chip.dataset;
      state.filters[key] = state.filters[key] === val ? '' : val;
      renderFilters();
      renderGrid();
    };
  });
}

function renderGrid() {
  const films = visibleFilms();
  const grid = el('grid');
  el('count').textContent =
    `${films.length} film${films.length === 1 ? '' : 's'}${films.length !== state.films.length ? ` of ${state.films.length}` : ''}`;
  el('empty').hidden = films.length > 0;

  grid.innerHTML = films.map((m) => `
    <article class="card" data-slug="${escapeHtml(m.slug)}">
      <div class="poster" ${m.poster ? `data-poster="${escapeHtml(m.poster)}"` : ''}>
        <div class="fallback">${escapeHtml(m.title || m.slug)}</div>
        ${m.rating != null ? `<span class="badge">${ratingStr(m.rating)}</span>` : ''}
      </div>
      <h3>${escapeHtml(m.title || m.slug)}</h3>
      <div class="yr">${m.release_year || ''}</div>
    </article>`).join('');

  grid.querySelectorAll('.card').forEach((card) => {
    card.onclick = () => openDetail(card.dataset.slug);
  });
  grid.querySelectorAll('.poster[data-poster]').forEach((p) => posterObserver.observe(p));
}

/* ── Stars ────────────────────────────────────────────────────────────── */

const STAR_PATH = 'M12 2.5l2.95 5.98 6.6.96-4.78 4.66 1.13 6.57L12 17.57 6.1 20.67l1.13-6.57L2.45 9.44l6.6-.96z';

function starSvg(kind) {
  // kind: 'full' | 'half' | 'none'
  const id = 'g' + Math.random().toString(36).slice(2, 8);
  if (kind === 'half') {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">
      <defs><linearGradient id="${id}"><stop offset="50%" stop-color="currentColor" class="fill"/>
      <stop offset="50%" stop-color="#3a4049"/></linearGradient></defs>
      <path d="${STAR_PATH}" fill="url(#${id})" style="color:var(--accent)"/></svg>`;
  }
  const colour = kind === 'full' ? 'var(--accent)' : '#3a4049';
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}" fill="${colour}"/></svg>`;
}

function renderStars(container, value, onPick) {
  const v = value ?? 0;
  container.innerHTML = `<div class="stars">
    ${[1, 2, 3, 4, 5].map((i) => {
      const kind = v >= i ? 'full' : (v >= i - 0.5 ? 'half' : 'none');
      return `<span class="star">${starSvg(kind)}
        <span class="half l" data-v="${i - 0.5}"></span>
        <span class="half r" data-v="${i}"></span></span>`;
    }).join('')}
    ${value != null ? '<button class="rating-clear">Clear</button>' : ''}
  </div>`;
  container.querySelectorAll('.half').forEach((h) => {
    h.onclick = () => onPick(parseFloat(h.dataset.v));
  });
  container.querySelector('.rating-clear')?.addEventListener('click', () => onPick(null));
}

/* ── Detail sheet ─────────────────────────────────────────────────────── */

let current = null;   // { film, text, body }

/**
 * Record a successful write against the open sheet. The sheet may have been
 * closed — or moved on to another film — while the save was in flight. The
 * commit has already landed by that point, so a stale sheet is bookkeeping to
 * skip, never a failure to report.
 */
function noteSaved(film, updated) {
  if (current && current.film === film) current.text = updated;
}

async function openDetail(slug) {
  const film = state.films.find((f) => f.slug === slug);
  if (!film) return;
  const sheet = el('detail');
  sheet.hidden = false;
  sheet.scrollTop = 0;
  sheet.innerHTML = `<div class="sheet-head"><button class="icon" id="d-close">✕</button>
    <h2>${escapeHtml(film.title || slug)}</h2></div>
    <div class="sheet-body"><p class="muted">Loading…</p></div>`;
  el('d-close').onclick = closeDetail;

  try {
    const { text } = await readFile(`movies/${slug}.md`);
    const { body } = splitFile(text);
    current = { film, text, body };
    renderDetail();
  } catch (err) {
    sheet.querySelector('.sheet-body').innerHTML =
      `<p class="error">Could not open this film — ${escapeHtml(err.message)}</p>`;
  }
}

function closeDetail() {
  el('detail').hidden = true;
  current = null;
  renderGrid();
}

function renderDetail() {
  if (!current) return;          // sheet closed while a save was in flight
  const { film, text, body } = current;
  const fm = splitFile(text).fm;
  const genres = getList(fm, 'genres');
  const watchlists = getList(fm, 'watchlists');
  const allLists = uniqueValues('watchlists');

  const meta = [
    ['Director', film.director], ['Photography', film.photography],
    ['Writer', film.writer], ['Cast', (film.actors || []).slice(0, 6)],
    ['Country', film.country ? [film.country] : []], ['Language', film.language ? [film.language] : []],
    ['Formats', film.formats],
  ].filter(([, v]) => v && v.length);

  el('detail').querySelector('.sheet-body').innerHTML = `
    <div class="hero">
      <div class="poster" ${film.poster ? `data-poster="${escapeHtml(film.poster)}"` : ''}>
        <div class="fallback">${escapeHtml(film.title || film.slug)}</div>
      </div>
      <div class="hero-meta">
        <h1>${escapeHtml(film.title || film.slug)}</h1>
        <div class="sub">${film.release_year || ''}</div>
        <dl>${meta.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v.join(', '))}</dd>`).join('')}</dl>
      </div>
    </div>

    <div class="field"><h4>Rating</h4><div id="d-stars"></div></div>

    <div class="field"><h4>Watchlists</h4>
      <div class="chips" id="d-lists">
        ${allLists.map((w) => `<button class="chip ${watchlists.includes(w) ? 'on' : ''}"
            data-w="${escapeHtml(w)}">${escapeHtml(w)}</button>`).join('')}
        <button class="chip" id="d-newlist">+ new list</button>
      </div>
    </div>

    <div class="field"><h4>Genre</h4>
      <div class="typeahead">
        <input id="d-genre" type="text" autocapitalize="off" autocorrect="off" spellcheck="false"
               value="${escapeHtml(genres.join(', '))}" placeholder="Type to search…">
        <div class="typeahead-list" id="d-genre-list" hidden></div>
      </div>
      ${genres.length > 1 ? '<p class="hint">Multiple genres — picking one replaces them all.</p>' : ''}
      ${genres.some((g) => state.banned.includes(g)) ? '<p class="hint error">Contains a banned genre.</p>' : ''}
      ${state.approved.length ? `<p class="hint approved-list">${state.approved.map((g) =>
        genres.includes(g) ? `<b>${escapeHtml(g)}</b>` : escapeHtml(g)).join(' · ')}</p>` : ''}
    </div>

    ${film.plot ? `<div class="field"><h4>Plot</h4><p class="muted">${escapeHtml(film.plot)}</p></div>` : ''}

    <div class="field"><h4>Review</h4>
      <textarea id="d-body" placeholder="Notes and review…">${escapeHtml(body.trim())}</textarea>
      <div class="row-actions"><button id="d-save-body" class="primary">Save review</button></div>
    </div>`;

  el('detail').querySelectorAll('.poster[data-poster]').forEach((p) => posterObserver.observe(p));

  // Rating
  bindStars(el('d-stars'), film);

  // Watchlists
  el('d-lists').querySelectorAll('[data-w]').forEach((btn) => {
    btn.onclick = () => toggleWatchlist(btn.dataset.w, btn);
  });
  el('d-newlist').onclick = () => {
    const name = prompt('New watchlist name');
    if (name && name.trim()) toggleWatchlist(name.trim(), null);
  };

  bindGenre(genres);

  el('d-save-body').onclick = async () => {
    const value = el('d-body').value;
    await save('Review', async () => {
      const fresh = (await readFile(`movies/${film.slug}.md`)).text;
      const updated = setBody(fresh, value.trim() ? value.trim() + '\n' : '');
      await writeFile(`movies/${film.slug}.md`, updated, `Update review for ${film.title}`);
      noteSaved(film, updated);
      film.has_review = !!value.trim();
    });
  };
}

function bindStars(box, film) {
  renderStars(box, film.rating ?? null, async (value) => {
    const before = film.rating ?? null;
    film.rating = value;                       // optimistic: redraw immediately
    bindStars(box, film);
    const ok = await save('Rating', async () => {
      const fresh = (await readFile(`movies/${film.slug}.md`)).text;
      const parts = splitFile(fresh);
      const updated = joinFile(setScalar(parts.fm, 'rating', value === null ? 'null' : value), parts.body);
      await writeFile(`movies/${film.slug}.md`, updated,
        value === null ? `Clear rating for ${film.title}` : `Rate ${film.title} ${value}/5`);
      noteSaved(film, updated);
    });
    if (!ok) { film.rating = before; bindStars(box, film); }
  });
}

async function toggleWatchlist(name, btn) {
  const film = current.film;
  const path = `movies/${film.slug}.md`;
  btn?.classList.toggle('on');
  const ok = await save('Watchlist', async () => {
    const fresh = (await readFile(path)).text;
    const parts = splitFile(fresh);
    const lists = getList(parts.fm, 'watchlists');
    const on = lists.includes(name);
    const next = on ? lists.filter((w) => w !== name) : [...lists, name];
    const updated = joinFile(setList(parts.fm, 'watchlists', next), parts.body);
    await writeFile(path, updated,
      on ? `Remove ${film.title} from ${name}` : `Add ${film.title} to ${name}`);
    noteSaved(film, updated);
    film.watchlists = next;
  });
  if (!ok) btn?.classList.toggle('on');
  else if (!btn) renderDetail();     // a brand-new list needs a redraw to appear
}

/* ── Genre type-ahead ─────────────────────────────────────────────────── */

function bindGenre(currentGenres) {
  const input = el('d-genre');
  const list = el('d-genre-list');

  const close = () => { list.hidden = true; };

  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) return close();

    if (state.banned.some((b) => b.toLowerCase() === q)) {
      list.innerHTML = `<div class="banned">“${escapeHtml(input.value.trim())}” is banned and cannot be used</div>`;
      list.hidden = false;
      return;
    }

    const matches = state.approved.filter((g) => g.toLowerCase().includes(q));
    const exact = state.approved.some((g) => g.toLowerCase() === q);
    const rows = matches.map((g) => `<div data-g="${escapeHtml(g)}">${escapeHtml(g)}</div>`);
    if (!exact && input.value.trim()) {
      rows.push(`<div class="new" data-new="${escapeHtml(input.value.trim())}">
        + Add “${escapeHtml(input.value.trim())}” as a new approved genre</div>`);
    }
    list.innerHTML = rows.join('');
    list.hidden = false;

    list.querySelectorAll('[data-g]').forEach((row) => {
      row.onclick = () => { close(); applyGenre(row.dataset.g, false); };
    });
    list.querySelectorAll('[data-new]').forEach((row) => {
      row.onclick = () => { close(); applyGenre(row.dataset.new, true); };
    });
  };

  input.onblur = () => setTimeout(close, 180);
  input.onfocus = () => { if (input.value.trim()) input.oninput(); };
}

/**
 * Insert a genre directly after the last item of the `approved:` block.
 *
 * Not simply "before `banned:`" — the comment block above `banned:` would then
 * sit in the middle of the approved list, and every new genre would stack up
 * after it. YAML tolerates that, but the file becomes unreadable.
 * Returns null if the file does not look like we expect, so we never guess.
 */
function appendApproved(text, genre) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^approved:\s*$/.test(l));
  if (start === -1) return null;

  let last = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z_][\w-]*:/.test(lines[i])) break;   // next top-level key
    if (/^\s*-\s+/.test(lines[i])) last = i;
  }
  if (last === -1) return null;

  const indent = (lines[last].match(/^\s*/) || [''])[0];
  lines.splice(last + 1, 0, `${indent}- ${genre}`);
  return lines.join('\n');
}

async function applyGenre(genre, isNew) {
  const film = current.film;
  if (isNew && !confirm(
    `Add “${genre}” to your approved genres?\n\nIt will be offered as a suggestion from now on.`)) return;

  const ok = await save('Genre', async () => {
    const path = `movies/${film.slug}.md`;
    const fresh = (await readFile(path)).text;
    const parts = splitFile(fresh);
    const updated = joinFile(setList(parts.fm, 'genres', [genre]), parts.body);
    await writeFile(path, updated, `Set genre of ${film.title} to ${genre}`);
    noteSaved(film, updated);
    film.genres = [genre];

    if (isNew) {
      const g = await readFile('genres.yml');
      const already = new RegExp(
        `^\\s*-\\s+${genre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(g.text);
      if (!already) {
        const next = appendApproved(g.text, genre);
        if (next) {
          await writeFile('genres.yml', next, `Approve genre: ${genre}`);
          state.approved = [...state.approved, genre].sort();
        }
      }
    }
  });
  if (ok) { toast(`Genre set to ${genre}`, 'good'); renderDetail(); }
}

/* ── Add film ─────────────────────────────────────────────────────────── */

const slugify = (s) => s.toLowerCase().trim()
  .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const NEW_FIELDS = [
  ['title', 'Title', 'text'], ['release_year', 'Year', 'number'],
  ['director', 'Director', 'list'], ['writer', 'Writer', 'list'],
  ['photography', 'Photography', 'list'], ['actors', 'Cast', 'list'],
  ['genres', 'Genre', 'text'], ['country', 'Country', 'text'],
  ['language', 'Language', 'text'], ['plot', 'Plot', 'textarea'],
];

let posterUpload = null;   // { base64, name }

function openAdd() {
  const sheet = el('addfilm');
  sheet.hidden = false;
  sheet.scrollTop = 0;
  sheet.innerHTML = `
    <div class="sheet-head"><button class="icon" id="a-close">✕</button><h2>Add a film</h2></div>
    <div class="sheet-body"><div class="form-grid">
      ${NEW_FIELDS.map(([key, label, type]) => `
        <div class="field"><label for="a-${key}">${label}</label>
          ${type === 'textarea'
            ? `<textarea id="a-${key}"></textarea>`
            : `<input id="a-${key}" type="${type === 'number' ? 'number' : 'text'}">`}
          ${type === 'list' ? '<p class="hint">Separate several with commas.</p>' : ''}
          ${key === 'genres' ? `<p class="hint">Approved: ${escapeHtml(state.approved.join(' · '))}</p>` : ''}
        </div>`).join('')}

      <div class="field"><label>Copies</label>
        <div class="chips" id="a-formats">
          ${['Blu-ray', 'DVD', '4K UHD', 'Digital'].map((f) =>
            `<button type="button" class="chip" data-f="${f}">${f}</button>`).join('')}
        </div>
      </div>

      <div class="field"><label for="a-poster">Poster</label>
        <input id="a-poster" type="file" accept="image/*">
        <p class="hint">Shrunk to 500px wide automatically, whatever you upload.</p>
        <img id="poster-preview" hidden alt="">
      </div>

      <div class="field"><label>Saves as</label>
        <p class="filename" id="a-filename">—</p>
      </div>

      <button id="a-save" class="primary">Add film</button>
      <p class="hint">Creates the film, then the poster, as separate commits.</p>
    </div></div>`;

  el('a-close').onclick = () => { el('addfilm').hidden = true; posterUpload = null; };
  el('a-title').oninput = () => {
    const slug = slugify(el('a-title').value);
    el('a-filename').textContent = slug ? `movies/${slug}.md` : '—';
  };
  sheet.querySelectorAll('#a-formats .chip').forEach((c) => {
    c.onclick = () => c.classList.toggle('on');
  });
  el('a-poster').onchange = handlePosterPick;
  el('a-save').onclick = submitNewFilm;
}

/** Shrink to 500px wide — matching the existing collection — before upload. */
async function handlePosterPick(ev) {
  const file = ev.target.files?.[0];
  if (!file) { posterUpload = null; return; }
  try {
    const bitmap = await createImageBitmap(file);
    const w = Math.min(500, bitmap.width);
    const h = Math.round(bitmap.height * (w / bitmap.width));
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    posterUpload = { base64: btoa(bin) };
    const preview = el('poster-preview');
    preview.src = URL.createObjectURL(blob);
    preview.hidden = false;
    toast(`Poster ready — ${Math.round(blob.size / 1024)}KB`, 'good');
  } catch (err) {
    posterUpload = null;
    toast(`Could not read that image — ${err.message}`, 'bad');
  }
}

async function submitNewFilm() {
  const value = (k) => (el(`a-${k}`)?.value || '').trim();
  const title = value('title');
  if (!title) return toast('A title is required', 'bad');

  const slug = slugify(title);
  if (state.films.some((f) => f.slug === slug)) return toast(`${slug}.md already exists`, 'bad');

  const listOf = (k) => value(k).split(',').map((s) => s.trim()).filter(Boolean);
  const formats = [...el('a-formats').querySelectorAll('.chip.on')].map((c) => c.dataset.f);
  const genre = value('genres');
  if (genre && state.banned.includes(genre)) return toast(`“${genre}” is banned`, 'bad');

  const line = (k, v) => (v ? `${k}: ${yamlValue(v)}` : `${k}: null`);
  const block = (k, arr) => (arr.length ? `${k}:\n${arr.map((v) => `- ${yamlValue(v)}`).join('\n')}` : `${k}: []`);

  const fm = [
    `title: ${yamlValue(title)}`,
    value('release_year') ? `release_year: ${parseInt(value('release_year'), 10)}` : 'release_year: null',
    block('director', listOf('director')),
    block('writer', listOf('writer')),
    block('photography', listOf('photography')),
    block('actors', listOf('actors')),
    block('genres', genre ? [genre] : []),
    line('country', value('country')),
    line('language', value('language')),
    formats.length
      ? `copies:\n${formats.map((f) => `- format: ${f}\n  distributor: null\n  shelf_location: null`).join('\n')}`
      : 'copies: []',
    'tags: []',
    'watchlists: []',
    'rating: null',
    'watched: []',
    posterUpload ? `poster: posters/${slug}.jpg` : 'poster: null',
    value('plot') ? `plot: ${yamlValue(value('plot'))}` : 'plot: null',
  ].join('\n');

  const hadPoster = !!posterUpload;
  const ok = await save('Adding film', async () => {
    await writeFile(`movies/${slug}.md`, joinFile(fm, ''), `Add ${title}`, { isNew: true });
    if (posterUpload) {
      await writeFile(`posters/${slug}.jpg`, null, `Poster for ${title}`,
        { isNew: true, base64: posterUpload.base64 });
    }
  });

  if (ok) {
    // Read everything off the form BEFORE clearing it, or the new card in the
    // gallery loses its poster and year.
    const added = {
      slug, title,
      release_year: parseInt(value('release_year'), 10) || undefined,
      genres: genre ? [genre] : [],
      watchlists: [], rating: null,
      poster: hadPoster ? `${slug}.jpg` : undefined,
      formats,
    };
    toast(`Added ${title}`, 'good');
    el('addfilm').hidden = true;
    posterUpload = null;
    state.films.push(added);
    state.films.sort((a, b) => a.slug.localeCompare(b.slug));
    renderGrid();
  }
}

/* ── Sign in / boot ───────────────────────────────────────────────────── */

async function start() {
  el('signin').hidden = true;
  el('library').hidden = false;
  status('Loading…', 'saving');
  try {
    await loadCatalogue();
    status('');
    renderFilters();
    renderGrid();
  } catch (err) {
    status('');
    el('grid').innerHTML =
      `<p class="error" style="grid-column:1/-1">Could not load the catalogue — ${escapeHtml(err.message)}
       <br><br>If this is a fresh repo, the index has not been built yet: push once so the
       Build index action runs, or run build_index.py and commit index.json.</p>`;
  }
}

function signOut() {
  Object.values(LS).forEach((k) => localStorage.removeItem(k));
  location.reload();
}
window.movieVaultSignOut = signOut;   // escape hatch from the console

document.addEventListener('DOMContentLoaded', () => {
  state.owner = localStorage.getItem(LS.owner) || '';
  state.repo = localStorage.getItem(LS.repo) || '';
  state.token = localStorage.getItem(LS.token) || '';

  el('btn-filters').onclick = () => { state.filtersOpen = !state.filtersOpen; renderFilters(); };
  el('btn-add').onclick = openAdd;
  el('search').oninput = (e) => { state.filters.q = e.target.value; renderGrid(); };

  if (state.owner && state.repo && state.token) return start();

  el('signin').hidden = false;
  el('in-owner').value = state.owner;
  el('in-repo').value = state.repo;

  el('btn-signin').onclick = async () => {
    const owner = el('in-owner').value.trim();
    const repo = el('in-repo').value.trim();
    const token = el('in-token').value.trim();
    const err = el('signin-error');
    err.hidden = true;
    if (!owner || !repo || !token) { err.textContent = 'All three are needed.'; err.hidden = false; return; }

    el('btn-signin').disabled = true;
    el('btn-signin').textContent = 'Checking…';
    Object.assign(state, { owner, repo, token });
    try {
      const res = await fetch(`${API}/repos/${owner}/${repo}`, { headers: ghHeaders() });
      if (!res.ok) throw new Error(await ghError(res));
      localStorage.setItem(LS.owner, owner);
      localStorage.setItem(LS.repo, repo);
      localStorage.setItem(LS.token, token);
      start();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      el('btn-signin').disabled = false;
      el('btn-signin').textContent = 'Sign in';
    }
  };
});
