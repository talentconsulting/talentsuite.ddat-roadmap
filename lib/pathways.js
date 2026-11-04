'use strict';
/**
 * Pre-computes career pathways at build time, so consumers only need to read
 * and visualise them.
 *
 * Output (stored as `pathways` in data/ddat-roles.json):
 *   moveTypes : what each kind of move means
 *   lines     : ordered stops for every role track (the tube "lines")
 *   moves     : every single career move between two role levels (the map's edges)
 *   routes    : routes[fromLevelId][toRoleId] = [move index, ...], the best route
 *               from each level to every other reachable role
 */

const SKILL_RANK = { awareness: 1, working: 2, practitioner: 3, expert: 4 };
const rank = (lvl) => SKILL_RANK[String(lvl || '').toLowerCase()] || 0;

const MOVE_TYPES = {
  progress: { label: 'Progress', description: 'Next level in the same role and track', cost: 1 },
  branch: { label: 'Move to management track', description: 'Equivalent level on the role\'s management track', cost: 1 },
  transfer: { label: 'Change line', description: 'Sideways move to a role that shares skills, at an overlapping grade', cost: null },
  promote: { label: 'Step up to SCS', description: 'From the most senior levels of a role into a Senior Civil Service role it can lead to', cost: 1 },
};

// Transfers cost more than progressing in a role; more shared skills make them cheaper.
const transferCost = (shared) => Math.round((3 - Math.min(shared.length, 3) * 0.3) * 10) / 10;
const overlaps = (a, b) => a && b && a.min <= b.max && b.min <= a.max;

/** Skills the target level needs that the source level lacks, or needs at a higher proficiency. */
function skillsToDevelop(fromLevel, toLevel) {
  const have = new Map(fromLevel.skills.map((s) => [s.id, s.level]));
  return toLevel.skills
    .filter((s) => Math.max(rank(s.level), 1) > rank(have.get(s.id)))
    .map((s) => ({ skillId: s.id, from: have.get(s.id) ?? null, to: s.level }));
}

function buildPathways(roles) {
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const levelById = new Map();
  for (const r of roles) for (const l of r.levels) levelById.set(l.id, { role: r, level: l });

  // ---- lines ----
  const lines = [];
  for (const r of roles) {
    const core = r.levels.filter((l) => l.track !== 'management');
    lines.push({ id: `${r.id}:core`, roleId: r.id, familyId: r.familyId, track: 'core', branchFrom: null, stops: core.map((l) => l.id) });
    const mgmt = r.levels.filter((l) => l.track === 'management');
    if (mgmt.length) {
      lines.push({ id: `${r.id}:management`, roleId: r.id, familyId: r.familyId, track: 'management', branchFrom: mgmt[0].branchOf, stops: mgmt.map((l) => l.id) });
    }
  }

  // ---- moves ----
  const moves = [];
  const seen = new Set();
  const add = (from, to, type, extra = {}) => {
    const key = `${from}>${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    const a = levelById.get(from).level, b = levelById.get(to).level;
    moves.push({
      from, to, type,
      fromRoleId: levelById.get(from).role.id,
      toRoleId: levelById.get(to).role.id,
      cost: extra.cost ?? MOVE_TYPES[type].cost,
      sharedSkills: extra.sharedSkills || [],
      skillsToDevelop: skillsToDevelop(a, b),
    });
  };

  for (const line of lines) {
    for (let i = 0; i + 1 < line.stops.length; i++) add(line.stops[i], line.stops[i + 1], 'progress');
    if (line.branchFrom) add(line.branchFrom, line.stops[0], 'branch');
  }
  // Management levels branch off their own core equivalents too (not just the first one)
  for (const r of roles) for (const l of r.levels) if (l.branchOf) add(l.branchOf, l.id, 'branch');

  for (const r of roles) {
    if (r.isSeniorCivilService) continue;
    // "Shares skills" is listed on one side only, so treat it as symmetric
    const related = new Map(r.relatedRoles.map((x) => [x.id, x.sharedSkills]));
    for (const other of roles) {
      const back = other.relatedRoles.find((x) => x.id === r.id);
      if (back && !related.has(other.id)) related.set(other.id, back.sharedSkills);
    }
    for (const [otherId, shared] of related) {
      const other = roleById.get(otherId);
      if (!other || other.isSeniorCivilService) continue;
      for (const a of r.levels) for (const b of other.levels) {
        if (overlaps(a.gradeRank, b.gradeRank)) add(a.id, b.id, 'transfer', { sharedSkills: shared, cost: transferCost(shared) });
      }
    }
  }

  for (const r of roles) {
    const top = Math.max(...r.levels.map((l) => l.gradeRank?.max ?? 0));
    for (const t of r.leadsTo) {
      const scs = roleById.get(t.id);
      if (!scs) continue;
      for (const l of r.levels.filter((x) => x.gradeRank?.max === top)) add(l.id, scs.levels[0].id, 'promote');
    }
  }

  // ---- routes: Dijkstra from every level, keep the best route into every other role ----
  const out = new Map();
  moves.forEach((m, i) => { if (!out.has(m.from)) out.set(m.from, []); out.get(m.from).push(i); });

  const routes = {};
  for (const [startId, { role: startRole }] of levelById) {
    const dist = new Map([[startId, 0]]);
    const via = new Map(); // levelId -> move index used to arrive
    const done = new Set();
    const queue = [[0, startId]];
    while (queue.length) {
      let bi = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i][0] < queue[bi][0]) bi = i;
      const [d, u] = queue.splice(bi, 1)[0];
      if (done.has(u)) continue;
      done.add(u);
      for (const mi of out.get(u) || []) {
        const m = moves[mi];
        const nd = Math.round((d + m.cost) * 10) / 10;
        if (nd < (dist.get(m.to) ?? Infinity)) { dist.set(m.to, nd); via.set(m.to, mi); queue.push([nd, m.to]); }
      }
    }
    // For each destination role, the cheapest-to-reach level of that role (ties -> earliest level)
    const best = new Map();
    for (const [lid, d] of dist) {
      const { role, level } = levelById.get(lid);
      if (role.id === startRole.id) continue;
      const cur = best.get(role.id);
      if (!cur || d < cur.d || (d === cur.d && level.order < cur.order)) best.set(role.id, { lid, d, order: level.order });
    }
    const fromRoutes = {};
    for (const [roleId, { lid }] of best) {
      const path = [];
      for (let at = lid; via.has(at); at = moves[via.get(at)].from) path.unshift(via.get(at));
      fromRoutes[roleId] = path;
    }
    routes[startId] = fromRoutes;
  }

  return { moveTypes: MOVE_TYPES, lines, moves, routes };
}

module.exports = { buildPathways, skillsToDevelop, MOVE_TYPES };
