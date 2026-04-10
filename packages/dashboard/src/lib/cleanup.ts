import { getMemories, type MemoryRow } from "./db";

// --- Types ---

export type SuggestionType = "merge" | "split" | "contradiction" | "stale" | "update";

export interface CleanupSuggestion {
  type: SuggestionType;
  memoryIds: string[];
  description: string;
  proposedAction: string;
  /** For merge: which memory to keep (set by LLM on expand) */
  keepId?: string;
  /** For split: proposed parts (set by LLM on expand) */
  parts?: { content: string; detail: string | null }[];
  /** For contradiction: the conflicting statements (set by LLM on expand) */
  conflicts?: { id: string; statement: string }[];
  /** Memories included in this suggestion (populated during scan) */
  memories?: { id: string; content: string; detail: string | null; domain: string; confidence: number }[];
  /** Whether LLM has enriched this suggestion */
  expanded?: boolean;
}

// --- Algorithmic detection (zero API cost) ---

/** Stale: low confidence, never used, learned 30+ days ago */
function findStale(memories: MemoryRow[]): CleanupSuggestion[] {
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
      description: `${(m.confidence * 100).toFixed(0)}% confidence, never used, learned over 30 days ago`,
      proposedAction: "Confirm if still accurate, or delete",
      memories: [{ id: m.id, content: m.content, detail: m.detail, domain: m.domain, confidence: m.confidence }],
      expanded: true,
    }));
}

/** Temporal/outdated: regex for date patterns and temporal language */
const TEMPORAL_PATTERNS = [
  /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)\b/i,
  /\bthis\s+(week|month|quarter|sprint)\b/i,
  /\bcurrently\s/i,
  /\bright\s+now\b/i,
  /\bat\s+the\s+moment\b/i,
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(,?\s+20\d{2})?\b/i,
  /\b20\d{2}-\d{2}-\d{2}\b/,
  /\btoday\b/i,
  /\btomorrow\b/i,
  /\byesterday\b/i,
];

function findTemporal(memories: MemoryRow[]): CleanupSuggestion[] {
  const results: CleanupSuggestion[] = [];
  for (const m of memories) {
    const text = m.content + (m.detail ? " " + m.detail : "");
    const matched = TEMPORAL_PATTERNS.find((p) => p.test(text));
    if (matched) {
      const matchStr = text.match(matched)?.[0] ?? "";
      results.push({
        type: "update",
        memoryIds: [m.id],
        description: `Contains temporal language ("${matchStr}") that may be outdated`,
        proposedAction: "Review and correct or delete if no longer accurate",
        memories: [{ id: m.id, content: m.content, detail: m.detail, domain: m.domain, confidence: m.confidence }],
        expanded: true,
      });
    }
  }
  return results;
}

/** Split candidates: memories with 3+ sentences or multiple semicolons */
function findSplitCandidates(memories: MemoryRow[]): CleanupSuggestion[] {
  const results: CleanupSuggestion[] = [];
  for (const m of memories) {
    const text = m.content + (m.detail ? " " + m.detail : "");
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 10);
    const semicolons = text.split(";").filter((s) => s.trim().length > 10);
    if (sentences.length >= 3 || semicolons.length >= 3) {
      results.push({
        type: "split",
        memoryIds: [m.id],
        description: `Covers ${Math.max(sentences.length, semicolons.length)} topics — may be better as separate memories`,
        proposedAction: "Click expand to see proposed split",
        memories: [{ id: m.id, content: m.content, detail: m.detail, domain: m.domain, confidence: m.confidence }],
        expanded: false,
      });
    }
  }
  return results;
}

/**
 * Duplicate clusters: text-based bigram Jaccard similarity to find
 * near-identical memories. Works in both local and hosted modes.
 */
