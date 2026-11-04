#!/usr/bin/env node
/**
 * Builds data/ddat-roles.json from the Government Digital and Data Profession
 * Capability Framework (https://understand-digital-data-roles-skills.service.gov.uk/).
 *
 * Sources:
 *   - /download/roles.csv  : role family, role, levels, skills per level (official export)
 *   - /download/skills.csv : skill definitions at every proficiency level
 *   - /role/<slug>/        : level order, Civil Service grades, related roles,
 *                            SCS progression (not present in the CSVs)
 *
 * Usage: node scripts/build-data.js                  fetch everything and rebuild
 *        node scripts/build-data.js --pathways-only   recompute pathways from the existing JSON
 */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { buildPathways } = require('../lib/pathways');

const BASE = 'https://understand-digital-data-roles-skills.service.gov.uk';
const OUT = path.join(__dirname, '..', 'data', 'ddat-roles.json');
const CONCURRENCY = 4;

// Civil Service grades in ascending seniority. Used to place stations on the map.
const GRADE_ORDER = ['AA', 'AO', 'EO', 'HEO', 'SEO', 'G7', 'G6', 'SCS 1', 'SCS 2', 'SCS 3', 'SCS 4'];
const SKILL_LEVELS = ['Awareness', 'Working', 'Practitioner', 'Expert'];

// ---------- helpers ----------

async function get(url, attempt = 1) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ddat-roles-builder/1.0' } });
  if (!res.ok) {
    if (attempt < 4 && res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      return get(url, attempt + 1);
    }
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  return res.text();
}

/** RFC 4180 CSV parser (handles quoted fields, embedded newlines and "" escapes). */
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows.filter((r) => r.some((v) => v.trim() !== ''));
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const slugify = (s) =>
  s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const decode = (s) =>
  s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');

const stripTags = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Split "Intro text.\n\nAt this role level, you will:\n- a\n- b" into summary + bullet list. */
function splitDescription(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^[-•]/.test(l)).map((l) => l.replace(/^[-•]\s*/, ''));
  const prose = lines.filter((l) => !/^[-•]/.test(l));
  return { summary: prose.join(' '), responsibilities: bullets };
}

/** Return the HTML between an element with the given id and the next <h2>. */
function section(html, id) {
  const start = html.indexOf(`id="${id}"`);
  if (start < 0) return '';
  const rest = html.slice(start);
  const end = rest.indexOf('<h2', 10);
  return end < 0 ? rest : rest.slice(0, end);
}

const roleLinks = (html) =>
  [...html.matchAll(/href="\/role\/([^/"]+)\/?"[^>]*>([^<]+)<\/a>/g)].map((m) => ({
    slug: m[1], name: decode(m[2]).trim(),
  }));

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ---------- scraping ----------

/** Role families and role slugs from the home page navigation. */
async function fetchNavigation() {
  const html = await get(`${BASE}/`);
  const families = [];
  for (const m of html.matchAll(/<nav class="role-nav__group" aria-label="([^"]+)">([\s\S]*?)<\/nav>/g)) {
    const label = decode(m[1]);
    if (label === 'Home') continue;
    families.push({ name: label, roles: roleLinks(m[2]) });
  }
  return families;
}

