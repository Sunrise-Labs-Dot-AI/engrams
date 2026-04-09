import { MemoryCard } from "./memory-card";
import type { MemoryRow } from "@/lib/db";

interface MemoryListProps {
  memories: MemoryRow[];
  groupByDomain?: boolean;
}

export function MemoryList({ memories, groupByDomain = true }: MemoryListProps) {
  if (memories.length === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-[var(--color-text-muted)] text-sm">
          No memories yet. Start chatting with an AI tool that has Engrams
          connected.
        </p>
      </div>
    );
  }

  if (!groupByDomain) {
    return (
      <div className="space-y-2">
        {memories.map((m) => (
          <MemoryCard key={m.id} memory={m} />
        ))}
      </div>
    );
  }

  const grouped = new Map<string, MemoryRow[]>();
  for (const m of memories) {
    const list = grouped.get(m.domain) ?? [];
    list.push(m);
    grouped.set(m.domain, list);
  }

  return (
    <div className="space-y-6">
      {Array.from(grouped.entries()).map(([domain, domainMemories]) => (
        <div key={domain}>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
            {domain}
            <span className="ml-1.5 opacity-60">{domainMemories.length}</span>
          </h2>
          <div className="space-y-2">
            {domainMemories.map((m) => (
              <MemoryCard key={m.id} memory={m} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
