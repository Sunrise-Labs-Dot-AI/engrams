const API_BASE = "http://localhost:3838/api";

async function post(path: string, body?: Record<string, unknown>) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

export function confirmMemory(id: string) {
  return post(`/memory/${id}/confirm`);
}

export function correctMemory(id: string, content: string) {
  return post(`/memory/${id}/correct`, { content });
}

export function flagMemory(id: string) {
  return post(`/memory/${id}/flag`);
}

export function deleteMemory(id: string) {
  return post(`/memory/${id}/delete`);
}

export function updateMemory(
  id: string,
  data: { content?: string; detail?: string; domain?: string },
) {
  return post(`/memory/${id}/update`, data);
}

export function setPermissions(data: {
  agentId: string;
  domain: string;
  canRead: boolean;
  canWrite: boolean;
}) {
  return post(`/permissions`, data);
}

export function clearAllMemories() {
  return post(`/clear-all`);
}
