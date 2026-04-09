# Handoff: V2 — Knowledge Graph Visualization

**Repo:** `Sunrise-Labs-Dot-AI/engrams` (local at `~/Documents/Claude/Projects/engrams`)
**Branch:** `main`
**Budget:** $8
**Timeout:** 20 min

## Context

Engrams now has entity types (person, organization, place, project, preference, event, goal, fact), typed relationships (works_at, involves, located_at, part_of, about, related, supports, contradicts, influences), and auto-connections between entities. The `/graph` route was deferred from V1 but the data is rich enough now.

Read `CLAUDE.md` in the repo root for full product context.

**Key files:**
- `packages/dashboard/src/components/nav.tsx` — nav links array, add `/graph` entry with a `Network` icon from lucide-react
- `packages/dashboard/src/lib/db.ts` — `getMemoryConnections()` exists but is per-memory. Need a global graph query.
- `packages/dashboard/src/components/connection-graph.tsx` — existing list-based connection display on detail page. Leave it as-is.
- `packages/dashboard/src/components/ui/` — button, card, status-badge, modal, toggle
- `packages/core/src/schema.ts` — `memoryConnections` table: source_memory_id, target_memory_id, relationship

**No graph visualization library is installed.** Dashboard uses Next.js 15, React 19, Tailwind v4, lucide-react, clsx.

## What We're Building

A `/graph` page with an interactive force-directed knowledge graph. Nodes are memories (grouped/colored by entity type), edges are connections (labeled by relationship type).

### 1. Install D3

```bash
cd packages/dashboard && pnpm add d3 && pnpm add -D @types/d3
```

D3 over React Flow or vis-network because: lighter weight, no layout opinions, force simulation is exactly what we need, and it's the standard. Use `d3-force` for layout + `d3-selection` for rendering into an SVG.

### 2. Global Graph Data Query

Add to `packages/dashboard/src/lib/db.ts`:

```typescript
export interface GraphNode {
  id: string;
  content: string;
  entity_type: string | null;
  entity_name: string | null;
  domain: string;
  confidence: number;
  connectionCount: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relationship: string;
}

export function getGraphData(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const db = getReadDb();

  // Get all non-deleted memories that have at least one connection
  const connectedIds = db.prepare(`
    SELECT DISTINCT id FROM memories
    WHERE deleted_at IS NULL AND id IN (
      SELECT source_memory_id FROM memory_connections
      UNION
      SELECT target_memory_id FROM memory_connections
    )
  `).all() as { id: string }[];

  // If there are no connections at all, fall back to showing all memories
  const nodes = connectedIds.length > 0
    ? db.prepare(`
        SELECT m.id, m.content, m.entity_type, m.entity_name, m.domain, m.confidence,
          (SELECT COUNT(*) FROM memory_connections mc
           WHERE mc.source_memory_id = m.id OR mc.target_memory_id = m.id) as connectionCount
        FROM memories m
        WHERE m.deleted_at IS NULL AND m.id IN (
          SELECT source_memory_id FROM memory_connections
          UNION
          SELECT target_memory_id FROM memory_connections
        )
        ORDER BY connectionCount DESC
      `).all() as GraphNode[]
    : db.prepare(`
        SELECT m.id, m.content, m.entity_type, m.entity_name, m.domain, m.confidence, 0 as connectionCount
        FROM memories m WHERE m.deleted_at IS NULL
        ORDER BY m.confidence DESC LIMIT 50
      `).all() as GraphNode[];

  const edges = db.prepare(`
    SELECT mc.source_memory_id as source, mc.target_memory_id as target, mc.relationship
    FROM memory_connections mc
    JOIN memories m1 ON m1.id = mc.source_memory_id AND m1.deleted_at IS NULL
    JOIN memories m2 ON m2.id = mc.target_memory_id AND m2.deleted_at IS NULL
  `).all() as GraphEdge[];

  return { nodes, edges };
}
```

### 3. Create `/graph` Page

Create `packages/dashboard/src/app/graph/page.tsx`:

```typescript
import { getGraphData } from "@/lib/db";
import { KnowledgeGraph } from "@/components/knowledge-graph";

export const dynamic = "force-dynamic";

export default async function GraphPage() {
  const { nodes, edges } = getGraphData();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Knowledge Graph</h1>
        <p className="text-sm text-[var(--color-text-secondary)]">
          {nodes.length} entities · {edges.length} connections
        </p>
      </div>
      <KnowledgeGraph nodes={nodes} edges={edges} />
    </div>
  );
}
```

