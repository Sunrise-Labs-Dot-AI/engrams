import { getMemories, type MemoryRow } from "./db";
import Anthropic from "@anthropic-ai/sdk";

export interface CleanupSuggestion {
  type: "merge" | "split" | "contradiction" | "stale" | "update";
  memoryIds: string[];
  description: string;
  proposedAction: string;
  keepId?: string;
  parts?: { content: string; detail: string | null }[];
  conflicts?: { id: string; statement: string }[];
}

function findStaleMemories(memories: MemoryRow[]): CleanupSuggestion[] {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return memories
    .filter(
      (m) =>
        m.confidence < 0.5 &&
        m.used_count === 0 &&
        m.learned_at !== null &&
        m.learned_at < thirtyDaysAgo,
    )
    .map((m) => ({
      type: "stale" as const,
      memoryIds: [m.id],
      description: `Low confidence (${(m.confidence * 100).toFixed(0)}%), never used, learned over 30 days ago`,
      proposedAction: "Confirm if still accurate, or delete",
    }));
}

async function findLLMSuggestions(
  memories: MemoryRow[],
  apiKey: string,
): Promise<CleanupSuggestion[]> {
  const memorySummaries = memories.map((m) => ({
    id: m.id,
    content: m.content,
    detail: m.detail,
    domain: m.domain,
    confidence: m.confidence,
    used_count: m.used_count,
    learned_at: m.learned_at,
  }));

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `You are analyzing a user's memory store for quality issues. Here are all active memories:

${JSON.stringify(memorySummaries, null, 2)}

Identify:
1. DUPLICATES: memories that express the same fact differently (list groups to merge, pick the best-worded one to keep)
2. SPLITS: single memories covering multiple independent topics that should be separate
3. CONTRADICTIONS: memories that conflict with each other
4. TEMPORAL: memories with language suggesting they may be outdated ("next Thursday", "currently working on", specific past dates, "this week", etc.)

Return ONLY a JSON array of suggestions. Each suggestion must be one of:
- {"type": "merge", "memoryIds": ["id1", "id2", ...], "keepId": "best_id", "description": "why these are duplicates", "proposedAction": "Keep the best-worded version, delete duplicates"}
- {"type": "split", "memoryIds": ["id"], "description": "why this should be split", "proposedAction": "Split into independent memories", "parts": [{"content": "...", "detail": null or "..."}, ...]}
- {"type": "contradiction", "memoryIds": ["id1", "id2"], "description": "what conflicts", "proposedAction": "User should pick which is correct", "conflicts": [{"id": "id1", "statement": "..."}, {"id": "id2", "statement": "..."}]}
- {"type": "update", "memoryIds": ["id"], "description": "why this may be outdated", "proposedAction": "Review and correct or delete if no longer accurate"}

If no issues are found for a category, omit it. Return an empty array [] if everything looks clean.`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  try {
    const cleaned = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const suggestions = JSON.parse(cleaned) as CleanupSuggestion[];
    if (!Array.isArray(suggestions)) return [];
    return suggestions;
  } catch {
    console.error("[engrams] Cleanup analysis parse error:", text);
    return [];
  }
}

const TYPE_PRIORITY: Record<CleanupSuggestion["type"], number> = {
  contradiction: 0,
  merge: 1,
  split: 2,
  stale: 3,
  update: 4,
};

export async function analyzeCleanup(
  apiKey: string,
): Promise<CleanupSuggestion[]> {
  const memories = getMemories();
  if (memories.length === 0) return [];

  const stale = findStaleMemories(memories);
  const llm = await findLLMSuggestions(memories, apiKey);

  const all = [...llm, ...stale];
  all.sort((a, b) => TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type]);
  return all;
}
