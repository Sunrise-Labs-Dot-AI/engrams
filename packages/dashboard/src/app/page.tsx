import { Suspense } from "react";
import { getMemories, getDomains } from "@/lib/db";
import { MemoryList } from "@/components/memory-list";
import { SearchBar } from "@/components/search-bar";
import { DomainFilter } from "@/components/domain-filter";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ q?: string; domain?: string; sort?: string }>;
}

export default async function HomePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const domains = getDomains();
  const memories = getMemories({
    search: params.q,
    domain: params.domain,
    sortBy: params.sort === "recency" ? "recency" : "confidence",
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Suspense>
          <SearchBar />
        </Suspense>
        <Suspense>
          <DomainFilter domains={domains} />
        </Suspense>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--color-text-muted)]">
          {memories.length} {memories.length === 1 ? "memory" : "memories"}
        </p>
      </div>

      <MemoryList
        memories={memories}
        groupByDomain={!params.q && !params.domain}
      />
    </div>
  );
}
