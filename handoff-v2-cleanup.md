# Handoff: V2 — Cleanup Page + Dashboard Polish

**Repo:** `Sunrise-Labs-Dot-AI/engrams` (local at `~/Documents/Claude/Projects/engrams`)
**Branch:** `main`
**Budget:** $10
**Timeout:** 25 min

## Context

Engrams V2 embeddings are complete: hybrid search (FTS5 + sqlite-vec + RRF), semantic dedup, backfill pipeline. The dashboard has been upgraded with LLM-powered actions (correct, split) using the Anthropic API. Server actions replaced the old HTTP API for dashboard mutations.

Read `CLAUDE.md` in the repo root for full product context.

**Current state of uncommitted work:**
- Embeddings pipeline (core: embeddings.ts, vec.ts, search.ts) — complete
- MCP `memory_split` tool — complete
- Proactive split suggestion on `memory_write` — complete (Haiku, 3+ sentences)
- Dashboard: dark mode default, LLM-powered correct (Sonnet), two-phase split (propose → review → confirm) — complete
- Dashboard: Server Actions for all mutations (delete, confirm, flag, correct, split, clear) — complete
- `next.config.mjs`: `outputFileTracingRoot` fix — complete

**What this handoff builds:** A `/cleanup` page — a "Merge & fix" feature like Google Contacts that scans all memories and surfaces actionable suggestions.

## What We're Building

### 1. Cleanup Analysis Engine (`packages/dashboard/src/lib/cleanup.ts`)

A server-side module that analyzes all memories and produces a list of suggestions. Each suggestion has a type, affected memory IDs, a description, and a proposed action.

**Suggestion types:**
- **merge** — Two or more memories that say the same thing differently. Proposed action: keep the best one, delete the rest.
- **split** — One memory covering multiple independent topics. Proposed action: split into N parts (reuse existing `splitMemoryById`).
- **contradiction** — Two memories that conflict with each other. Proposed action: user picks which is correct, flag/delete the other.
- **stale** — Memories with low confidence that haven't been used in 30+ days. Proposed action: archive (soft-delete) or confirm.
- **update** — Memories that reference past dates or temporal language ("next week", "currently") that may be outdated. Proposed action: correct or delete.

**Analysis approach:**
- Fetch all active memories
- Send batches to Sonnet to identify issues across the set
- The LLM sees all memories in context and returns structured suggestions
- Stale detection is purely algorithmic (no LLM needed)

```typescript
export interface CleanupSuggestion {
  type: "merge" | "split" | "contradiction" | "stale" | "update";
  memoryIds: string[];
  description: string;
  proposedAction: string;
  // For merge: which memory to keep
  keepId?: string;
  // For split: proposed parts
  parts?: { content: string; detail: string | null }[];
  // For contradiction: the conflicting statements
  conflicts?: { id: string; statement: string }[];
}
```

### 2. Cleanup Server Actions (`packages/dashboard/src/lib/actions.ts`)

Add these actions:

```typescript
export async function analyzeCleanupAction(): Promise<{ suggestions: CleanupSuggestion[] } | { error: string }>
export async function applyMergeSuggestion(keepId: string, deleteIds: string[]): Promise<void>
export async function applySplitSuggestion(id: string, parts: SplitPart[]): Promise<void>  // reuse existing
export async function dismissSuggestion(index: number): Promise<void>  // client-side only, no server needed
```

The `analyzeCleanupAction` should:
1. Fetch all active memories from `getMemories()` (no filters)
2. Identify stale memories algorithmically: `confidence < 0.5 AND used_count = 0 AND learned_at < 30 days ago`
3. Send the full memory list (content + detail + domain + id) to Sonnet in a single call asking it to identify merges, splits, contradictions, and temporal staleness
4. Combine algorithmic + LLM suggestions
5. Return sorted by priority (contradictions > merges > splits > stale > update)

