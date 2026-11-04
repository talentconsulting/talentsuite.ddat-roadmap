/* DDaT career tube map — vanilla JS, renders an SVG from /data/ddat-roles.json */
'use strict';

const FAMILY_COLOURS = {
  architecture: '#B36305',
  'chief-digital-and-data': '#9B0056',
  data: '#0098D4',
  'it-operations': '#E32017',
  'product-and-delivery': '#00782A',
  'quality-assurance-testing-qat': '#D799AF',
  'software-development': '#F0B800',
  'user-centred-design': '#00A4A7',
};
const FALLBACK = ['#6A7278', '#003688', '#84B817', '#EE7C0E'];

// Layout constants
const L = {
  left: 240, colW: 122, top: 52, familyH: 34, track: 36, mgmtDrop: 26, minGap: 72,
  lineW: 7, channelGap: 9, hubGap: 60, bottom: 50,
};

const NS = 'http://www.w3.org/2000/svg';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

let DATA, P, roleById, levelById, linesByRole, moveKeys, svg, layers = {};
let levelPos = new Map(), promoteGeom = new Map(), channelOf = new Map(), hub = null;
let skillName = (id) => id;
let zoom = 1, mapW = 0, mapH = 0, hiddenFamilies = new Set();

const colour = (familyId, i = 0) => FAMILY_COLOURS[familyId] || FALLBACK[i % FALLBACK.length];
const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** Short station label: the seniority prefix, e.g. "Senior data analyst" -> "Senior". */
const PREFIX = /^(apprentice|trainee|associate|junior|senior|lead|principal|head of|chief|major)\b/i;
function shortLabel(level) {
  const m = level.name.match(PREFIX);
  const s = m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : level.name;
  return s.length > 12 ? s.slice(0, 11) + '…' : s;
}

// Grade index -> x. Columns ("zones") run AO..G6; the Senior Civil Service hub sits to the right.
const gradeX = (rank) => L.left + (Math.min((rank.min + rank.max) / 2, 6) - 1) * L.colW + L.colW / 2;

/** Octilinear connector (horizontal/vertical + 45° diagonal), returned as path commands without the M. */
function octi(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (!dx || !dy) return `L${b.x},${b.y}`;
  if (Math.abs(dy) >= Math.abs(dx)) return `L${a.x},${b.y - sign(dy) * Math.abs(dx)} L${b.x},${b.y}`;
  return `L${b.x - sign(dx) * Math.abs(dy)},${a.y} L${b.x},${b.y}`;
}

/** Order roles in a family so roles that share skills sit on neighbouring tracks (more interchanges). */
function orderRoles(roleIds) {
  const w = (a, b) => P.moves.filter((m) => m.type === 'transfer'
    && ((m.fromRoleId === a && m.toRoleId === b) || (m.fromRoleId === b && m.toRoleId === a))).length;
  const left = [...roleIds];
  const deg = (id) => left.reduce((n, o) => n + (o === id ? 0 : w(id, o)), 0);
  left.sort((a, b) => deg(b) - deg(a));
  const out = [left.shift()];
  while (left.length) {
    const last = out.at(-1);
    left.sort((a, b) => w(last, b) - w(last, a));
    out.push(left.shift());
  }
  return out;
}

/** Best (most senior) departure for each role -> SCS role link. */
function promoteLinks() {
  const best = new Map();
  for (const m of P.moves) {
    if (m.type !== 'promote') continue;
    const a = levelPos.get(m.from);
    if (!a || !levelPos.get(m.to)) continue;
    const key = `${m.fromRoleId}>${m.toRoleId}`;
    if (!best.has(key) || a.x > levelPos.get(best.get(key).from).x) best.set(key, m);
  }
  return [...best.values()];
}

