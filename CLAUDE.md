# Engrams — Project Instructions

## Product Identity

- **Name:** Engrams
- **npm:** `engrams` (unscoped); `@engrams/core`, `@engrams/dashboard` (workspace packages)
- **Domain:** getengrams.com
- **GitHub:** Sunrise-Labs-Dot-AI/engrams
- **Tagline:** Universal, portable memory layer for AI agents with a consumer-grade control surface

## What Engrams Is

An open-source MCP server + localhost web dashboard that gives AI agents persistent, cross-tool memory with full user control. Any MCP-compatible tool (Claude Code, Cursor, Windsurf, Claude Desktop, Cline) connects to the same memory. Users browse, search, confirm, correct, and manage what their agents know through a real dashboard — not just chat commands.

## V1 Scope

**Ships:**
- MCP server (stdio transport) with ~12 tools (CRUD, search, confirm/correct/flag, connections, permissions)
- SQLite storage via better-sqlite3 + Drizzle ORM
- FTS5 full-text search
- Counter-based confidence (confirmed_count, corrected_count, mistake_count, used_count)
- Next.js localhost dashboard (memory browser, detail view, agent permissions, settings/export)
- npm distribution (`npx -y engrams`)

**Deferred to V2 (build only after V1 validates):**
- Embedding pipeline (Transformers.js + all-MiniLM-L6-v2)
- Vector search (sqlite-vec)
- Encryption (AES-256-GCM + scrypt KDF)
- Cloud sync (Turso embedded replicas)
- Hosted dashboard (Vercel + Clerk auth)
- Confidence decay formula (ship counters, derive formula from usage data)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| MCP Server | `@modelcontextprotocol/sdk`, TypeScript, Node.js, stdio transport |
| Database | `better-sqlite3`, Drizzle ORM (SQLite dialect), FTS5 |
| Dashboard | Next.js 15 (App Router), React 18, Tailwind v4, custom UI components |
| Testing | Vitest |
| Build | pnpm workspaces + Turborepo |
| Distribution | npm (`engrams` package), npx one-liner install |

## Repo Structure

```
engrams/
├── packages/
│   ├── core/             # @engrams/core — schema, types, confidence engine
│   ├── mcp-server/       # engrams (npm) — MCP server + CLI entry point
│   └── dashboard/        # @engrams/dashboard — Next.js localhost app
├── package.json          # pnpm workspace root
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.json         # Base TypeScript config
└── CLAUDE.md             # This file
```

## Data Directory

All runtime data lives in `~/.engrams/`:

```
~/.engrams/
├── engrams.db           # SQLite database (auto-created on first run)
├── config.json          # User preferences
└── credentials.json     # Device ID (mode 0600) — V2: + API key
```

## Database Schema (V1)

Five tables + one FTS5 virtual table:

- **memories** — core storage (id, content, detail, domain, source_agent_id/name, cross_agent_id/name, source_type, source_description, confidence, confirmed_count, corrected_count, mistake_count, used_count, learned_at, confirmed_at, last_used_at, deleted_at)
- **memory_connections** — relationship graph (source_memory_id, target_memory_id, relationship)
- **memory_events** — audit trail (memory_id, event_type, agent_id, old_value, new_value, timestamp)
- **agent_permissions** — per-agent read/write by domain (agent_id, domain, can_read, can_write)
- **memory_fts** — FTS5 virtual table over content, detail, source_agent_name

IDs are `hex(randomblob(16))`. Timestamps are ISO 8601 TEXT. Confidence is REAL 0-1. Soft deletes via deleted_at.

## MCP Tools (V1)

| Tool | Description |
|------|-------------|
| `memory_search` | FTS5 keyword search with domain/confidence filters |
| `memory_write` | Create memory with content, domain, source attribution |
| `memory_update` | Modify content, detail, or domain |
| `memory_remove` | Soft-delete with reason |
| `memory_confirm` | Increment confirmed_count, boost confidence |
| `memory_correct` | Replace content, increment corrected_count, reset confidence |
| `memory_flag_mistake` | Increment mistake_count, degrade confidence |
| `memory_connect` | Create typed relationship between memories |
| `memory_get_connections` | Get relationship graph for a memory |
| `memory_list_domains` | List all domains with counts |
| `memory_list` | Browse memories by domain, sorted by confidence or recency |
| `memory_set_permissions` | Configure per-agent read/write access by domain |

## Confidence Engine (V1 — Counter-Based)

Store counters on each memory: `confirmed_count`, `corrected_count`, `mistake_count`, `used_count`.

**Initial confidence by source type:**
- stated: 0.90
- observed: 0.75
- inferred: 0.65
- cross-agent: 0.70

**Updates:**
- confirm: `min(confidence + 0.05, 0.99)`
- correct: reset to 0.50
- mistake: `max(confidence - 0.15, 0.10)`
- used: `min(confidence + 0.02, 0.99)`

No decay in V1. Counters accumulate data to inform V2 formula.

## Sitter Reference Patterns

The Sitter codebase (`/Users/jamesheath/Desktop/sitter/`) provides proven patterns to reuse:

| Pattern | Sitter Source | How to Adapt |
|---------|--------------|-------------|
| Drizzle schema | `lib/db/schema.ts` | SQLite dialect (text IDs, no uuid type, integer booleans) |
| Encryption | `lib/crypto.ts` | V2 only — adapt for scrypt KDF instead of env var key |
| Tailwind v4 config | `tailwind.config.ts` + `app/globals.css` | Reuse color system, semantic tokens, dark mode |
| UI components | `components/ui/` (button, card, modal, toggle) | Copy and restyle — same variant/size pattern with clsx |
| Security headers | `next.config.mjs` | Copy CSP, HSTS, X-Frame-Options for dashboard |
| Testing | Vitest config | Same framework and patterns |

**Key conventions from Sitter:**
- `clsx` for conditional class merging (not `cn` or `classnames`)
- Variant + size lookup tables (`Record<Variant, string>`)
- CSS custom properties for all colors (never hardcoded hex in components)
- Extend native HTML attributes on component props
- Soft deletes with `deleted_at` timestamps

## Coding Standards

- TypeScript strict mode
- No `any` types — use proper generics or `unknown` + type guards
- All database queries through Drizzle ORM (no raw SQL except FTS5 setup)
- All timestamps as ISO 8601 strings in SQLite
- All IDs as `hex(randomblob(16))` — 32-char hex strings
- Error messages should be actionable ("ENCRYPTION_KEY not set" not "key error")
- No console.log in production paths — use structured logging if needed

## Key Constraints

- **No embeddings or sqlite-vec in V1.** FTS5 handles search until memory volume justifies the complexity.
- **No cloud sync in V1.** Local SQLite only. No Turso, no API keys, no accounts.
- **No encryption in V1.** Data is local; OS file permissions (0600) are sufficient.
- **No Clerk auth in V1.** Dashboard is localhost-only, no login required.
- **Dashboard reads from MCP server's HTTP API.** The MCP server exposes a lightweight HTTP endpoint alongside stdio for the dashboard to consume.

## Notion References

- Product page: `33d041760b7080628a3fcb3f7a00df17`
- System architecture: `33d041760b70817098a0d28cf778e3cf`
- Co-work instructions: `33d041760b7081c98eb3d19f89cfa002`