**LLM prompt structure:**
```
You are analyzing a user's memory store for quality issues. Here are all active memories:

[list of {id, content, detail, domain, confidence, used_count, learned_at}]

Identify:
1. DUPLICATES: memories that express the same fact differently (list groups to merge, pick the best-worded one to keep)
2. SPLITS: single memories covering multiple independent topics
3. CONTRADICTIONS: memories that conflict with each other
4. TEMPORAL: memories with language suggesting they may be outdated ("next Thursday", "currently working on", past dates)

Return ONLY a JSON array of suggestions...
```

### 3. Cleanup Page (`packages/dashboard/src/app/cleanup/page.tsx`)

A new route at `/cleanup` with:

**Header:**
- Title: "Cleanup"
- "Analyze" button to trigger the scan (shows loading state while LLM processes)
- Count of suggestions found

**Suggestion cards:**
Each suggestion is a card showing:
- Type badge (merge, split, contradiction, stale, update) with distinct colors
- Description of the issue
- The affected memories (show content preview for each)
- Two buttons: "Apply" (executes the proposed action) and "Dismiss" (removes from the list)
- For **merge**: show all duplicates, highlight which one will be kept, allow changing the selection
- For **split**: show proposed parts (reuse the split review UI from the detail page)
- For **contradiction**: show both memories side by side, let user pick which to keep
- For **stale**: show the memory with "Confirm" and "Delete" options
- For **update**: show the memory with a "Correct" text input

**Empty state:** "No suggestions — your memory store looks clean!" with a subtle checkmark.

### 4. Nav Update

Add "Cleanup" to the navigation bar in `packages/dashboard/src/components/nav.tsx`.

### 5. API Key Handling

The cleanup page uses the same `getApiKey()` function from `actions.ts` that reads from `process.env.ANTHROPIC_API_KEY` or manually loads from `.env.local`. If no key is available, show a message: "API key required for cleanup analysis. Add ANTHROPIC_API_KEY to packages/dashboard/.env.local"

**Important:** The `.env.local` file is at `packages/dashboard/.env.local`. Due to Next.js workspace root detection issues, the `getApiKey()` function in `actions.ts` manually reads this file as a fallback. Keep using this pattern.

## Existing Code to Reuse

- `splitMemoryById()` in `packages/dashboard/src/lib/db.ts` — for applying split suggestions
- `deleteMemoryById()`, `confirmMemoryById()` — for stale suggestions
- `correctMemoryById()` — for update suggestions
- `SplitPart` type and split review UI pattern from `packages/dashboard/src/app/memory/[id]/actions.tsx`
- `Modal`, `Button`, `Card`, `StatusBadge` components from `packages/dashboard/src/components/ui/`
- The two-phase pattern: analyze first, show proposals, user confirms before applying

## Styling

- Dark mode is the default (`<html className="dark">`)
- Use existing CSS custom properties: `--color-bg`, `--color-card`, `--color-accent-text`, etc.
- Badge colors by type:
  - merge: `--color-accent` (purple)
  - split: `--color-warning` (amber)
  - contradiction: `--color-danger` (red)
  - stale: `--color-text-muted` (gray)
  - update: `--color-success` (green)

## Verification

```bash
cd packages/dashboard && pnpm build
```

Then manually test:
1. Navigate to `/cleanup`
2. Click "Analyze" — should show loading, then suggestions
3. Apply a merge suggestion — duplicates should be cleaned up
4. Apply a split suggestion — should create new memories and remove original
5. Dismiss a suggestion — should disappear from the list
6. Run analyze again after applying suggestions — the fixed issues should be gone

## Important Notes

- Use `claude-sonnet-4-6` for the analysis (not Haiku — needs to reason about relationships across memories)
- Strip markdown code fences from LLM responses before JSON parsing: `text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim()`
- The analysis call may take 5-10 seconds for a large memory set — show a clear loading state
- All mutations go through existing `db.ts` write functions — don't create new direct SQL
- Commit all changes and push to `main` when complete