function findDuplicateClusters(memories: MemoryRow[]): CleanupSuggestion[] {
  if (memories.length < 2) return [];

  function bigrams(text: string): Set<string> {
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const set = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) {
      set.add(words[i] + " " + words[i + 1]);
    }
    return set;
  }

  function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const item of a) {
      if (b.has(item)) intersection++;
    }
    return intersection / (a.size + b.size - intersection);
  }

  const memBigrams = memories.map(m => ({
    id: m.id,
    bigrams: bigrams(m.content + (m.detail ? " " + m.detail : "")),
  }));

  const clustered = new Set<string>();
  const results: CleanupSuggestion[] = [];

  for (let i = 0; i < memBigrams.length; i++) {
    if (clustered.has(memBigrams[i].id)) continue;

    const cluster: string[] = [];
    for (let j = i + 1; j < memBigrams.length; j++) {
      if (clustered.has(memBigrams[j].id)) continue;
      const similarity = jaccard(memBigrams[i].bigrams, memBigrams[j].bigrams);
      if (similarity > 0.5) {
        cluster.push(memBigrams[j].id);
      }
    }

    if (cluster.length === 0) continue;

    const allIds = [memBigrams[i].id, ...cluster];
    for (const id of allIds) clustered.add(id);

    const memMap = new Map(memories.map(m => [m.id, m]));
    const clusterMemories = allIds
      .map(id => memMap.get(id)!)
      .map(mem => ({
        id: mem.id,
        content: mem.content,
        detail: mem.detail,
        domain: mem.domain,
        confidence: mem.confidence,
      }));

    results.push({
      type: "merge",
      memoryIds: allIds,
      description: `${allIds.length} memories express similar information`,
      proposedAction: "Click expand to have Sonnet pick the best version",
      memories: clusterMemories,
      expanded: false,
    });
  }

  return results;
}

/**
 * Contradiction candidates: within each domain, find memory pairs with
 * moderate text similarity — same topic but different enough to potentially conflict.
 */
function findContradictionCandidates(memories: MemoryRow[]): CleanupSuggestion[] {
  function wordSet(text: string): Set<string> {
    return new Set(text.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  }

  function wordOverlap(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const item of a) {
      if (b.has(item)) intersection++;
    }
    return intersection / Math.min(a.size, b.size);
  }

  const byDomain = new Map<string, MemoryRow[]>();
  for (const m of memories) {
    const arr = byDomain.get(m.domain) || [];
    arr.push(m);
    byDomain.set(m.domain, arr);
  }

  const seen = new Set<string>();
  const results: CleanupSuggestion[] = [];

  for (const [, domainMemories] of byDomain) {
    if (domainMemories.length < 2) continue;

    const memWords = domainMemories.map(m => ({
      mem: m,
      words: wordSet(m.content + (m.detail ? " " + m.detail : "")),
    }));

    for (let i = 0; i < memWords.length; i++) {
      for (let j = i + 1; j < memWords.length; j++) {
        const key = [memWords[i].mem.id, memWords[j].mem.id].sort().join("|");
        if (seen.has(key)) continue;

        const overlap = wordOverlap(memWords[i].words, memWords[j].words);
        // Moderate similarity: same topic area but different content
        if (overlap >= 0.3 && overlap < 0.7) {
          seen.add(key);
          results.push({
            type: "contradiction",
            memoryIds: [memWords[i].mem.id, memWords[j].mem.id],
            description: `Same domain ("${memWords[i].mem.domain}"), similar topic but different assertions`,
            proposedAction: "Click expand to check if these conflict",
            memories: [
              { id: memWords[i].mem.id, content: memWords[i].mem.content, detail: memWords[i].mem.detail, domain: memWords[i].mem.domain, confidence: memWords[i].mem.confidence },
              { id: memWords[j].mem.id, content: memWords[j].mem.content, detail: memWords[j].mem.detail, domain: memWords[j].mem.domain, confidence: memWords[j].mem.confidence },
            ],
            expanded: false,
          });
        }
      }
    }
  }

  return results;
}

// --- Main scan (zero API cost) ---

const TYPE_PRIORITY: Record<SuggestionType, number> = {
  contradiction: 0,
  merge: 1,
  split: 2,
  stale: 3,
  update: 4,
};

