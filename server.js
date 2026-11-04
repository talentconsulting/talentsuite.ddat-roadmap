#!/usr/bin/env node
'use strict';
/**
 * DDaT career tube map — zero-dependency Node server.
 *   node server.js            -> http://localhost:3000
 *   PORT=8080 node server.js
 *
 * API
 *   GET /api/families
 *   GET /api/roles                         all roles (summary)
 *   GET /api/roles/:id                     full role incl. levels and skills
 *   GET /api/search?q=&category=&role=&skill=&grade=&limit=
 *   GET /api/skills?q=
 *   GET /api/pathway?from=<level|role id>&to=<level|role id>
 *   GET /data/ddat-roles.json              the full dataset
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ddat = require('./lib/ddat');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const summary = (r) => ({
  id: r.id, name: r.name, family: r.family, familyId: r.familyId,
  isSeniorCivilService: r.isSeniorCivilService, summary: r.summary, url: r.url,
  levels: r.levels.map((l) => ({ id: l.id, name: l.name, track: l.track, grades: l.grades.map((g) => g.code) })),
});

const routes = {
  '/api/families': () => ddat.data.families,
  '/api/roles': () => ddat.data.roles.map(summary),
  '/api/search': (p) => ddat.search({
    q: p.get('q'), category: p.get('category'), role: p.get('role'),
    skill: p.get('skill'), grade: p.get('grade'), limit: Number(p.get('limit')) || 100,
  }),
  '/api/skills': (p) => ddat.searchSkills({ q: p.get('q') }),
  '/api/pathway': (p) => ddat.findPathway(p.get('from'), p.get('to')),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (routes[url.pathname]) return json(res, 200, routes[url.pathname](url.searchParams));
    const roleMatch = url.pathname.match(/^\/api\/roles\/([a-z0-9-]+)$/);
    if (roleMatch) {
      const { searchText, ...role } = ddat.getRole(roleMatch[1]) || {};
      return role.id ? json(res, 200, role) : json(res, 404, { error: 'Role not found' });
    }
    if (url.pathname === '/data/ddat-roles.json') return sendFile(res, path.join(__dirname, 'data', 'ddat-roles.json'));

    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'Forbidden' });
    return sendFile(res, file);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`DDaT tube map running at http://localhost:${PORT}`));
