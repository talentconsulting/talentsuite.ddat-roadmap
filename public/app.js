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
const L = { left: 225, colW: 128, top: 56, familyH: 34, rowH: 46, mgmtExtra: 26, minGap: 74, right: 60 };

const NS = 'http://www.w3.org/2000/svg';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

let DATA, P, roleById, levelById, linesByRole, levelPos = new Map(), roleRow = new Map(), svg, layers = {};
let skillName = (id) => id;
let zoom = 1, mapW = 0, mapH = 0, hiddenFamilies = new Set();

const colour = (familyId, i = 0) => FAMILY_COLOURS[familyId] || FALLBACK[i % FALLBACK.length];

/** Short station label: the seniority prefix, e.g. "Senior data analyst" -> "Senior". */
const PREFIX = /^(apprentice|trainee|associate|junior|senior|lead|principal|head of|chief|major)\b/i;
function shortLabel(level) {
  const m = level.name.match(PREFIX);
  const s = m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : level.name;
  return s.length > 14 ? s.slice(0, 13) + '…' : s;
}

// Grade index -> x (AO = 1 is the first column; SCS 1 = 7 is the last)
const SCS_COL = 7;
const gradeX = (rank) => {
  const mid = rank.min >= SCS_COL ? SCS_COL : Math.min((rank.min + rank.max) / 2, SCS_COL - 1);
  return L.left + (mid - 1) * L.colW + L.colW / 2;
};

function layout() {
  levelPos = new Map(); roleRow = new Map();
  let y = L.top;
  const families = DATA.families.filter((f) => !hiddenFamilies.has(f.id));
  const rows = [];
  for (const f of families) {
    rows.push({ type: 'family', family: f, y });
    y += L.familyH;
    for (const id of f.roleIds) {
      const role = roleById.get(id);
      const hasMgmt = Boolean(linesByRole.get(id).management);
      const rowY = y + L.rowH / 2 - 6;
      roleRow.set(id, { y: rowY, family: f });
      // Core track: x from grade, strictly increasing so stations never overlap
      const { core, management } = linesByRole.get(id);
      let prevX = -Infinity;
      for (const l of core.stops.map((s) => levelById.get(s))) {
        const x = Math.max(gradeX(l.gradeRank), prevX + L.minGap);
        levelPos.set(l.id, { x, y: rowY, role, level: l });
        prevX = x;
      }
      // Management track runs parallel, just below its core equivalent
      let prevM = -Infinity;
      for (const l of (management?.stops || []).map((s) => levelById.get(s))) {
        const base = levelPos.get(l.branchOf);
        const x = Math.max(base ? base.x + 22 : gradeX(l.gradeRank), prevM + L.minGap);
        levelPos.set(l.id, { x, y: rowY + L.mgmtExtra, role, level: l });
        prevM = x;
      }
      rows.push({ type: 'role', role, y: rowY });
      y += L.rowH + (hasMgmt ? L.mgmtExtra : 0);
    }
    y += 6;
  }
  mapW = Math.max(L.left + 7 * L.colW + L.right, ...[...levelPos.values()].map((p) => p.x + L.right));
  mapH = y + 20;
  return rows;
}

function render() {
  const rows = layout();
  const host = $('#map');
  host.innerHTML = '';
  svg = el('svg', { viewBox: `0 0 ${mapW} ${mapH}`, role: 'img', 'aria-label': 'Tube map of digital and data career pathways' }, host);
  applyZoom();

  // Grade columns
  const grid = el('g', {}, svg);
  DATA.meta.gradeOrder.slice(1, 8).forEach((g, i) => {
    const x = L.left + i * L.colW + L.colW / 2;
    el('line', { x1: L.left + i * L.colW, x2: L.left + i * L.colW, y1: 30, y2: mapH, class: 'grid' }, grid);
    const label = i === 6 ? 'SCS' : g;
    el('text', { x, y: 24, 'text-anchor': 'middle', class: 'grade-label' }, grid).textContent = label;
  });

  layers.scs = el('g', {}, svg);
  layers.lines = el('g', {}, svg);
  layers.overlay = el('g', {}, svg);
  layers.route = el('g', {}, svg);

  for (const r of rows) {
    if (r.type === 'family') {
      const t = el('text', { x: 14, y: r.y + 22, class: 'family-label', fill: colour(r.family.id) }, layers.lines);
      t.textContent = r.family.name;
      continue;
    }
    drawRole(r.role, r.y);
  }
  drawScsLinks();
}