function layout() {
  levelPos = new Map(); promoteGeom = new Map(); channelOf = new Map(); hub = null;
  const visible = DATA.families.filter((f) => !hiddenFamilies.has(f.id));
  const scsFamily = visible.find((f) => f.roleIds.every((id) => roleById.get(id).isSeniorCivilService));
  const bands = visible.filter((f) => f !== scsFamily);

  // Families with most routes into the SCS go in the middle, closest to the hub
  const feeders = (f) => f.roleIds.reduce((n, id) => n + roleById.get(id).leadsTo.length, 0);
  const sorted = [...bands].sort((a, b) => feeders(b) - feeders(a));
  const ordered = [];
  sorted.forEach((f, i) => (i % 2 ? ordered.push(f) : ordered.unshift(f)));

  const rows = [];
  let y = L.top;
  for (const f of ordered) {
    rows.push({ type: 'family', family: f, y });
    y += L.familyH;
    for (const id of orderRoles(f.roleIds)) {
      const role = roleById.get(id);
      const { core, management } = linesByRole.get(id);
      let prevX = -Infinity;
      for (const l of core.stops.map((s) => levelById.get(s))) {
        const x = Math.max(gradeX(l.gradeRank), prevX + L.minGap);
        levelPos.set(l.id, { x, y, role, level: l });
        prevX = x;
      }
      let prevM = -Infinity;
      for (const l of (management?.stops || []).map((s) => levelById.get(s))) {
        const base = levelPos.get(l.branchOf);
        const x = Math.max(base ? base.x + L.mgmtDrop : gradeX(l.gradeRank), prevM + L.minGap);
        levelPos.set(l.id, { x, y: y + L.mgmtDrop, role, level: l });
        prevM = x;
      }
      rows.push({ type: 'role', role, y });
      y += L.track + (management ? L.mgmtDrop : 0);
    }
    y += 10;
  }
  const maxX = Math.max(L.left + 6 * L.colW, ...[...levelPos.values()].map((p) => p.x));

  // Senior Civil Service hub: one interchange, vertically centred on the lines feeding it
  if (scsFamily) {
    const ids = scsFamily.roleIds;
    const feederYs = ids.flatMap((id) => roleById.get(id).ledFrom.map((r) => levelPos.get(roleById.get(r.id)?.levels.at(-1).id)?.y)).filter(Boolean);
    const midY = feederYs.length ? feederYs.reduce((a, b) => a + b, 0) / feederYs.length : (L.top + y) / 2;
    const hubTop = midY - ((ids.length - 1) * L.hubGap) / 2;
    hub = { ids, x: 0, top: hubTop, bottom: hubTop + (ids.length - 1) * L.hubGap };
    ids.forEach((id, i) => {
      const l = roleById.get(id).levels[0];
      levelPos.set(l.id, { x: 0, y: hubTop + i * L.hubGap, role: roleById.get(id), level: levelById.get(l.id) });
    });

    // Each feeder gets its own vertical channel, so the lines run side by side into the hub
    const links = promoteLinks();
    const above = links.filter((m) => levelPos.get(m.from).y <= levelPos.get(m.to).y).sort((a, b) => levelPos.get(a.from).y - levelPos.get(b.from).y);
    const below = links.filter((m) => levelPos.get(m.from).y > levelPos.get(m.to).y).sort((a, b) => levelPos.get(b.from).y - levelPos.get(a.from).y);
    const n = Math.max(above.length, below.length, 1);
    const c0 = maxX + 40;
    // farthest line takes the right-most channel, so channels don't cross the nearer lines
    above.forEach((m, i) => channelOf.set(`${m.fromRoleId}>${m.toRoleId}`, c0 + (n - 1 - i) * L.channelGap));
    below.forEach((m, i) => channelOf.set(`${m.fromRoleId}>${m.toRoleId}`, c0 + (n - 1 - i) * L.channelGap));
    hub.x = c0 + n * L.channelGap + 46;
    for (const id of ids) levelPos.get(roleById.get(id).levels[0].id).x = hub.x;
  }

  mapW = (hub ? hub.x + 190 : maxX + 80);
  mapH = y + L.bottom;
  return rows;
}

