import { getAgentPermissions, getAgents, getDomains } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";

export const dynamic = "force-dynamic";

export default function AgentsPage() {
  const agents = getAgents();
  const permissions = getAgentPermissions();
  const domains = getDomains();

  const permMap = new Map<string, Map<string, { canRead: boolean; canWrite: boolean }>>();
  for (const p of permissions) {
    if (!permMap.has(p.agent_id)) permMap.set(p.agent_id, new Map());
    permMap.get(p.agent_id)!.set(p.domain, {
      canRead: !!p.can_read,
      canWrite: !!p.can_write,
    });
  }

  if (agents.length === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-[var(--color-text-muted)] text-sm">
          No agents have connected yet. Connect an AI tool with Engrams to see
          agents here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Agent Permissions</h1>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)]">
                <th className="text-left p-3 font-medium text-[var(--color-text-secondary)]">
                  Agent
                </th>
                {domains.map((d) => (
                  <th
                    key={d.domain}
                    className="text-center p-3 font-medium text-[var(--color-text-secondary)]"
                  >
                    {d.domain}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr
                  key={agent.agent_id}
                  className="border-b border-[var(--color-border-light)]"
                >
                  <td className="p-3">
                    <div>
                      <p className="font-medium">{agent.agent_name}</p>
                      <p className="text-xs text-[var(--color-text-muted)] font-mono truncate max-w-48">
                        {agent.agent_id}
                      </p>
                    </div>
                  </td>
                  {domains.map((d) => {
                    const perm = permMap.get(agent.agent_id)?.get(d.domain);
                    return (
                      <td key={d.domain} className="text-center p-3">
                        {perm ? (
                          <div className="flex items-center justify-center gap-1">
                            <StatusBadge
                              variant={perm.canRead ? "success" : "danger"}
                            >
                              R
                            </StatusBadge>
                            <StatusBadge
                              variant={perm.canWrite ? "success" : "danger"}
                            >
                              W
                            </StatusBadge>
                          </div>
                        ) : (
                          <span className="text-[var(--color-text-muted)]">
                            —
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
