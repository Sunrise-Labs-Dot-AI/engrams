# Handoff: Milestone 2 — Next.js Dashboard

**Repo:** `Sunrise-Labs-Dot-AI/engrams`
**Branch:** `main`
**Budget:** $10
**Timeout:** 25 min
**Prerequisite:** Milestone 1 complete — MCP server + SQLite + FTS5 working

## Context

Engrams has a working MCP server (Milestone 1). Now we build the consumer control surface: a Next.js dashboard served on localhost that lets users browse, search, and manage their AI memories visually. This is the feature that differentiates Engrams from developer-only MCP memory tools — nobody else ships a consumer-grade UI for AI memory.

Read `CLAUDE.md` in the repo root for full product context and coding standards.

## Architecture

The dashboard is a separate Next.js app (`packages/dashboard`) that reads from the same SQLite database the MCP server uses. Communication happens via a lightweight HTTP API.

**Two options for data access (pick one during implementation):**

1. **HTTP API on the MCP server** — Add an Express/Hono HTTP endpoint to the MCP server process that serves JSON API routes alongside stdio. Dashboard fetches from `localhost:3838/api/*`. Simpler, one process.
2. **Direct SQLite read** — Dashboard opens the same `~/.engrams/engrams.db` in read-only mode via better-sqlite3. Writes go through the MCP server's HTTP API. Better for reads, avoids round-trip.

Option 2 is recommended: direct reads for browsing/search, HTTP POST for mutations (confirm, correct, flag, delete). The MCP server just needs a small HTTP mutation endpoint.

## Step 1: Add Dashboard Package

```
packages/dashboard/
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx              # / — Memory browser
│   │   ├── memory/
│   │   │   └── [id]/
│   │   │       └── page.tsx      # /memory/[id] — Detail view
│   │   ├── agents/
│   │   │   └── page.tsx          # /agents — Permission management
│   │   └── settings/
│   │       └── page.tsx          # /settings — Export, config
│   ├── components/
│   │   ├── ui/                   # Button, Card, Modal, Toggle, StatusBadge
│   │   ├── memory-card.tsx       # Memory card with confidence bar, actions
│   │   ├── memory-list.tsx       # Domain-grouped memory list
│   │   ├── search-bar.tsx        # FTS5 search input
│   │   ├── domain-filter.tsx     # Domain filter pills
│   │   ├── confidence-bar.tsx    # Visual confidence indicator
│   │   ├── event-timeline.tsx    # Memory audit trail
│   │   ├── connection-graph.tsx  # Memory relationships (simple)
│   │   └── nav.tsx               # Sidebar navigation
│   ├── lib/
│   │   ├── db.ts                 # Read-only SQLite connection
│   │   ├── api.ts                # HTTP client for mutations
│   │   └── utils.ts              # Formatters, helpers
│   └── globals.css               # Tailwind v4 + CSS variables
├── tailwind.config.ts
├── next.config.mjs
├── package.json
└── tsconfig.json
```

### Dependencies

```json
{
  "name": "@engrams/dashboard",
  "private": true,
  "dependencies": {
    "next": "^15.5.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "@engrams/core": "workspace:*",
    "better-sqlite3": "latest",
    "clsx": "^2.1.0",
    "lucide-react": "latest"
  },
  "devDependencies": {
    "typescript": "^5",
    "tailwindcss": "^4.2.0",
    "@tailwindcss/postcss": "^4.2.0",
    "@types/better-sqlite3": "latest",
    "@types/react": "latest",
    "@types/react-dom": "latest"
  }
}
```

## Step 2: Tailwind + Theme Setup

Reuse Sitter's Tailwind v4 pattern — CSS custom properties for all colors, semantic token names.

**`globals.css`:**
```css
@import "tailwindcss";
@config "../tailwind.config.ts";

:root {
  /* Neutral palette — clean, tool-like aesthetic */
  --color-bg: #fafafa;
  --color-bg-soft: #f4f4f5;
  --color-card: #ffffff;
  --color-card-hover: #fafafa;
  --color-accent: #6d28d9;        /* Purple — knowledge/memory association */
  --color-accent-solid: #6d28d9;
  --color-accent-soft: rgba(109, 40, 217, 0.08);
  --color-accent-text: #5b21b6;
  --color-text: #18181b;
  --color-text-secondary: #52525b;
  --color-text-muted: #a1a1aa;
  --color-border: #e4e4e7;
  --color-border-light: #f4f4f5;
  --color-success: #16a34a;
  --color-success-bg: #f0fdf4;
  --color-warning: #d97706;
  --color-warning-bg: #fffbeb;
  --color-danger: #dc2626;
  --color-danger-bg: #fef2f2;
}

.dark {
  --color-bg: #18181b;
  --color-bg-soft: #27272a;
  --color-card: #27272a;
  --color-card-hover: #3f3f46;
  --color-accent: #a78bfa;
  --color-accent-solid: #7c3aed;
  --color-accent-soft: rgba(167, 139, 250, 0.12);
  --color-accent-text: #c4b5fd;
  --color-text: #fafafa;
  --color-text-secondary: #a1a1aa;
  --color-text-muted: #71717a;
  --color-border: #3f3f46;
  --color-border-light: #27272a;
  --color-success: #22c55e;
  --color-success-bg: rgba(34, 197, 94, 0.1);
  --color-warning: #f59e0b;
  --color-warning-bg: rgba(245, 158, 11, 0.1);
  --color-danger: #ef4444;
  --color-danger-bg: rgba(239, 68, 68, 0.1);
}
```