export async function scanForSuggestions(): Promise<CleanupSuggestion[]> {
  const memories = await getMemories();
  if (memories.length === 0) return [];

  const suggestions = [
    ...findDuplicateClusters(memories),
    ...findContradictionCandidates(memories),
    ...findSplitCandidates(memories),
    ...findStale(memories),
    ...findTemporal(memories),
  ];

  suggestions.sort((a, b) => TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type]);
  return suggestions;
}

// --- LLM expansion (on-demand, per suggestion) ---

import { parseLLMJson } from "@engrams/core";
import type { LLMProvider } from "@engrams/core";

export async function expandMergeSuggestion(
  suggestion: CleanupSuggestion,
  provider: LLMProvider,
): Promise<CleanupSuggestion> {
  if (!suggestion.memories || suggestion.memories.length < 2) return suggestion;

  const prompt = `These memories express similar information. Pick the single best-worded one to keep. Return ONLY a JSON object: {"keepId": "id_of_best", "reason": "why"}

Memories:
${suggestion.memories.map((m) => `- ID: ${m.id}\n  Content: ${JSON.stringify(m.content)}\n  Detail: ${JSON.stringify(m.detail)}`).join("\n\n")}`;

  const text = await provider.complete(prompt, { maxTokens: 512, json: true });
  try {
    const result = parseLLMJson<{ keepId: string; reason: string }>(text);
    if (suggestion.memoryIds.includes(result.keepId)) {
      return {
        ...suggestion,
        keepId: result.keepId,
        description: result.reason,
        proposedAction: "Keep the best version, delete duplicates",
        expanded: true,
      };
    }
  } catch {}
  // Fallback: pick highest confidence
  const best = suggestion.memories.reduce((a, b) => (a.confidence >= b.confidence ? a : b));
  return { ...suggestion, keepId: best.id, expanded: true };
}

export async function expandSplitSuggestion(
  suggestion: CleanupSuggestion,
  provider: LLMProvider,
): Promise<CleanupSuggestion> {
  if (!suggestion.memories || suggestion.memories.length < 1) return suggestion;
  const mem = suggestion.memories[0];

  const prompt = `This memory covers multiple topics. Split it into the minimum number of independent memories.

Content: ${JSON.stringify(mem.content)}
Detail: ${JSON.stringify(mem.detail)}

Each memory should have a clear "content" (one sentence) and optional "detail". Return ONLY a JSON array: [{"content": "...", "detail": "..." or null}, ...]`;

  const text = await provider.complete(prompt, { maxTokens: 1024, json: true });
  try {
    const parts = parseLLMJson<{ content: string; detail: string | null }[]>(text);
    if (Array.isArray(parts) && parts.length >= 2) {
      return { ...suggestion, parts, expanded: true };
    }
  } catch {}
  return { ...suggestion, expanded: true, parts: undefined };
}

export async function expandContradictionSuggestion(
  suggestion: CleanupSuggestion,
  provider: LLMProvider,
): Promise<CleanupSuggestion> {
  if (!suggestion.memories || suggestion.memories.length < 2) return suggestion;

  const prompt = `Do these two memories contradict each other? If yes, return {"contradicts": true, "explanation": "...", "conflicts": [{"id": "id1", "statement": "what it claims"}, {"id": "id2", "statement": "what it claims"}]}. If they don't actually conflict, return {"contradicts": false}.

Memory 1 (${suggestion.memories[0].id}): ${JSON.stringify(suggestion.memories[0].content)}
Memory 2 (${suggestion.memories[1].id}): ${JSON.stringify(suggestion.memories[1].content)}

Return ONLY JSON.`;

  const text = await provider.complete(prompt, { maxTokens: 512, json: true });
  try {
    const result = parseLLMJson<{ contradicts: boolean; explanation?: string; conflicts?: { id: string; statement: string }[] }>(text);
    if (result.contradicts === false) {
      return { ...suggestion, expanded: true, description: "Not a contradiction (false positive)", proposedAction: "Dismiss" };
    }
    if (result.contradicts && result.conflicts) {
      return {
        ...suggestion,
        description: result.explanation ?? suggestion.description,
        conflicts: result.conflicts,
        expanded: true,
      };
    }
  } catch {}
  return { ...suggestion, expanded: true };
}
