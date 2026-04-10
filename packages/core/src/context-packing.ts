import type { Client } from "@libsql/client";
import { hybridSearch, type ExpandedResult } from "./search.js";
import { effectivePermanence } from "./confidence.js";
import { getProfile } from "./entity-profiles.js";

// --- Token estimation ---

/** Conservative estimate: ~4 chars per token for English text */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// --- Types ---

export interface ContextMemory {
  id: string;
  content: string;
  detail: string | null;
  domain: string;
  confidence: number;
  permanence: string;
  entity_type: string | null;
  entity_name: string | null;
  connections: {
    content: string;
    relationship: string;
  }[];
}

export interface ContextSummary {
  id: string;
  content: string;
  confidence: number;
  domain: string;
  permanence: string;
}

export interface ContextReference {
  id: string;
  snippet: string;
}

export interface EntityProfileSummary {
  entityName: string;
  entityType: string;
  summary: string;
}

export interface HierarchicalResult {
  primary: {
    memories: ContextMemory[];
    tokenCount: number;
  };
  secondary: {
    summaries: ContextSummary[];
    tokenCount: number;
  };
  references: {
    items: ContextReference[];
    tokenCount: number;
  };
  entityProfiles?: {
    profiles: EntityProfileSummary[];
    tokenCount: number;
  };
  meta: {
    totalMatches: number;
    tokenBudget: number;
    tokensUsed: number;
    format: "hierarchical";
  };
}

export interface NarrativeResult {
  text: string;
  meta: {
    totalMatches: number;
    tokenBudget: number;
    tokensUsed: number;
    format: "narrative";
  };
}

export type ContextPackedResult = HierarchicalResult | NarrativeResult;

// --- Permanence scoring ---

function permanenceMultiplier(mem: Record<string, unknown>): number {
  const perm = effectivePermanence({
    permanence: mem.permanence as string | null,
    confirmed_count: mem.confirmed_count as number | undefined,
    confidence: mem.confidence as number | undefined,
    used_count: mem.used_count as number | undefined,
    entity_type: mem.entity_type as string | null,
    content: mem.content as string | undefined,
    detail: mem.detail as string | null,
  });

  switch (perm) {
    case "canonical": return 1.2;
    case "active": return 1.0;
    case "ephemeral": {
      const expiresAt = mem.expires_at as string | null;
      if (expiresAt && expiresAt < new Date().toISOString()) return 0.8;
      return 1.0;
    }
    case "archived": return 0.5;
    default: return 1.0;
  }
}

// --- Context packing ---

function buildContextMemory(result: ExpandedResult): ContextMemory {
  const mem = result.memory;
  return {
    id: mem.id as string,
    content: mem.content as string,
    detail: (mem.detail as string) || null,
    domain: mem.domain as string,
    confidence: mem.confidence as number,
    permanence: effectivePermanence({
      permanence: mem.permanence as string | null,
      confirmed_count: mem.confirmed_count as number | undefined,
      confidence: mem.confidence as number | undefined,
      used_count: mem.used_count as number | undefined,
      entity_type: mem.entity_type as string | null,
      content: mem.content as string | undefined,
      detail: mem.detail as string | null,
    }),
    entity_type: (mem.entity_type as string) || null,
    entity_name: (mem.entity_name as string) || null,
    connections: result.connected.slice(0, 3).map((c) => ({
      content: c.memory.content as string,
      relationship: c.relationship,
    })),
  };
}

function buildContextSummary(result: ExpandedResult): ContextSummary {
  const mem = result.memory;
  return {
    id: mem.id as string,
    content: mem.content as string,
    confidence: mem.confidence as number,
    domain: mem.domain as string,
    permanence: effectivePermanence({
      permanence: mem.permanence as string | null,
      confirmed_count: mem.confirmed_count as number | undefined,
      confidence: mem.confidence as number | undefined,
      used_count: mem.used_count as number | undefined,
      entity_type: mem.entity_type as string | null,
      content: mem.content as string | undefined,
      detail: mem.detail as string | null,
    }),
  };
}

