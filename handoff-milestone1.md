# Handoff: Milestone 1 — MCP Server + SQLite + FTS5

**Repo:** `Sunrise-Labs-Dot-AI/engrams`
**Branch:** `main`
**Budget:** $10
**Timeout:** 25 min

## Context

Engrams is a universal, portable memory layer for AI agents. This milestone bootstraps the repo and builds the core: an MCP server that AI tools connect to via stdio, backed by SQLite with FTS5 search. After this milestone, a user can add Engrams to their Claude Code (or Cursor, etc.) config and immediately start writing, searching, confirming, and correcting memories via chat.

Read `CLAUDE.md` in the repo root for full product context, schema details, and coding standards.

## Pre-flight

```bash
git clone git@github.com:Sunrise-Labs-Dot-AI/engrams.git
cd engrams
```

The repo should be empty or have only a README and CLAUDE.md. If CLAUDE.md isn't present, copy it from `documents/claude/projects/engrams/CLAUDE.md`.

## Step 1: Bootstrap Monorepo

Initialize pnpm workspace with Turborepo:

```
engrams/
├── packages/
│   ├── core/             # @engrams/core
│   └── mcp-server/       # engrams
├── package.json          # workspace root
├── pnpm-workspace.yaml   # packages: ["packages/*"]
├── turbo.json            # build + test pipeline
└── tsconfig.json         # base config (strict, ESNext, NodeNext)
```

**Root package.json:**
- `"private": true`
- `"packageManager": "pnpm@10.x"` (use latest 10.x)
- Scripts: `build`, `test`, `dev`, `lint`

**turbo.json:**
- `build`: depends on `^build`
- `test`: depends on `build`
- `dev`: persistent, cache disabled

## Step 2: packages/core (@engrams/core)

Shared schema, types, and confidence logic. No runtime dependencies beyond drizzle-orm.

### Dependencies
- `drizzle-orm` (latest)
- `better-sqlite3` (latest, peer dependency)
- Dev: `drizzle-kit`, `vitest`, `typescript`, `@types/better-sqlite3`

### Schema (`src/schema.ts`)

Use Drizzle ORM with SQLite dialect. Follow Sitter's patterns but adapted for SQLite:

```typescript
import { sqliteTable, text, real, integer } from "drizzle-orm/sqlite-core";

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),              // hex(randomblob(16))
  content: text("content").notNull(),
  detail: text("detail"),
  domain: text("domain").notNull().default("general"),
  sourceAgentId: text("source_agent_id").notNull(),
  sourceAgentName: text("source_agent_name").notNull(),
  crossAgentId: text("cross_agent_id"),
  crossAgentName: text("cross_agent_name"),
  sourceType: text("source_type").notNull(), // stated | inferred | observed | cross-agent
  sourceDescription: text("source_description"),
  confidence: real("confidence").notNull().default(0.7),
  confirmedCount: integer("confirmed_count").notNull().default(0),
  correctedCount: integer("corrected_count").notNull().default(0),
  mistakeCount: integer("mistake_count").notNull().default(0),
  usedCount: integer("used_count").notNull().default(0),
  learnedAt: text("learned_at"),
  confirmedAt: text("confirmed_at"),
  lastUsedAt: text("last_used_at"),
  deletedAt: text("deleted_at"),
});

export const memoryConnections = sqliteTable("memory_connections", {
  sourceMemoryId: text("source_memory_id").notNull().references(() => memories.id),
  targetMemoryId: text("target_memory_id").notNull().references(() => memories.id),
  relationship: text("relationship").notNull(), // influences | supports | contradicts | related | learned-together
});

export const memoryEvents = sqliteTable("memory_events", {
  id: text("id").primaryKey(),
  memoryId: text("memory_id").notNull().references(() => memories.id),
  eventType: text("event_type").notNull(), // created | confirmed | corrected | removed | confidence_changed | used
  agentId: text("agent_id"),
  agentName: text("agent_name"),
  oldValue: text("old_value"),   // JSON
  newValue: text("new_value"),   // JSON
  timestamp: text("timestamp").notNull(),
});

export const agentPermissions = sqliteTable("agent_permissions", {
  agentId: text("agent_id").notNull(),
  domain: text("domain").notNull(),  // '*' = all domains
  canRead: integer("can_read").notNull().default(1),
  canWrite: integer("can_write").notNull().default(1),
});
```

### Types (`src/types.ts`)

Export TypeScript types inferred from Drizzle schema plus input types for tool calls:

