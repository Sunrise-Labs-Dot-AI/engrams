"use server";

import { directUpdateMemory } from "./db";
import { revalidatePath } from "next/cache";

export async function updateMemoryAction(id: string, content: string, detail: string | null) {
  await directUpdateMemory(id, content, detail);
  revalidatePath("/");
  revalidatePath(`/memory/${id}`);
}
