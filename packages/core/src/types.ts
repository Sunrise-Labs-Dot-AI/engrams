import type { memories, memoryEvents, memoryConnections, agentPermissions } from "./schema.js";

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type MemoryEvent = typeof memoryEvents.$inferSelect;
export type NewMemoryEvent = typeof memoryEvents.$inferInsert;
export type MemoryConnection = typeof memoryConnections.$inferSelect;
export type NewMemoryConnection = typeof memoryConnections.$inferInsert;
export type AgentPermission = typeof agentPermissions.$inferSelect;

export type SourceType = "stated" | "inferred" | "observed" | "cross-agent";
export type Relationship =
  | "influences"
  | "supports"
  | "contradicts"
  | "related"
  | "learned-together";
export type EventType =
  | "created"
  | "confirmed"
  | "corrected"
  | "removed"
  | "confidence_changed"
  | "used";