```typescript
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type MemoryEvent = typeof memoryEvents.$inferSelect;
export type SourceType = "stated" | "inferred" | "observed" | "cross-agent";
export type Relationship = "influences" | "supports" | "contradicts" | "related" | "learned-together";
export type EventType = "created" | "confirmed" | "corrected" | "removed" | "confidence_changed" | "used";
```

### Confidence (`src/confidence.ts`)

```typescript
const INITIAL_CONFIDENCE: Record<SourceType, number> = {
  stated: 0.90,
  observed: 0.75,
  inferred: 0.65,
  "cross-agent": 0.70,
};

export function getInitialConfidence(sourceType: SourceType): number {
  return INITIAL_CONFIDENCE[sourceType] ?? 0.70;
}

export function applyConfirm(current: number): number {
  return Math.min(current + 0.05, 0.99);
}

export function applyCorrect(): number {
  return 0.50;
}

export function applyMistake(current: number): number {
  return Math.max(current - 0.15, 0.10);
}

export function applyUsed(current: number): number {
  return Math.min(current + 0.02, 0.99);
}
```

### Database Init (`src/db.ts`)

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { resolve } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";
import * as schema from "./schema";

export function createDatabase(dbPath?: string) {
  const dir = resolve(homedir(), ".engrams");
  mkdirSync(dir, { recursive: true });
  const path = dbPath ?? resolve(dir, "engrams.db");
  const sqlite = new Database(path);
  
  // Enable WAL mode for better concurrent read performance
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  
  const db = drizzle(sqlite, { schema });
  
  // Run migrations / ensure tables exist
  // Use drizzle-kit push or manual CREATE TABLE statements
  
  return { db, sqlite };
}
```

### FTS5 Setup (`src/fts.ts`)

FTS5 requires raw SQL — Drizzle doesn't support virtual tables natively:

```typescript
export function setupFTS(sqlite: Database.Database) {
  // Create FTS5 virtual table
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      content,
      detail,
      source_agent_name,
      content='memories',
      content_rowid='rowid'
    );
  `);

  // Content-sync triggers (keep FTS in sync with memories table)
  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memory_fts(rowid, content, detail, source_agent_name)
      VALUES (new.rowid, new.content, new.detail, new.source_agent_name);
    END;
  `);

  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content, detail, source_agent_name)
      VALUES ('delete', old.rowid, old.content, old.detail, old.source_agent_name);
    END;
  `);

  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON memories BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content, detail, source_agent_name)
      VALUES ('delete', old.rowid, old.content, old.detail, old.source_agent_name);
      INSERT INTO memory_fts(rowid, content, detail, source_agent_name)
      VALUES (new.rowid, new.content, new.detail, new.source_agent_name);
    END;
  `);
}

