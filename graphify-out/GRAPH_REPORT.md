# Graph Report - dieu-hanh-bus  (2026-11-05)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 42 nodes · 54 edges · 5 communities (4 shown, 1 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `65138949`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- server.js
- package.json
- cleanAndSyncData
- dependencies
- scripts

## God Nodes (most connected - your core abstractions)
1. `cleanAndSyncData()` - 7 edges
2. `getRawData()` - 3 edges
3. `getVietnamTodayISO()` - 3 edges
4. `parseDateToISO()` - 3 edges
5. `cors` - 3 edges
6. `express` - 3 edges
7. `mongoose` - 3 edges
8. `getVietnamTimeString()` - 2 edges
9. `parseTabDate()` - 2 edges
10. `saveRawData()` - 2 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Import Cycles
- None detected.

## Communities (5 total, 1 thin omitted)

### Community 0 - "server.js"
Cohesion: 0.12
Nodes (9): app, busDataSchema, BusModel, cors, dns, express, fs, mongoose (+1 more)

### Community 1 - "package.json"
Cohesion: 0.22
Nodes (8): author, description, keywords, license, main, name, type, version

### Community 2 - "cleanAndSyncData"
Cohesion: 0.29
Nodes (8): cleanAndSyncData(), getRawData(), getVietnamTimeString(), getVietnamTodayISO(), parseDateToISO(), parseTabDate(), saveRawData(), verifyAdmin()

### Community 3 - "dependencies"
Cohesion: 0.29
Nodes (7): dependencies, cors@^2.8.5, express@^4.19.2, mongoose@^9.11.0, cors, express, mongoose

## Knowledge Gaps
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `cors` connect `dependencies` to `server.js`, `package.json`?**
  _High betweenness centrality (0.154) - this node is a cross-community bridge._
- **Should `server.js` be split into smaller, more focused modules?**
  _Cohesion score 0.125 - nodes in this community are weakly interconnected._
- **Why does `express` connect `dependencies` to `server.js`, `package.json`?**
  _High betweenness centrality (0.154) - this node is a cross-community bridge._
- **Why does `mongoose` connect `dependencies` to `server.js`, `package.json`?**
  _High betweenness centrality (0.154) - this node is a cross-community bridge._