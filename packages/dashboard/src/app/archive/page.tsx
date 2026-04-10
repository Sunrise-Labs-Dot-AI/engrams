import { Suspense } from "react";
import { getArchivedMemories } from "@/lib/db";
import { getUserId } from "@/lib/auth";
import { ArchiveClient } from "./client";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{
    q?: string;
    sort?: string;
  }>;
}

export default async function ArchivePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const userId = await getUserId();

  const sortBy = (["archived", "confidence", "learned"] as const).includes(
    params.sort as "archived" | "confidence" | "learned",
  )
    ? (params.sort as "archived" | "confidence" | "learned")
    : "archived";

  const memories = await getArchivedMemories({
    search: params.q,
    sortBy,
  }, userId);

  return (
    <Suspense>
      <ArchiveClient memories={memories} />
    </Suspense>
  );
}