### 4. Create `KnowledgeGraph` Component

Create `packages/dashboard/src/components/knowledge-graph.tsx` as a client component.

This is the core of the feature. Requirements:

**Layout:**
- Force-directed simulation using `d3-force`
- `forceLink` with distance based on relationship type (contradicts = longer, supports/related = shorter)
- `forceManyBody` with charge proportional to node connection count (more connected = stronger repulsion = more central)
- `forceCenter` to center the graph
- `forceCollide` to prevent node overlap

**Nodes:**
- Circles, radius scaled by `connectionCount` (min 8, max 24)
- Color by `entity_type` using a consistent color map:
  - person: `#60a5fa` (blue)
  - organization: `#a78bfa` (purple)
  - place: `#34d399` (green)
  - project: `#fbbf24` (amber)
  - preference: `#f472b6` (pink)
  - event: `#fb923c` (orange)
  - goal: `#f87171` (red)
  - fact: `#94a3b8` (slate)
  - null/untyped: `#64748b` (gray)
- Opacity scaled by confidence (0.4 at confidence 0, 1.0 at confidence 1)
- Label: `entity_name` if available, otherwise truncated `content` (first 30 chars)
- Labels appear on hover or when zoomed in past a threshold

**Edges:**
- Lines between connected nodes
- Color by relationship type:
  - contradicts: `#ef4444` (red, dashed)
  - supports: `#22c55e` (green)
  - works_at / part_of / involves: `#60a5fa` (blue)
  - about / located_at: `#a78bfa` (purple)
  - related: `#64748b` (gray)
- Arrow heads showing direction
- Relationship label shown on hover

**Interactions:**
- **Pan and zoom** via d3-zoom
- **Drag nodes** to reposition (pauses simulation, resumes on release)
- **Hover** shows tooltip with: full content, entity_type, entity_name, domain, confidence, connection count
- **Click node** navigates to `/memory/[id]`

**Controls (top-right overlay):**
- Filter by entity type: checkboxes for each type, all checked by default
- Filter by relationship type: checkboxes
- "Reset view" button to re-center and re-run simulation
- Toggle labels on/off

**Legend (bottom-left overlay):**
- Color key for entity types (only types present in the data)
- Edge style key (solid vs dashed for contradicts)

**Responsive:**
- SVG fills the container, `width: 100%`, `height: calc(100vh - 12rem)` to fill below the nav
- Resize listener to update SVG dimensions

**Empty state:**
- If no connections exist and fewer than 5 memories: show a card explaining "Your knowledge graph will appear here as memories form connections. Write more memories or run cleanup to discover relationships."
- If memories exist but no connections: show all memories as unconnected nodes with a prompt "Run memory_classify to discover entity relationships"

### 5. Add Nav Link

In `packages/dashboard/src/components/nav.tsx`, add to the links array:

```typescript
{ href: "/graph", label: "Graph", icon: Network }
```

Import `Network` from `lucide-react`.

Place it after "Memories" and before "Cleanup" — it's a primary feature, not a utility.

### 6. Performance Considerations

- Cap the visualization at 200 nodes. If there are more, show the top 200 by connectionCount and add a "Showing 200 of N" indicator.
- Use `requestAnimationFrame` for simulation ticks, not d3's default timer (plays better with React).
- Stop simulation after it cools down (`simulation.on("end", ...)`) to save CPU.
- Use `will-change: transform` on the SVG group for GPU acceleration during pan/zoom.

## File Changes Summary

| File | Changes |
|------|---------|
| `packages/dashboard/package.json` | Add `d3` + `@types/d3` |
| `packages/dashboard/src/lib/db.ts` | Add `getGraphData()`, `GraphNode`, `GraphEdge` |
| `packages/dashboard/src/app/graph/page.tsx` | New: graph page (server component) |
| `packages/dashboard/src/components/knowledge-graph.tsx` | New: D3 force-directed graph (client component) |
| `packages/dashboard/src/components/nav.tsx` | Add Graph nav link |

## Verification

```bash
pnpm build && pnpm test
```

Then start the dev server (`pnpm dev` in packages/dashboard) and verify:
1. `/graph` route loads without errors
2. Nodes render with correct colors by entity type
3. Edges render between connected nodes
4. Drag, pan, zoom all work
5. Hover shows tooltip with memory details
6. Click navigates to memory detail page
7. Entity type filter checkboxes hide/show nodes
8. Empty state renders correctly if no connections exist
9. Labels are readable and don't overlap excessively

Commit and push when complete.
