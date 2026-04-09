"use server";

import { getWriteDb } from "./db";
import { revalidatePath } from "next/cache";

export async function directUpdateMemory(id: string, content: string, detail: string | null) {
  const db = getWriteDb();
  db.prepare(`UPDATE memories SET content = ?, detail = ? WHERE id = ? AND deleted_at IS NULL`)
    .run(content, detail, id);
  revalidatePath("/");
  revalidatePath(`/memory/${id}`);
}