function drawRole(role, y) {
  const c = colour(role.familyId);
  const g = el('g', { class: 'role', 'data-role': role.id }, layers.lines);
  const { core: coreLine, management: mgmtLine } = linesByRole.get(role.id);
  const core = coreLine.stops.map((id) => levelPos.get(id));
  const mgmt = (mgmtLine?.stops || []).map((id) => levelPos.get(id));

  const label = el('text', { x: 24, y: y + 4, class: 'role-label' }, g);
  label.textContent = role.name.length > 32 ? role.name.slice(0, 31) + '…' : role.name;
  el('title', {}, label).textContent = role.name;
  label.addEventListener('click', () => selectRole(role.id));

  const x1 = core[0].x - 18, x2 = core[core.length - 1].x + 18;
  el('line', { x1, x2, y1: y, y2: y, stroke: c, 'stroke-width': 8, 'stroke-linecap': 'round' }, g);
  if (mgmt.length) {
    const base = levelPos.get(mgmtLine.branchFrom) || core[0];
    const d = `M${base.x},${y} C${base.x + 14},${y} ${base.x + 8},${mgmt[0].y} ${mgmt[0].x},${mgmt[0].y} L${mgmt[mgmt.length - 1].x + 14},${mgmt[0].y}`;
    el('path', { d, stroke: c, 'stroke-width': 5, fill: 'none', 'stroke-linecap': 'round', opacity: 0.75 }, g);
  }

  for (const p of [...core, ...mgmt]) {
    const isScs = role.isSeniorCivilService;
    const s = el('circle', {
      cx: p.x, cy: p.y, r: isScs ? 10 : 7, stroke: isScs ? 'var(--ink)' : c, 'stroke-width': isScs ? 4 : 3,
      class: 'station' + (p.level.gradeInferred ? ' inferred' : ''), 'data-level': p.level.id, tabindex: 0,
    }, g);
    const grades = p.level.grades.map((x) => x.code).join(', ') || 'not published';
    el('title', {}, s).textContent = `${p.level.name}\nGrade: ${grades}${p.level.gradeInferred ? ' (position estimated)' : ''}\n${p.level.skills.length} skills`;
    s.addEventListener('click', () => selectRole(role.id, p.level.id));
    s.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectRole(role.id, p.level.id); });
    if (!isScs) {
      const t = el('text', { x: p.x, y: p.y + 20, 'text-anchor': 'middle', class: 'stop-label' }, g);
      t.textContent = shortLabel(p.level);
    }
  }
}

/** Dashed connectors for the precomputed "promote" moves into Senior Civil Service roles. */
function drawScsLinks() {
  // One connector per role pair, from the right-most (most senior) departing station
  const best = new Map();
  for (const m of P.moves) {
    if (m.type !== 'promote') continue;
    const a = levelPos.get(m.from), b = levelPos.get(m.to);
    if (!a || !b) continue;
    const key = `${m.fromRoleId}>${m.toRoleId}`;
    if (!best.has(key) || a.x > best.get(key).a.x) best.set(key, { m, a, b });
  }
  for (const { m, a, b } of best.values()) {
    const mx = Math.max(a.x, b.x - 60) + 30;
    el('path', {
      d: `M${a.x + 18},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x - 10},${b.y}`,
      class: 'scs-link', 'data-from': m.fromRoleId, 'data-to': m.toRoleId,
    }, layers.scs);
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
  for (const id of ids) svg.querySelector(`.role[data-role="${id}"]`)?.classList.add('hl');
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
  svg.querySelectorAll(`.scs-link[data-from="${id}"], .scs-link[data-to="${id}"]`).forEach((n) => n.classList.add('hl'));

  // Draw one transfer connector per neighbouring role: the move with the shortest hop
  const best = new Map();
  for (const m of moves.filter((x) => x.type === 'transfer')) {
    const pa = levelPos.get(m.from), pb = levelPos.get(m.to);
    if (!pa || !pb) continue;
    const other = m.fromRoleId === id ? m.toRoleId : m.fromRoleId;
    const d = Math.abs(pa.x - pb.x);
    if (!best.has(other) || d < best.get(other).d) best.set(other, { pa, pb, d });
  }
  for (const { pa, pb } of best.values()) {
    el('path', { d: `M${pa.x},${pa.y} C${pa.x + 30},${(pa.y + pb.y) / 2} ${pb.x - 30},${(pa.y + pb.y) / 2} ${pb.x},${pb.y}`, class: 'transfer' }, layers.overlay);
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
  const d = pts.map((p, i) => {
    if (!i) return `M${p.x},${p.y}`;
    const q = pts[i - 1];
    return q.y === p.y ? `L${p.x},${p.y}` : `C${q.x + 40},${q.y} ${p.x - 40},${p.y} ${p.x},${p.y}`;
  }).join(' ');
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