function buildContextReference(result: ExpandedResult): ContextReference {
  const mem = result.memory;
  const content = mem.content as string;
  return {
    id: mem.id as string,
    snippet: content.length > 60 ? content.slice(0, 57) + "..." : content,
  };
}

function memoryTokenCount(cm: ContextMemory): number {
  let text = cm.content;
  if (cm.detail) text += " " + cm.detail;
  if (cm.entity_name) text += " " + cm.entity_name;
  for (const c of cm.connections) {
    text += " " + c.content;
  }
  return estimateTokens(text) + 20; // overhead for structure
}

function summaryTokenCount(cs: ContextSummary): number {
  return estimateTokens(cs.content) + 10;
}

function referenceTokenCount(cr: ContextReference): number {
  return estimateTokens(cr.snippet) + 5;
}

function packHierarchical(
  results: ExpandedResult[],
  tokenBudget: number,
  entityProfiles?: EntityProfileSummary[],
): HierarchicalResult {
  // Budget allocation: primary 50%, profiles 15%, secondary 25%, references 10%
  const hasProfiles = entityProfiles && entityProfiles.length > 0;
  const primaryBudget = Math.floor(tokenBudget * 0.50);
  const profileBudget = hasProfiles ? Math.floor(tokenBudget * 0.15) : 0;
  const secondaryBudget = Math.floor(tokenBudget * (hasProfiles ? 0.25 : 0.30));
  const referencesBudget = Math.floor(tokenBudget * (hasProfiles ? 0.10 : 0.20));

  const primary: ContextMemory[] = [];
  let primaryTokens = 0;
  let idx = 0;

  // Fill primary (full detail + connections)
  while (idx < results.length) {
    const cm = buildContextMemory(results[idx]);
    const tokens = memoryTokenCount(cm);
    if (primaryTokens + tokens > primaryBudget && primary.length > 0) break;
    primary.push(cm);
    primaryTokens += tokens;
    idx++;
  }

  // Fill secondary (content only)
  const secondary: ContextSummary[] = [];
  let secondaryTokens = 0;
  while (idx < results.length) {
    const cs = buildContextSummary(results[idx]);
    const tokens = summaryTokenCount(cs);
    if (secondaryTokens + tokens > secondaryBudget && secondary.length > 0) break;
    secondary.push(cs);
    secondaryTokens += tokens;
    idx++;
  }

  // Fill references (snippets)
  const references: ContextReference[] = [];
  let referenceTokens = 0;
  while (idx < results.length) {
    const cr = buildContextReference(results[idx]);
    const tokens = referenceTokenCount(cr);
    if (referenceTokens + tokens > referencesBudget && references.length > 0) break;
    references.push(cr);
    referenceTokens += tokens;
    idx++;
  }

  // Include entity profiles if available
  let profilesSection: HierarchicalResult["entityProfiles"];
  let profileTokens = 0;
  if (hasProfiles) {
    const includedProfiles: EntityProfileSummary[] = [];
    for (const profile of entityProfiles) {
      const tokens = estimateTokens(profile.summary) + 15;
      if (profileTokens + tokens > profileBudget && includedProfiles.length > 0) break;
      includedProfiles.push(profile);
      profileTokens += tokens;
    }
    if (includedProfiles.length > 0) {
      profilesSection = { profiles: includedProfiles, tokenCount: profileTokens };
    }
  }

  return {
    primary: { memories: primary, tokenCount: primaryTokens },
    secondary: { summaries: secondary, tokenCount: secondaryTokens },
    references: { items: references, tokenCount: referenceTokens },
    ...(profilesSection ? { entityProfiles: profilesSection } : {}),
    meta: {
      totalMatches: results.length,
      tokenBudget,
      tokensUsed: primaryTokens + secondaryTokens + referenceTokens + profileTokens,
      format: "hierarchical",
    },
  };
}