/** Path (without M) from a station into the hub, through the link's channel. */
function promotePath(m) {
  const a = levelPos.get(m.from), b = levelPos.get(m.to);
  const cx = channelOf.get(`${m.fromRoleId}>${m.toRoleId}`) ?? (b.x - 40);
  const dy = b.y - a.y, s = sign(dy), r = Math.min(16, Math.abs(dy) / 2);
  const end = b.x - 11;
  if (!dy) return `L${end},${b.y}`;
  return `L${cx - r},${a.y} L${cx},${a.y + s * r} L${cx},${b.y - s * r} L${cx + r},${b.y} L${end},${b.y}`;
}

/** Path (without M) for any precomputed move, used to draw journeys along the map. */
function movePath(m) {
  const a = levelPos.get(m.from), b = levelPos.get(m.to);
  if (m.type === 'promote') return promotePath(m);
  if (m.type === 'branch') return `L${b.x - (b.y - a.y)},${a.y} L${b.x},${b.y}`;
  return octi(a, b);
}

function render() {
  const rows = layout();
  const host = $('#map');
  host.innerHTML = '';
  svg = el('svg', { viewBox: `0 0 ${mapW} ${mapH}`, role: 'img', 'aria-label': 'Tube map of digital and data career pathways' }, host);
  applyZoom();

  // Zones = Civil Service grades
  const zones = el('g', {}, svg);
  const zoneNames = ['AO', 'EO', 'HEO', 'SEO', 'G7', 'G6'];
  zoneNames.forEach((g, i) => {
    const x = L.left + i * L.colW;
    el('rect', { x, y: 0, width: L.colW, height: mapH, class: i % 2 ? 'zone alt' : 'zone' }, zones);
    for (const ty of [22, mapH - 14]) el('text', { x: x + L.colW / 2, y: ty, 'text-anchor': 'middle', class: 'zone-label' }, zones).textContent = g;
  });
  if (hub) {
    const x = L.left + 6 * L.colW;
    el('rect', { x, y: 0, width: mapW - x, height: mapH, class: 'zone scs' }, zones);
    for (const ty of [22, mapH - 14]) el('text', { x: hub.x, y: ty, 'text-anchor': 'middle', class: 'zone-label' }, zones).textContent = 'Senior Civil Service';
  }

  layers.lines = el('g', {}, svg);
  layers.ix = el('g', {}, svg);
  layers.labels = el('g', {}, svg);
  layers.overlay = el('g', {}, svg);
  layers.route = el('g', {}, svg);

  computeInterchanges();
  for (const r of rows) {
    if (r.type === 'family') {
      el('rect', { x: 14, y: r.y + 9, width: 18, height: 6, rx: 3, fill: colour(r.family.id) }, layers.labels);
      el('text', { x: 38, y: r.y + 16, class: 'family-label' }, layers.labels).textContent = r.family.name;
      continue;
    }
    drawLine(r.role);
  }
  drawInterchanges();
  if (hub) drawHub();
}