export function searchFTS(sqlite: Database.Database, query: string, limit = 20): string[] {
  // Returns memory rowids matching the FTS query
  const rows = sqlite.prepare(`
    SELECT rowid FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?
  `).all(query, limit) as { rowid: number }[];
  return rows.map(r => String(r.rowid));
}
```

**Important:** FTS5 content-sync triggers use `content='memories'` which means FTS5 reads from the memories table. The triggers keep it in sync on INSERT/UPDATE/DELETE. The `rowid` is SQLite's implicit integer rowid, not the text `id` column. You'll need to join back to memories on rowid to get the full record.

### Tests

Write Vitest tests for:
- Confidence functions (all update paths)
- Database creation and table existence
- FTS5 search (insert a few memories, verify search returns correct results)

## Step 3: packages/mcp-server (engrams)

The npm package users install. Contains the MCP server, CLI entry point, and HTTP API for the dashboard.

### Dependencies
- `@modelcontextprotocol/sdk` (latest)
- `@engrams/core` (workspace dependency)
- `better-sqlite3`
- `zod` (for input validation)
- Dev: `typescript`, `vitest`

### package.json
```json
{
  "name": "engrams",
  "version": "0.1.0",
  "description": "Universal AI memory layer — MCP server with persistent, cross-tool memory",
  "bin": {
    "engrams": "./dist/cli.js"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "keywords": ["mcp", "memory", "ai", "agents", "claude", "cursor"],
  "license": "MIT",
  "repository": "Sunrise-Labs-Dot-AI/engrams"
}
```

### CLI Entry Point (`src/cli.ts`)

```typescript
#!/usr/bin/env node
import { startServer } from "./server.js";
startServer();
```

### MCP Server (`src/server.ts`)

Use `@modelcontextprotocol/sdk` to create the server:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDatabase, setupFTS } from "@engrams/core";

const server = new McpServer({
  name: "engrams",
  version: "0.1.0",
});

// Initialize database
const { db, sqlite } = createDatabase();
setupFTS(sqlite);

// Register tools
server.tool("memory_write", "Create a new memory", {
  content: z.string().describe("The memory content"),
  domain: z.string().optional().describe("Life domain (default: general)"),
  detail: z.string().optional().describe("Extended context"),
  sourceAgentId: z.string().describe("Your agent ID"),
  sourceAgentName: z.string().describe("Your agent name"),
  sourceType: z.enum(["stated", "inferred", "observed", "cross-agent"]),
  sourceDescription: z.string().optional(),
}, async (params) => {
  // Generate ID, set initial confidence, insert memory, log event, return result
});

server.tool("memory_search", "Search memories using keywords", {
  query: z.string().describe("Search query"),
  domain: z.string().optional(),
  minConfidence: z.number().optional(),
  limit: z.number().optional().default(20),
}, async (params) => {
  // FTS5 search, join back to memories table, filter by domain/confidence, return results
});

// ... implement all 12 tools from CLAUDE.md
```

**Implement all tools:**
1. `memory_write` — generate hex ID, set initial confidence from source_type, insert, log "created" event
2. `memory_search` — FTS5 MATCH query, join to memories, filter deleted_at IS NULL + domain + minConfidence
3. `memory_update` — update content/detail/domain, log "confidence_changed" event with old/new values
4. `memory_remove` — set deleted_at, log "removed" event
5. `memory_confirm` — increment confirmed_count, apply confidence boost, set confirmed_at, log event
6. `memory_correct` — update content, increment corrected_count, reset confidence to 0.50, log event
7. `memory_flag_mistake` — increment mistake_count, degrade confidence, log event
8. `memory_connect` — insert into memory_connections
9. `memory_get_connections` — query memory_connections for a given memory_id (both directions)
10. `memory_list_domains` — `SELECT domain, COUNT(*) FROM memories WHERE deleted_at IS NULL GROUP BY domain`
11. `memory_list` — browse by domain, paginated, sorted by confidence desc or learned_at desc
12. `memory_set_permissions` — upsert into agent_permissions

**Also register MCP resources:**
- `memory://index` — summary with domain counts, total memories, confidence distribution
- `memory://domain/{name}` — all memories in a domain
- `memory://recent` — last 20 memories by learned_at

### Server Startup

```typescript
export async function startServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

## Step 4: Build and Test

```bash
pnpm install
pnpm build
pnpm test
```

Ensure:
- `packages/core` builds and exports schema, types, confidence, db, fts
- `packages/mcp-server` builds and produces `dist/cli.js`
- All tests pass

## Verification

### 1. Add to Claude Code config

```bash
# Find your Claude Code MCP config (usually ~/.claude/config.json or similar)
# Add:
{
  "mcpServers": {
    "engrams": {
      "command": "node",
      "args": ["/absolute/path/to/engrams/packages/mcp-server/dist/cli.js"]
    }
  }
}
```

### 2. Test via Claude Code chat

In a Claude Code session, verify these work:

1. **Write:** "Remember that I prefer morning meetings before 10am" → should call `memory_write` and confirm storage
2. **Search:** "What do you know about my meeting preferences?" → should call `memory_search` and return the memory
3. **Confirm:** Confirm the memory → should call `memory_confirm`, confidence should increase
4. **Correct:** "Actually I prefer afternoon meetings" → should call `memory_correct`, confidence resets to 0.50
5. **List domains:** "What memory domains exist?" → should call `memory_list_domains`
6. **Flag mistake:** Flag a memory as incorrect → should call `memory_flag_mistake`, confidence should decrease

### 3. Verify database

```bash
sqlite3 ~/.engrams/engrams.db
.tables
# Should show: memories, memory_connections, memory_events, agent_permissions, memory_fts
SELECT * FROM memories;
SELECT * FROM memory_events;
```

## Notes

- The FTS5 rowid issue is the trickiest part. SQLite tables have an implicit integer rowid even when using a TEXT primary key. The FTS5 content-sync triggers operate on this rowid. When querying FTS5 results, join back to memories via `memories.rowid = fts_result.rowid`.
- Use `crypto.randomBytes(16).toString("hex")` for generating IDs (Node.js built-in).
- All tool handlers should return `{ content: [{ type: "text", text: JSON.stringify(result) }] }` per MCP spec.
- Set `chmod 0600` on the database file after creation for security.