function packNarrative(
  results: ExpandedResult[],
  tokenBudget: number,
): NarrativeResult {
  const lines: string[] = [];
  let tokensUsed = 0;
  const headerTokens = estimateTokens("You know the following about this topic:");
  tokensUsed += headerTokens;
  lines.push("You know the following about this topic:");

  // First few: full detail
  let idx = 0;
  const fullDetailBudget = Math.floor(tokenBudget * 0.6);
  while (idx < results.length && tokensUsed < fullDetailBudget) {
    const mem = results[idx].memory;
    let line = `- ${mem.content as string}`;
    if (mem.detail) line += ` (${mem.detail as string})`;
    const conf = mem.confidence as number;
    line += ` [${(conf * 100).toFixed(0)}% confidence]`;
    const lineTokens = estimateTokens(line);
    if (tokensUsed + lineTokens > fullDetailBudget && idx > 0) break;
    lines.push(line);
    tokensUsed += lineTokens;
    idx++;
  }

  // Next: one-line summaries
  const summaryBudget = Math.floor(tokenBudget * 0.85);
  while (idx < results.length && tokensUsed < summaryBudget) {
    const mem = results[idx].memory;
    const content = mem.content as string;
    const line = `- ${content.length > 80 ? content.slice(0, 77) + "..." : content}`;
    const lineTokens = estimateTokens(line);
    if (tokensUsed + lineTokens > summaryBudget && idx > 0) break;
    lines.push(line);
    tokensUsed += lineTokens;
    idx++;
  }

  // Remaining count
  const remaining = results.length - idx;
  if (remaining > 0) {
    const footer = `Also relevant: ${remaining} additional ${remaining === 1 ? "memory" : "memories"} available via memory_search.`;
    lines.push(footer);
    tokensUsed += estimateTokens(footer);
  }

  return {
    text: lines.join("\n"),
    meta: {
      totalMatches: results.length,
      tokenBudget,
      tokensUsed,
      format: "narrative",
    },
  };
}

// --- Main entry point ---

export async function contextSearch(
  client: Client,
  query: string,
  options: {
    userId?: string | null;
    tokenBudget?: number;
    format?: "hierarchical" | "narrative";
    domain?: string;
    entityType?: string;
    entityName?: string;
    minConfidence?: number;
    includeArchived?: boolean;
  } = {},
): Promise<ContextPackedResult> {
  const tokenBudget = options.tokenBudget ?? 2000;
  const format = options.format ?? "hierarchical";

  // Search with generous limit — we'll pack to budget
  const { results } = await hybridSearch(client, query, {
    userId: options.userId,
    domain: options.domain,
    entityType: options.entityType,
    entityName: options.entityName,
    minConfidence: options.minConfidence,
    limit: 50,
    expand: true,
    maxDepth: 2,
    similarityThreshold: 0.4,
  });

  // Apply permanence-aware scoring
  const scored = results.map((r) => ({
    ...r,
    score: r.score * permanenceMultiplier(r.memory),
  }));

  // Filter archived unless explicitly included
  const filtered = options.includeArchived
    ? scored
    : scored.filter((r) => (r.memory.permanence as string | null) !== "archived");

  // Re-sort by adjusted score
  filtered.sort((a, b) => b.score - a.score);

  if (format === "narrative") {
    return packNarrative(filtered, tokenBudget);
  }

  // Fetch entity profiles for unique entity names in results
  const entityNames = new Set<string>();
  for (const r of filtered) {
    const name = r.memory.entity_name as string | null;
    if (name) entityNames.add(name);
  }

  const profiles: EntityProfileSummary[] = [];
  for (const name of entityNames) {
    try {
      const profile = await getProfile(client, name, undefined, options.userId);
      if (profile) {
        profiles.push({
          entityName: profile.entityName,
          entityType: profile.entityType,
          summary: profile.summary,
        });
      }
    } catch {
      // Non-fatal — profile lookup failure shouldn't block search
    }
  }

  return packHierarchical(filtered, tokenBudget, profiles);
}