function drawLine(role) {
  const c = colour(role.familyId);
  const g = el('g', { class: 'role', 'data-role': role.id }, layers.lines);
  const lg = el('g', { class: 'role', 'data-role': role.id }, layers.labels);
  const { core: coreLine, management: mgmtLine } = linesByRole.get(role.id);
  const core = coreLine.stops.map((id) => levelPos.get(id));
  const mgmt = (mgmtLine?.stops || []).map((id) => levelPos.get(id));
  const lineAttrs = { stroke: c, 'stroke-width': L.lineW, fill: 'none', 'stroke-linejoin': 'round' };

  // Trunk, with a short stub past each terminus
  el('path', { d: `M${core[0].x - 10},${core[0].y} L${core.at(-1).x + 10},${core[0].y}`, ...lineAttrs }, g);
  if (mgmt.length) {
    const base = levelPos.get(mgmtLine.branchFrom) || core[0];
    el('path', { d: `M${base.x},${base.y} L${mgmt[0].x - (mgmt[0].y - base.y)},${base.y} L${mgmt[0].x},${mgmt[0].y} L${mgmt.at(-1).x + 10},${mgmt[0].y}`, ...lineAttrs }, g);
  }
  // Branches into the Senior Civil Service hub
  for (const m of promoteLinks().filter((x) => x.fromRoleId === role.id)) {
    const a = levelPos.get(m.from);
    el('path', { d: `M${a.x},${a.y} ${promotePath(m)}`, ...lineAttrs, 'data-to': m.toRoleId }, g);
  }
  // Terminus bars
  for (const [p, dir] of [[core[0], -1], [core.at(-1), 1], ...(mgmt.length ? [[mgmt.at(-1), 1]] : [])]) {
    if (dir === 1 && promoteLinks().some((m) => m.from === p.level.id)) continue;
    el('rect', { x: p.x + dir * 10 - 2, y: p.y - 8, width: 4, height: 16, fill: c }, g);
  }

  // Line name, at the western terminus
  const name = el('text', { x: core[0].x - 18, y: core[0].y + 4, 'text-anchor': 'end', class: 'line-label halo' }, lg);
  name.textContent = role.name;
  name.addEventListener('click', () => selectRole(role.id));

  let lastRight = -Infinity, lastY = null;
  for (const p of [...core, ...mgmt]) {
    const ix = isInterchange(p.level.id);
    if (p.y !== lastY) { lastRight = -Infinity; lastY = p.y; }
    if (!ix) el('rect', { x: p.x - 2, y: p.y - L.lineW / 2 - 6, width: 4, height: 7, fill: c, class: p.level.gradeInferred ? 'tick inferred' : 'tick' }, g);
    const text = shortLabel(p.level) + (p.level.track === 'management' ? ' (mgr)' : '');
    const half = text.length * 2.9;
    if (p.x - half > lastRight + 4) {
      const t = el('text', { x: p.x, y: p.y - 13, 'text-anchor': 'middle', class: 'stop-label halo' + (p.level.gradeInferred ? ' inferred' : '') }, lg);
      t.textContent = text;
      lastRight = p.x + half;
    }
    // Generous invisible hit target
    const hit = el('circle', { cx: p.x, cy: p.y, r: 11, class: 'hit', 'data-level': p.level.id, tabindex: 0 }, lg);
    const grades = p.level.grades.map((x) => x.code).join(', ') || 'not published';
    el('title', {}, hit).textContent = `${p.level.name}\nGrade: ${grades}${p.level.gradeInferred ? ' (estimated position)' : ''}\n${p.level.skills.length} skills`;
    hit.addEventListener('click', () => selectRole(role.id, p.level.id));
    hit.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectRole(role.id, p.level.id); });
  }
}

