'use strict';
/**
 * Search and pathway-finding over data/ddat-roles.json.
 * Used by server.js, and usable on its own:
 *   const ddat = require('./lib/ddat'); ddat.search({ q: 'python', category: 'data' })
 */
const path = require('node:path');
const fs = require('node:fs');

const DATA_FILE = path.join(__dirname, '..', 'data', 'ddat-roles.json');
let data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

const norm = (s) => String(s ?? '').toLowerCase().trim();

let roleById, levelById, skillById;
function index() {
  roleById = new Map(data.roles.map((r) => [r.id, r]));
  levelById = new Map();
  for (const r of data.roles) for (const l of r.levels) levelById.set(l.id, { role: r, level: l });
  skillById = new Map(data.skills.map((s) => [s.id, s]));
}
index();

function reload() { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); index(); }

/** Match a family by id, exact name, or "<name> roles". */
function matchesCategory(role, category) {
  const c = norm(category).replace(/ roles$/, '');
  return !c || role.familyId === c || norm(role.family) === c;
}

function matchesRole(role, query) {
  const q = norm(query);
  return !q || role.id === q || norm(role.name).includes(q) || role.levels.some((l) => norm(l.name).includes(q));
}

/**
 * Search roles.
 * @param {object} p
 * @param {string} [p.q]        free text, all words must match (role, level, responsibilities, skill names)
 * @param {string} [p.category] family id or name, e.g. "data" or "Data roles"
 * @param {string} [p.role]     role id, or text matched against role and level names
 * @param {string} [p.skill]    skill id or text matched against skill names
 * @param {string} [p.grade]    Civil Service grade code, e.g. "SEO", "G7"
 * @param {number} [p.limit]
 */
function search({ q, category, role, skill, grade, limit = 100 } = {}) {
  const words = norm(q).split(/\s+/).filter(Boolean);
  const skillQ = norm(skill);
  const gradeIdx = grade ? data.meta.gradeOrder.findIndex((g) => norm(g) === norm(grade)) : -1;

  const results = [];
  for (const r of data.roles) {
    if (!matchesCategory(r, category) || !matchesRole(r, role)) continue;
    if (words.length && !words.every((w) => r.searchText.includes(w))) continue;

    const levels = r.levels.filter((l) => {
      if (skillQ && !l.skills.some((s) => s.id === skillQ || norm(s.name).includes(skillQ))) return false;
      if (gradeIdx >= 0 && !(l.gradeRank && l.gradeRank.min <= gradeIdx && gradeIdx <= l.gradeRank.max)) return false;
      if (words.length) {
        const text = norm([l.name, l.summary, ...l.responsibilities, ...l.skills.map((s) => s.name)].join(' '));
        // Keep the level if it matches any word; role-level matches still keep the role.
        return words.some((w) => text.includes(w));
      }
      return true;
    });
    if ((skillQ || gradeIdx >= 0) && !levels.length) continue;

    let score = 0;
    for (const w of words) {
      if (norm(r.name).includes(w)) score += 10;
      if (norm(r.family).includes(w)) score += 3;
      if (norm(r.summary).includes(w)) score += 2;
      score += levels.length * 0.1;
    }
    results.push({
      id: r.id,
      name: r.name,
      family: r.family,
      familyId: r.familyId,
      isSeniorCivilService: r.isSeniorCivilService,
      summary: r.summary,
      url: r.url,
      score,
      matchingLevels: levels.map((l) => ({
        id: l.id, name: l.name, grades: l.grades.map((g) => g.code), gradeInferred: l.gradeInferred,
      })),
    });
  }
  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { total: results.length, results: results.slice(0, limit) };
}

function searchSkills({ q, limit = 50 } = {}) {
  const words = norm(q).split(/\s+/).filter(Boolean);
  const out = data.skills.filter((s) => {
    const t = norm(`${s.name} ${s.description}`);
    return words.every((w) => t.includes(w));
  });
  return { total: out.length, results: out.slice(0, limit) };
}

const getRole = (id) => roleById.get(id) || null;
const getLevel = (id) => levelById.get(id) || null;

/** Precomputed by scripts/build-data.js (lib/pathways.js). */
const pathways = () => data.pathways;

/** Moves along a role's own line from one level to a later level, or null. */
function alongLine(fromLevelId, toLevelId) {
  const line = pathways().lines.find((l) => l.stops.includes(fromLevelId) && l.stops.includes(toLevelId));
  if (!line) return null;
  const a = line.stops.indexOf(fromLevelId), b = line.stops.indexOf(toLevelId);
  if (b < a) return null;
  const idx = [];
  for (let i = a; i < b; i++) {
    const mi = pathways().moves.findIndex((m) => m.from === line.stops[i] && m.to === line.stops[i + 1]);
    if (mi < 0) return null;
    idx.push(mi);
  }
  return idx;
}

/** Turn move indexes into readable steps. */
function describe(startLevelId, moveIdx) {
  const moves = moveIdx.map((i) => pathways().moves[i]);
  const lv = (id) => { const x = levelById.get(id); return { levelId: id, level: x.level.name, roleId: x.role.id, role: x.role.name, grades: x.level.grades.map((g) => g.code) }; };
  return {
    found: true,
    start: lv(startLevelId),
    cost: Math.round(moves.reduce((n, m) => n + m.cost, 0) * 10) / 10,
    stops: [startLevelId, ...moves.map((m) => m.to)],
    moves: moveIdx,
    steps: moves.map((m) => ({
      type: m.type,
      label: pathways().moveTypes[m.type].label,
      from: lv(m.from),
      to: lv(m.to),
      sharedSkills: m.sharedSkills,
      skillsToDevelop: m.skillsToDevelop.map((s) => ({ ...s, name: skillById.get(s.skillId)?.name || s.skillId })),
    })),
  };
}

/**
 * Look up the precomputed route.
 * @param {string} from  level id, or role id (starts at its first level)
 * @param {string} to    role id, or level id (route into that role, then along its line to the level)
 */
function findPathway(from, to) {
  const start = roleById.get(from)?.levels[0].id ?? from;
  if (!levelById.has(start)) throw new Error(`Unknown start: ${from}`);
  const toLevel = levelById.get(to);
  const toRoleId = roleById.has(to) ? to : toLevel?.role.id;
  if (!toRoleId) throw new Error(`Unknown destination: ${to}`);

  const startRoleId = levelById.get(start).role.id;
  let idx;
  if (startRoleId === toRoleId) {
    idx = toLevel ? alongLine(start, to) : [];
  } else {
    idx = pathways().routes[start]?.[toRoleId];
    if (idx && toLevel) {
      const entry = idx.length ? pathways().moves[idx.at(-1)].to : start;
      const rest = entry === to ? [] : alongLine(entry, to);
      idx = rest ? [...idx, ...rest] : null;
    }
  }
  return idx ? describe(start, idx) : { found: false, steps: [] };
}

/** All moves out of (or into) a level or role, for drawing connections. */
function movesFor(id, { direction = 'out', type } = {}) {
  const key = direction === 'in' ? (roleById.has(id) ? 'toRoleId' : 'to') : (roleById.has(id) ? 'fromRoleId' : 'from');
  return pathways().moves
    .map((m, index) => ({ index, ...m }))
    .filter((m) => m[key] === id && (!type || m.type === type));
}

module.exports = {
  get data() { return data; },
  reload, search, searchSkills, getRole, getLevel, findPathway, movesFor,
  skill: (id) => skillById.get(id) || null,
};