**`tailwind.config.ts`:** Follow Sitter's pattern — all colors reference CSS variables, semantic fontFamily, custom borderRadius.

## Step 3: UI Components

Copy Sitter's component patterns. Key components to build:

### Button (`components/ui/button.tsx`)
Same variant pattern as Sitter: `primary | secondary | danger | ghost`, sizes `sm | md | lg`. Use `clsx`, extend `ButtonHTMLAttributes`.

### Card (`components/ui/card.tsx`)
Same as Sitter: `bg-card border border-border rounded-card`, optional hover state.

### Additional UI primitives:
- **Modal** — dialog overlay for confirm/correct actions
- **Toggle** — for boolean settings (dark mode, permissions)
- **StatusBadge** — for confidence levels and source types

## Step 4: Dashboard Routes

### `/` — Memory Browser (home)

The primary view. Shows all memories grouped by domain, with search and filtering.

**Layout:**
- Top bar: "Engrams" title, search input, domain filter pills, sort toggle (confidence / recent)
- Main content: Domain-grouped memory cards
- Each card shows: content, confidence bar, source agent badge, learned_at, expand arrow
- Expanded card shows: detail, source description, feedback buttons (confirm/correct/flag/delete)

**Data loading:** Server component reads directly from SQLite via `@engrams/core`. Use `getMemoriesByDomain()` utility. Search uses FTS5 via the core package.

### `/memory/[id]` — Memory Detail

Full detail view for a single memory:
- Content + detail (editable)
- Confidence score with visual bar
- Source attribution (agent name, source type, description)
- Counter stats (confirmed_count, corrected_count, mistake_count, used_count)
- Event timeline (from memory_events table, chronological)
- Connected memories (from memory_connections, clickable links)
- Actions: confirm, correct, flag mistake, delete

### `/agents` — Agent Permissions

Table view of agent_permissions:
- Rows: each unique agent_id (with agent_name from memories)
- Columns: domain toggles (read/write per domain)
- Add permission button
- Bulk actions (grant all, revoke all for a domain)

### `/settings` — Settings & Export

- **Export:** JSON export of all memories (download button)
- **Database info:** file path, size, memory count, domain count
- **Theme toggle:** light/dark mode
- **Danger zone:** clear all memories (with confirmation modal)

## Step 5: HTTP Mutation API

Add a minimal HTTP server to the MCP server package for dashboard write operations:

```typescript
// packages/mcp-server/src/http.ts
import { createServer } from "http";

export function startHttpApi(db: DrizzleDB, port = 3838) {
  const server = createServer(async (req, res) => {
    // CORS headers for localhost dashboard
    res.setHeader("Access-Control-Allow-Origin", "http://localhost:3000");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    
    if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }
    
    // Routes:
    // POST /api/memory/:id/confirm
    // POST /api/memory/:id/correct  { content: string }
    // POST /api/memory/:id/flag
    // POST /api/memory/:id/delete
    // POST /api/memory/:id/update   { content?, detail?, domain? }
    // POST /api/permissions         { agentId, domain, canRead, canWrite }
  });
  
  server.listen(port);
}
```

The MCP server's `startServer()` function should call `startHttpApi()` alongside the stdio transport setup.

## Step 6: Dashboard Dev Server

```bash
cd packages/dashboard
pnpm dev  # → localhost:3000
```

The dashboard should:
- Read from `~/.engrams/engrams.db` directly (read-only better-sqlite3 connection)
- POST mutations to `localhost:3838/api/*`

Configure `next.config.mjs` with security headers (CSP, X-Frame-Options, etc. — copy from Sitter).

## Verification

### 1. Start both servers

```bash
# Terminal 1: MCP server (also serves HTTP API)
cd packages/mcp-server && node dist/cli.js --http

# Terminal 2: Dashboard
cd packages/dashboard && pnpm dev
```

### 2. Test dashboard at localhost:3000

Prerequisite: Have some memories in the database from Milestone 1 testing.

1. **Home page loads** — memories displayed grouped by domain
2. **Search works** — type a query, results filter in real-time via FTS5
3. **Domain filter** — click a domain pill, only that domain's memories show
4. **Expand card** — click a memory, detail + actions appear
5. **Confirm** — click confirm button, confidence increases, event logged
6. **Correct** — click correct, enter new content, confidence resets to 0.50
7. **Flag mistake** — click flag, confidence decreases
8. **Delete** — click delete, memory soft-deleted, disappears from list
9. **Detail page** — click through to `/memory/[id]`, see full detail + event timeline
10. **Agents page** — shows agent permissions table
11. **Settings page** — export works (downloads JSON), dark mode toggle works
12. **No console errors** on any page

### 3. Cross-check with MCP

After making changes via the dashboard, verify they're visible via MCP tools in Claude Code:
- Confirm a memory in dashboard → `memory_search` in Claude Code shows updated confidence
- Write a memory via Claude Code → refresh dashboard, new memory appears

## Design Notes

- **Color palette:** Purple accent (#6d28d9) — connotes knowledge, memory, intellect. Zinc neutrals for UI chrome.
- **Typography:** System fonts (Inter-like sans-serif). No custom font loading needed for V1.
- **Layout:** Single-column responsive. No sidebar nav needed for 4 routes — use a top nav or minimal sidebar.
- **Interactions:** Optimistic UI for mutations. Show toast/sonner notifications on success/error.
- **Empty states:** Helpful empty states on each page (e.g., "No memories yet. Start chatting with an AI tool that has Engrams connected.")