/** Interchanges: stations at the same grade position, in the same family, linked by a transfer move. */
let ixGroups = [];
function computeInterchanges() {
  const byKey = new Map();
  for (const [id, p] of levelPos) {
    if (p.role.isSeniorCivilService) continue;
    const k = `${p.role.familyId}@${p.x}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(id);
  }
  ixGroups = [];
  for (const ids of byKey.values()) {
    if (ids.length < 2) continue;
    // Walk down the column; join a station to the capsule above only if it's on the next track
    // and shares a transfer move with a station already in that capsule.
    ids.sort((a, b) => levelPos.get(a).y - levelPos.get(b).y);
    const linked = (u, v) => moveKeys.has(`${u}>${v}`) || moveKeys.has(`${v}>${u}`);
    let comp = [ids[0]];
    for (const v of ids.slice(1)) {
      const gap = levelPos.get(v).y - levelPos.get(comp.at(-1)).y;
      if (gap <= L.track + L.mgmtDrop && comp.some((u) => linked(u, v))) comp.push(v);
      else { if (comp.length > 1) ixGroups.push(comp); comp = [v]; }
    }
    if (comp.length > 1) ixGroups.push(comp);
  }
}
const isInterchange = (levelId) => ixGroups.some((g) => g.includes(levelId));

function drawInterchanges() {
  for (const ids of ixGroups) {
    const ps = ids.map((id) => levelPos.get(id));
    const x = ps[0].x, y1 = Math.min(...ps.map((p) => p.y)), y2 = Math.max(...ps.map((p) => p.y));
    const roles = [...new Set(ps.map((p) => p.role.id))].join(' ');
    const g = el('g', { class: 'ix', 'data-roles': roles }, layers.ix);
    el('rect', { x: x - 7, y: y1 - 7, width: 14, height: y2 - y1 + 14, rx: 7, class: 'ix-capsule' }, g);
  }
}

function drawHub() {
  const ps = hub.ids.map((id) => levelPos.get(roleById.get(id).levels[0].id));
  el('rect', { x: hub.x - 14, y: hub.top - 14, width: 28, height: hub.bottom - hub.top + 28, rx: 14, class: 'ix-capsule hub' }, layers.ix);
  for (const p of ps) {
    const g = el('g', { class: 'role', 'data-role': p.role.id }, layers.labels);
    el('circle', { cx: p.x, cy: p.y, r: 7, class: 'hub-stop', fill: colour(p.role.familyId) }, g);
    const t = el('text', { x: p.x + 22, y: p.y + 5, class: 'hub-label halo' }, g);
    const words = p.role.name.split(' ');
    const lines = [];
    for (const w of words) {
      if (lines.length && (lines.at(-1) + ' ' + w).length <= 18) lines[lines.length - 1] += ' ' + w;
      else lines.push(w);
    }
    lines.forEach((ln, i) => { el('tspan', { x: p.x + 22, dy: i ? 15 : (lines.length > 1 ? -2 : 0) }, t).textContent = ln; });
    const grades = p.level.grades.map((x) => x.code).join(', ');
    const hit = el('circle', { cx: p.x, cy: p.y, r: 14, class: 'hit', tabindex: 0 }, g);
    el('title', {}, hit).textContent = `${p.role.name}\nGrade: ${grades}`;
    for (const n of [hit, t]) n.addEventListener('click', () => selectRole(p.role.id));
  }
}

// ---------- highlighting ----------

function clearHighlight() {
  $('#map').classList.remove('dim');
  svg.querySelectorAll('.hl').forEach((n) => n.classList.remove('hl'));
  layers.overlay.innerHTML = '';
}

function highlightRoles(ids, levelIds = []) {
  clearHighlight();
  if (!ids.length) return;
  $('#map').classList.add('dim');
  const set = new Set(ids);
  for (const id of set) svg.querySelectorAll(`.role[data-role="${id}"]`).forEach((n) => n.classList.add('hl'));
  svg.querySelectorAll('.ix').forEach((n) => { if (n.dataset.roles.split(' ').some((r) => set.has(r))) n.classList.add('hl'); });
  for (const lid of levelIds) {
    const p = levelPos.get(lid);
    if (p) el('circle', { cx: p.x, cy: p.y, r: 12, class: 'match' }, layers.overlay);
  }
}

function selectRole(id, levelId) {
  const role = roleById.get(id);
  // Every precomputed move leaving or entering this role (or just this station, if one was clicked)
  const touches = (m) => (levelId ? m.from === levelId || m.to === levelId : m.fromRoleId === id || m.toRoleId === id)
    && m.fromRoleId !== m.toRoleId;
  const moves = P.moves.filter(touches);
  const connected = new Set(moves.flatMap((m) => [m.fromRoleId, m.toRoleId]));
  highlightRoles([id, ...connected], levelId ? [levelId] : []);

  // One dotted "out of station interchange" per neighbouring role: the shortest hop
  const best = new Map();
  for (const m of moves.filter((x) => x.type === 'transfer')) {
    const pa = levelPos.get(m.from), pb = levelPos.get(m.to);
    if (!pa || !pb) continue;
    const other = m.fromRoleId === id ? m.toRoleId : m.fromRoleId;
    const d = Math.abs(pa.x - pb.x) * 3 + Math.abs(pa.y - pb.y);
    if (!best.has(other) || d < best.get(other).d) best.set(other, { pa, pb, d });
  }
  for (const { pa, pb } of best.values()) {
    if (pa.x === pb.x && Math.abs(pa.y - pb.y) <= L.track && ixGroups.some((g) => g.includes(pa.level.id) && g.includes(pb.level.id))) continue;
    el('path', { d: `M${pa.x},${pa.y} ${octi(pa, pb)}`, class: 'transfer' }, layers.overlay);
  }
  showDetails(role, levelId);
  scrollToPoint(levelPos.get(levelId || role.levels[0].id));
}

function scrollToPoint(p) {
  if (!p) return;
  const host = $('#map');
  host.scrollTo({ left: p.x * zoom - host.clientWidth / 2, top: p.y * zoom - host.clientHeight / 2, behavior: 'smooth' });
}

// ---------- details panel ----------

function showDetails(role, levelId) {
  const d = $('#details');
  const levelHtml = role.levels.map((l) => `
    <details ${l.id === levelId ? 'open' : ''}>
      <summary>${esc(l.name)}
        ${l.grades.map((g) => `<span class="chip">${esc(g.code)}</span>`).join('')}
        ${l.gradeInferred ? '<span class="chip">grade estimated</span>' : ''}
        ${l.track === 'management' ? '<span class="chip">management track</span>' : ''}
      </summary>
      ${l.summary ? `<p>${esc(l.summary)}</p>` : ''}
      ${l.responsibilities.length ? `<ul>${l.responsibilities.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      <strong>Skills</strong>
      <ul class="skills">${l.skills.map((s) => `<li>${esc(s.name)}${s.level ? ` — <em>${esc(s.level)}</em>` : ''}</li>`).join('')}</ul>
    </details>`).join('');
  const related = role.relatedRoles.map((r) => `<a href="#" data-goto="${esc(r.id)}">${esc(r.name)}</a> <span class="muted">(${r.sharedSkills.map(esc).join(', ')})</span>`);
  const leads = role.leadsTo.map((r) => `<a href="#" data-goto="${esc(r.id)}">${esc(r.name)}</a>`);
  const from = role.ledFrom.map((r) => `<a href="#" data-goto="${esc(r.id)}">${esc(r.name)}</a>`);
  d.innerHTML = `
    <button class="ghost close" aria-label="Close details">✕</button>
    <h2>${esc(role.name)}</h2>
    <div class="meta">${esc(role.family)} · ${role.levels.length} level${role.levels.length > 1 ? 's' : ''} · <a href="${esc(role.url)}" target="_blank" rel="noopener">View on framework site</a></div>
    <p>${esc(role.summary)}</p>
    ${role.responsibilities.length ? `<ul>${role.responsibilities.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${related.length ? `<p><strong>Shares skills with:</strong><br>${related.join('<br>')}</p>` : ''}
    ${leads.length ? `<p><strong>Could lead to (Senior Civil Service):</strong> ${leads.join(', ')}</p>` : ''}
    ${from.length ? `<p><strong>Roles that could lead here:</strong> ${from.join(', ')}</p>` : ''}
    ${levelHtml}`;
  d.hidden = false;
  d.querySelector('.close').onclick = () => { d.hidden = true; clearHighlight(); };
  d.querySelectorAll('[data-goto]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); selectRole(a.dataset.goto); }));
}

// ---------- search ----------

async function runSearch(e) {
  e?.preventDefault();
  const params = new URLSearchParams();
  for (const k of ['q', 'category', 'role', 'grade']) if ($('#' + k).value.trim()) params.set(k, $('#' + k).value.trim());
  const list = $('#results');
  if (![...params.keys()].length) { list.innerHTML = ''; $('#result-count').textContent = ''; clearHighlight(); return; }
  const res = await fetch('/api/search?' + params).then((r) => r.json());
  $('#result-count').textContent = `${res.total} role${res.total === 1 ? '' : 's'} found`;
  list.innerHTML = res.results.map((r) => `
    <li data-id="${esc(r.id)}">
      <div class="name"><span class="swatch" style="background:${colour(r.familyId)}"></span>${esc(r.name)}</div>
      <div class="lv">${esc(r.family)} · ${r.matchingLevels.map((l) => esc(l.name)).join(', ')}</div>
    </li>`).join('');
  list.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => selectRole(li.dataset.id)));
  highlightRoles(res.results.map((r) => r.id), res.results.flatMap((r) => r.matchingLevels.map((l) => l.id)));
}

// ---------- journey planner ----------

/** Read a precomputed route: P.routes[fromLevelId][toRoleId] is a list of indexes into P.moves. */
function lookupRoute(fromLevelId, toRoleId) {
  const startRole = levelById.get(fromLevelId)?.roleId;
  if (!startRole) return null;
  if (startRole === toRoleId) return { start: fromLevelId, moves: [] };
  const idx = P.routes[fromLevelId]?.[toRoleId];
  return idx ? { start: fromLevelId, moves: idx.map((i) => P.moves[i]) } : null;
}

function planRoute() {
  const from = $('#from').value, to = $('#to').value;
  if (!from || !to) return;
  const route = lookupRoute(from, to);
  const out = $('#journey');
  layers.route.innerHTML = '';
  if (!route) { out.innerHTML = '<p class="muted">No route found between these roles.</p>'; return; }
  const lv = (id) => levelById.get(id);
  const res = {
    stops: [route.start, ...route.moves.map((m) => m.to)],
    start: { level: lv(route.start).name },
    steps: route.moves.map((m) => ({
      type: m.type,
      to: { level: lv(m.to).name, grades: lv(m.to).grades.map((g) => g.code) },
      sharedSkills: m.sharedSkills,
      skillsToDevelop: m.skillsToDevelop.map((k) => ({ ...k, name: skillName(k.skillId) })),
    })),
  };

  const pts = res.stops.map((id) => levelPos.get(id)).filter(Boolean);
  if (pts.length !== res.stops.length) { out.innerHTML = '<p class="muted">Part of this route is in a hidden category — show all categories to see it.</p>'; return; }
  const d = `M${pts[0].x},${pts[0].y} ` + route.moves.map(movePath).join(' ');
  el('path', { d, class: 'route-casing' }, layers.route);
  el('path', { d, class: 'route' }, layers.route);
  for (const p of pts) el('circle', { cx: p.x, cy: p.y, r: 8, class: 'route-stop' }, layers.route);
  highlightRoles([...new Set(pts.map((p) => p.role.id))]);

  out.innerHTML = `
    <p class="muted">${res.steps.length} move${res.steps.length === 1 ? '' : 's'}</p>
    <ol class="steps">
      <li><div class="type">Start</div><strong>${esc(res.start.level)}</strong></li>
      ${res.steps.map((s) => `
        <li>
          <div class="type">${esc(P.moveTypes[s.type]?.label || s.type)}</div>
          <strong>${esc(s.to.level)}</strong> ${s.to.grades.map((g) => `<span class="chip">${esc(g)}</span>`).join('')}
          ${s.sharedSkills.length ? `<div class="gap">Shared skills: ${s.sharedSkills.map(esc).join(', ')}</div>` : ''}
          ${s.skillsToDevelop.length ? `<div class="gap">Develop: ${s.skillsToDevelop.slice(0, 5).map((k) => `${esc(k.name)}${k.to ? ` (${esc(k.from || 'new')} → ${esc(k.to)})` : ''}`).join('; ')}${s.skillsToDevelop.length > 5 ? `; <em>+${s.skillsToDevelop.length - 5} more</em>` : ''}</div>` : ''}
        </li>`).join('')}
    </ol>`;
  scrollToPoint(pts[0]);
}

// ---------- setup ----------

function applyZoom() {
  if (!svg) return;
  svg.setAttribute('width', mapW * zoom);
  svg.setAttribute('height', mapH * zoom);
  $('#zoom-reset').textContent = Math.round(zoom * 100) + '%';
}

function buildControls() {
  for (const f of DATA.families) $('#category').add(new Option(f.name, f.id));
  for (const g of DATA.meta.gradeOrder.slice(1, 9)) $('#grade').add(new Option(g, g));

  const from = $('#from'), to = $('#to');
  from.add(new Option('Choose a starting role level…', ''));
  to.add(new Option('Choose a destination role…', ''));
  for (const f of DATA.families) {
    const og = document.createElement('optgroup'); og.label = f.name;
    const og2 = document.createElement('optgroup'); og2.label = f.name;
    for (const id of f.roleIds) {
      const r = roleById.get(id);
      for (const l of r.levels) og.appendChild(new Option(l.name === r.name ? r.name : `${r.name}: ${l.name}`, l.id));
      og2.appendChild(new Option(r.name, r.id));
    }
    from.appendChild(og); to.appendChild(og2);
  }

  const legend = $('#legend');
  legend.innerHTML = DATA.families.map((f) =>
    `<button class="ghost" data-family="${esc(f.id)}" aria-pressed="true"><span class="swatch" style="background:${colour(f.id)}"></span>${esc(f.name)}</button>`).join('');
  legend.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.family;
    hiddenFamilies.has(id) ? hiddenFamilies.delete(id) : hiddenFamilies.add(id);
    b.setAttribute('aria-pressed', String(!hiddenFamilies.has(id)));
    render();
  }));

  $('#search-form').addEventListener('submit', runSearch);
  $('#clear').addEventListener('click', () => { $('#search-form').reset(); runSearch(); });
  $('#route').addEventListener('click', planRoute);
  $('#clear-route').addEventListener('click', () => { layers.route.innerHTML = ''; $('#journey').innerHTML = ''; clearHighlight(); });
  $('#zoom-in').addEventListener('click', () => { zoom = Math.min(2.5, zoom + 0.15); applyZoom(); });
  $('#zoom-out').addEventListener('click', () => { zoom = Math.max(0.4, zoom - 0.15); applyZoom(); });
  $('#zoom-reset').addEventListener('click', () => { zoom = 1; applyZoom(); });
}

(async function init() {
  DATA = await fetch('/data/ddat-roles.json').then((r) => r.json());
  P = DATA.pathways;
  moveKeys = new Set(P.moves.map((m) => `${m.from}>${m.to}`));
  roleById = new Map(DATA.roles.map((r) => [r.id, r]));
  levelById = new Map(DATA.roles.flatMap((r) => r.levels.map((l) => [l.id, { ...l, roleId: r.id }])));
  linesByRole = new Map();
  for (const line of P.lines) {
    if (!linesByRole.has(line.roleId)) linesByRole.set(line.roleId, {});
    linesByRole.get(line.roleId)[line.track] = line;
  }
  const skillNames = new Map(DATA.skills.map((k) => [k.id, k.name]));
  skillName = (id) => skillNames.get(id) || id;
  buildControls();
  render();

  // Deep links: ?role=data-analyst  or  ?from=<level id>&to=<role id>
  const qs = new URLSearchParams(location.search);
  if (qs.get('role') && roleById.has(qs.get('role'))) selectRole(qs.get('role'));
  if (qs.get('from') && qs.get('to')) { $('#from').value = qs.get('from'); $('#to').value = qs.get('to'); planRoute(); }
})();
