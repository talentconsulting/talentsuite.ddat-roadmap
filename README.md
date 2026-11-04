# DDaT Career Map

A searchable JSON dataset of every role in the
[Government Digital and Data Profession Capability Framework](https://understand-digital-data-roles-skills.service.gov.uk/),
plus a small Node app that draws the roles as a tube map and plans career routes between them.

No npm dependencies. It needs Node 18 or later.

```bash
npm run build:data   # (re)fetch the framework -> data/ddat-roles.json
node scripts/build-data.js --pathways-only   # recompute pathways only, no fetching
npm start            # http://localhost:3000   (PORT=8080 npm start to change)
```

### Docker

```bash
docker compose up -d --build                  # http://localhost:3000  (PORT=8080 docker compose up -d to change)
docker compose run --rm refresh-data          # re-fetch the framework into ./data
docker compose restart app                    # pick up the refreshed data
```

`./data` is mounted into the container, so you only rebuild the image when the code changes.

### Render

`render.yaml` is a Render Blueprint. In Render, choose **New → Blueprint**, pick this GitHub repo, and click **Apply**. Every push to `main` then redeploys the app.

The app serves the committed `data/ddat-roles.json`. To update it, run `npm run build:data` locally, then commit and push.

## Data: `data/ddat-roles.json`

The data comes from the framework's official CSV exports (`/download/roles.csv` and `/download/skills.csv`).
Each role page adds the things the CSVs don't include: level order, Civil Service grades, related roles and Senior Civil Service (SCS) progression.

```jsonc
{
  "meta": { "source", "licence", "generatedAt", "counts", "gradeOrder": ["AA","AO","EO","HEO","SEO","G7","G6","SCS 1",...], "skillLevels" },
  "families": [ { "id": "data", "name": "Data", "navLabel": "Data roles", "roleIds": ["analytics-engineer", ...] } ],
  "roles": [ {
    "id": "data-analyst", "name": "Data analyst",
    "family": "Data", "familyId": "data",           // search by category
    "isSeniorCivilService": false,
    "url": "https://.../role/data-analyst/", "lastUpdated": "29 August 2025",
    "summary": "...", "responsibilities": ["..."],
    "levels": [ {
      "id": "data-analyst--associate-data-analyst", "name": "Associate data analyst",
      "order": 1,
      "track": "core",                               // or "management" (software dev / DevOps)
      "branchOf": null,                              // management levels point at their core level
      "summary": "...", "responsibilities": ["..."],
      "grades": [ { "code": "EO", "name": "Executive Officer" }, ... ],
      "gradeRank": { "min": 2, "max": 3 },           // indexes into meta.gradeOrder
      "gradeInferred": false,                        // true = no grade published, so it is estimated
      "skills": [ { "id": "data-management", "name": "Data management", "level": "Awareness", "description": "You can: ..." } ]
    } ],
    "skillIds": ["..."],
    "relatedRoles": [ { "id": "data-governance-manager", "name": "...", "sharedSkills": ["..."] } ],
    "leadsTo":  [ { "id": "chief-data-officer", "name": "Chief data officer" } ],   // SCS roles this can lead to
    "ledFrom":  [],                                                                // on SCS roles: roles that lead here
    "searchText": "lower-cased text of the role, levels, responsibilities and skill names"
  } ],
  "skills": [ { "id", "name", "description", "levels": { "awareness": [], "working": [], "practitioner": [], "expert": [] }, "roleIds": [] } ],
  "pathways": {                                      // precomputed by lib/pathways.js; consumers only read and draw these
    "moveTypes": { "progress": { "label", "description", "cost" }, "branch": {...}, "transfer": {...}, "promote": {...} },
    "lines": [                                       // the tube lines: ordered stops per role track
      { "id": "software-developer:core", "roleId", "familyId", "track": "core", "branchFrom": null, "stops": ["<level id>", ...] },
      { "id": "software-developer:management", "track": "management", "branchFrom": "<core level id>", "stops": [...] }
    ],
    "moves": [                                       // every single career move (the map's edges)
      { "from": "<level id>", "to": "<level id>", "type": "transfer", "fromRoleId", "toRoleId", "cost": 2.7,
        "sharedSkills": ["Data management"],
        "skillsToDevelop": [ { "skillId": "data-governance", "from": null, "to": "Working" } ] }
    ],
    "routes": {                                      // best route from every level into every other reachable role
      "<from level id>": { "<to role id>": [12, 340, 3151] }   // indexes into "moves", in order
    }
  }
}
```

### Pathways

The build computes pathways once, so the UI and any other consumer only look them up:

| Move type | Meaning | Cost |
|---|---|---|
| `progress` | The next level in the same role and track | 1 |
| `branch` | From a core level to the same level on the management track (software developer, DevOps) | 1 |
| `transfer` | A sideways move to a role that shares skills, at an overlapping grade. Pairs come from the framework's "roles that share skills" lists, treated as two-way | 2.1 to 2.7 (more shared skills is cheaper) |
| `promote` | From a role's most senior levels into an SCS role it "could lead to" | 1 |

`routes` holds the lowest-cost route (Dijkstra) from each of the 210 levels to every other role it can reach. It ends at the cheapest way into the destination role. A route within the same role just follows that role's line.

To draw a route: `routes[from][toRole].map(i => moves[i])`. The stops are the start, followed by each move's `to`.

For a simple client-side search, filter `roles` by `familyId` (category) and by `id`/`name` (role), and check `searchText.includes(term)` for text.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/search?q=&category=&role=&skill=&grade=&limit=` | Search roles. `q` matches all words; `category` takes a family id or name; `grade` takes a code such as `SEO` |
| `GET /api/skills?q=` | Search the skills catalogue |
| `GET /api/families` | List the categories |
| `GET /api/roles`, `GET /api/roles/:id` | Get role summaries, or one full role |
| `GET /api/pathway?from=<level or role id>&to=<role or level id>` | Look up the precomputed route, with names and the skills to develop at each step |
| `GET /data/ddat-roles.json` | Download the full dataset |

`lib/ddat.js` exports the same `search`, `searchSkills`, `findPathway` and `movesFor` functions for direct use in Node.

## The tube map

- **Lines** are roles, coloured by family. **Stations** are role levels, placed in Civil Service grade columns from AO to SCS. A dashed ring means the grade is estimated.
- **Management branches** (software developer, DevOps) run as a spur below the core line.
- **Dashed curves** link roles to the SCS roles they can lead to.
- **Click a role or station** to see its details. The map then shows the transfers to roles that share its skills.
- **Everything is drawn from `pathways`:** lines from `lines`, SCS links from `promote` moves, the connectors for a selected role from its `transfer` moves, and journeys from `routes`. The UI computes no pathways itself.
- **Deep links:** `/?role=data-analyst` or `/?from=software-developer--junior-developer&to=chief-technology-officer`.

Routes are suggestions built from the framework's "shares skills" and "could lead to" links. They are not official career paths.

Data © Crown copyright, [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