function parseGrades(chunk) {
  const list = chunk.match(/Civil Service job grade<\/a> of:[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/);
  if (!list) return [];
  return [...list[1].matchAll(/<li>([^<]+)<\/li>/g)].map((g) => {
    const t = decode(g[1]).trim();
    return { code: (t.match(/^([^(]+?)\s*\(/) || [, t])[1].trim(), name: (t.match(/\(([^)]+)\)/) || [, t])[1] };
  });
}

/** Fallback seniority guess from a level's title, used only when the site publishes no grade. */
function inferRankFromName(name) {
  const n = name.toLowerCase();
  const r = (a, b) => ({ min: GRADE_ORDER.indexOf(a), max: GRADE_ORDER.indexOf(b) });
  if (/apprentice|trainee/.test(n)) return r('AO', 'EO');
  if (/associate|junior/.test(n)) return r('EO', 'HEO');
  if (/^head of/.test(n)) return r('G6', 'G6');
  if (/principal|lead/.test(n)) return r('G7', 'G6');
  if (/senior/.test(n)) return r('SEO', 'G7');
  return r('HEO', 'SEO');
}

/** Details only available on the role's own page. */
async function fetchRolePage(slug) {
  const html = await get(`${BASE}/role/${slug}/`);
  const levels = [];
  const headers = [...html.matchAll(/<h3 class="govuk-heading-m role-level-header" id="([^"]+)">\s*(\d+)\.\s*([^<]+)<\/h3>/g)];
  headers.forEach((h, idx) => {
    const chunk = html.slice(h.index, headers[idx + 1]?.index ?? html.indexOf('id="related-roles"'));
    const grades = parseGrades(chunk);
    levels.push({ slug: h[1], order: Number(h[2]), name: decode(h[3]).trim(), grades });
  });

  const sharedTable = section(html, 'related-roles').includes('Shared skills')
    ? section(html, 'related-roles')
    : section(html, 'roles-that-shares');
  const sharedSkills = [...sharedTable.matchAll(/<tr class="govuk-table__row">([\s\S]*?)<\/tr>/g)]
    .map((r) => {
      const role = roleLinks(r[1])[0];
      if (!role) return null;
      const skills = [...r[1].matchAll(/href="\/skills\/#[^"]*"[^>]*>([^<]+)<\/a>/g)].map((s) => decode(s[1]).trim());
      return { ...role, sharedSkills: skills };
    })
    .filter(Boolean);

  const leadsTo = roleLinks(section(html, 'related-scs-roles'));
  // On SCS pages, "related-roles" is a plain list of roles that lead into this one.
  const relatedSection = section(html, 'related-roles');
  const ledFrom = /could lead to/.test(relatedSection.slice(0, 300)) ? roleLinks(relatedSection) : [];

  const intro = html.match(/<p class="govuk-body-l[^"]*">([\s\S]*?)<\/p>/);
  const updated = html.match(/Last updated ([0-9]{1,2} [A-Z][a-z]+ [0-9]{4})/);
  // SCS pages have no numbered levels, just one grade list for the role.
  const roleGrades = headers.length ? [] : parseGrades(html.slice(0, html.indexOf('id="role-levels"') + 1 || undefined));
  return {
    levels, sharedSkills, roleGrades, leadsTo, ledFrom,
    intro: intro ? stripTags(intro[1]) : '',
    lastUpdated: updated ? updated[1] : null,
  };
}

// ---------- build ----------

async function main() {
  console.log('Fetching CSV exports…');
  const [rolesCsv, skillsCsv, nav] = await Promise.all([
    get(`${BASE}/download/roles.csv`), get(`${BASE}/download/skills.csv`), fetchNavigation(),
  ]);
  const roleRows = parseCsv(rolesCsv);
  const skillRows = parseCsv(skillsCsv);
  console.log(`  ${roleRows.length} role rows, ${skillRows.length} skills, ${nav.length} families`);

  // Skills catalogue
  const skills = skillRows.map((s) => ({
    id: slugify(s['Skill Name']),
    name: s['Skill Name'],
    description: s['Skill Description'],
    levels: Object.fromEntries(SKILL_LEVELS.map((l) => [l.toLowerCase(), splitDescription(s[l] || '').responsibilities.length
      ? splitDescription(s[l]).responsibilities : (s[l] ? [s[l]] : [])])),
    roles: (s['Roles that require Skill'] || '').split(/\r?\n|;|,(?=\s*[A-Z])/).map((r) => r.trim()).filter(Boolean),
  }));
  const skillByName = new Map(skills.map((s) => [s.name.toLowerCase(), s]));

  // Group CSV rows: role -> level -> skills
  const byRole = new Map();
  for (const r of roleRows) {
    const key = r.Role;
    if (!byRole.has(key)) {
      byRole.set(key, {
        family: r['Role Family'], name: r.Role, description: r['Role Description'],
        roleType: r['Role Type'] || '', levels: new Map(),
      });
    }
    const role = byRole.get(key);
    if (r['Role Type']) role.roleType = r['Role Type'];
    const notInUse = (v) => !v || /^not in use$/i.test(v);
    const levelName = notInUse(r['Role Level']) ? r.Role : r['Role Level'];
    if (!role.levels.has(levelName)) {
      role.levels.set(levelName, {
        name: levelName,
        description: notInUse(r['Role Level Description']) ? '' : r['Role Level Description'],
        skills: [],
      });
    }
    if (r['Skill Name']) {
      role.levels.get(levelName).skills.push({
        id: slugify(r['Skill Name']),
        name: r['Skill Name'],
        level: notInUse(r['Skill Level']) ? null : r['Skill Level'],
        description: notInUse(r['Skill Level Description']) ? r['Skill Description'] : r['Skill Level Description'],
      });
    }
  }

  // Map nav slugs by role name so we can fetch each role page
  const navRoles = nav.flatMap((f) => f.roles.map((r) => ({ ...r, family: f.name })));
  const slugByName = new Map(navRoles.map((r) => [r.name.toLowerCase(), r.slug]));

  console.log(`Fetching ${navRoles.length} role pages…`);
  const pages = new Map();
  await pool(navRoles, CONCURRENCY, async (r) => {
    try { pages.set(r.slug, await fetchRolePage(r.slug)); process.stdout.write('.'); }
    catch (e) { console.warn(`\n  ! ${r.slug}: ${e.message}`); }
  });
  console.log();

  const roles = [];
  for (const role of byRole.values()) {
    const slug = slugByName.get(role.name.toLowerCase()) || slugify(role.name);
    const page = pages.get(slug) || { levels: [], sharedSkills: [], leadsTo: [], ledFrom: [], roleGrades: [] };
    const isScs = /senior civil service|scs/i.test(role.roleType) || page.ledFrom.length > 0;
    const pageLevelByName = new Map(page.levels.map((l) => [l.name.toLowerCase(), l]));

    let levels = [...role.levels.values()].map((l, i) => {
      const p = pageLevelByName.get(l.name.toLowerCase());
      const { summary, responsibilities } = splitDescription(l.description || '');
      const grades = (p?.grades?.length ? p.grades : (isScs ? page.roleGrades : [])) ?? [];
      const rank = grades.map((g) => GRADE_ORDER.indexOf(g.code)).filter((n) => n >= 0);
      const track = / - management$/i.test(l.name) ? 'management' : 'core';
      return {
        id: `${slug}--${p?.slug || slugify(l.name)}`,
        name: l.name,
        order: p?.order ?? i + 1,
        track,
        branchOf: null,
        summary,
        responsibilities,
        grades,
        gradeRank: rank.length ? { min: Math.min(...rank), max: Math.max(...rank) } : null,
        gradeInferred: false,
        skills: l.skills,
      };
    });
    levels.sort((a, b) => a.order - b.order);

    for (const l of levels) {
      if (l.track === 'management') {
        // "Senior developer - management" branches off "Senior developer"
        const base = levels.find((b) => b.name.toLowerCase() === l.name.replace(/ - management$/i, '').toLowerCase());
        if (base) {
          l.branchOf = base.id;
          if (!l.gradeRank && base.gradeRank) { l.gradeRank = { ...base.gradeRank }; l.gradeInferred = true; }
        }
      }
      if (!l.gradeRank) {
        l.gradeRank = isScs ? { min: GRADE_ORDER.indexOf('SCS 1'), max: GRADE_ORDER.indexOf('SCS 2') } : inferRankFromName(l.name);
        l.gradeInferred = true;
      }
    }

    const { summary, responsibilities } = splitDescription(role.description || page.intro || '');
    const skillIds = [...new Set(levels.flatMap((l) => l.skills.map((s) => s.id)))];
    const out = {
      id: slug,
      name: role.name,
      family: role.family,
      familyId: slugify(role.family),
      isSeniorCivilService: isScs,
      url: `${BASE}/role/${slug}/`,
      lastUpdated: page.lastUpdated || null,
      summary,
      responsibilities,
      levels,
      skillIds,
      relatedRoles: page.sharedSkills.map((r) => ({ id: r.slug, name: r.name, sharedSkills: r.sharedSkills })),
      leadsTo: page.leadsTo.map((r) => ({ id: r.slug, name: r.name })),
      ledFrom: page.ledFrom.map((r) => ({ id: r.slug, name: r.name })),
    };
    // Flattened, lowercased text for simple full-text search
    out.searchText = [
      out.name, out.family, out.summary, ...out.responsibilities,
      ...levels.flatMap((l) => [l.name, l.summary, ...l.responsibilities, ...l.skills.map((s) => s.name)]),
    ].join(' ').toLowerCase().replace(/\s+/g, ' ');
    roles.push(out);
  }

  // Make leadsTo symmetric with SCS pages' ledFrom lists
  const byId = new Map(roles.map((r) => [r.id, r]));
  for (const scs of roles.filter((r) => r.ledFrom.length)) {
    for (const from of scs.ledFrom) {
      const src = byId.get(from.id);
      if (src && !src.leadsTo.some((t) => t.id === scs.id)) src.leadsTo.push({ id: scs.id, name: scs.name });
    }
  }

  // Families in site navigation order
  const families = nav
    .map((f) => {
      const roleIds = f.roles.map((r) => r.slug).filter((id) => byId.has(id));
      const name = roleIds.length ? byId.get(roleIds[0]).family : f.name;
      return { id: slugify(name), name, navLabel: f.name, roleIds };
    })
    .filter((f) => f.roleIds.length);
  const missing = navRoles.filter((r) => !byId.has(r.slug));
  if (missing.length) console.warn('  ! In navigation but not in CSV:', missing.map((m) => m.slug).join(', '));

  for (const s of skills) {
    s.roleIds = roles.filter((r) => r.skillIds.includes(s.id)).map((r) => r.id);
    delete s.roles;
  }
  const unknownSkills = new Set(roles.flatMap((r) => r.skillIds).filter((id) => !skills.some((s) => s.id === id)));

  const doc = {
    meta: {
      source: BASE,
      licence: 'Open Government Licence v3.0',
      generatedAt: new Date().toISOString(),
      counts: { families: families.length, roles: roles.length, levels: roles.reduce((n, r) => n + r.levels.length, 0), skills: skills.length },
      gradeOrder: GRADE_ORDER,
      skillLevels: SKILL_LEVELS,
    },
    families,
    roles,
    skills,
  };
  if (unknownSkills.size) console.warn(`  ! ${unknownSkills.size} skills referenced by roles but not in skills.csv`);
  await write(doc);
}

async function write(doc) {
  console.log('Computing pathways…');
  doc.pathways = buildPathways(doc.roles);
  doc.meta.counts.lines = doc.pathways.lines.length;
  doc.meta.counts.moves = doc.pathways.moves.length;
  doc.meta.counts.routes = Object.values(doc.pathways.routes).reduce((n, r) => n + Object.keys(r).length, 0);

  // Pretty-print, but keep arrays of numbers (route move indexes) on one line,
  // and flat objects (e.g. skill gaps, grades) on a single line.
  const json = JSON.stringify(doc, null, 2)
    .replace(/\[\s+([\d,\s]+?)\s+\]/g, (_, n) => `[${n.replace(/\s+/g, '')}]`)
    .replace(/\{\n\s+([^{}[\]]*?)\n\s+\}/g, (_, body) => `{ ${body.replace(/,\n\s+/g, ', ')} }`);
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, json);
  console.log(`Wrote ${OUT} (${(json.length / 1e6).toFixed(1)} MB)`);
  console.log(doc.meta.counts);
}

async function pathwaysOnly() {
  const doc = JSON.parse(await fs.readFile(OUT, 'utf8'));
  doc.meta.pathwaysGeneratedAt = new Date().toISOString();
  await write(doc);
}

(process.argv.includes('--pathways-only') ? pathwaysOnly() : main()).catch((e) => { console.error(e); process.exit(1); });
