/** Which resource the logs panel shows, per workspace. Lets the header popover open the panel on a given resource. */
const targets = new Map<string, string | null>();
const listeners = new Set<() => void>();
let version = 0;

export const logsTarget = {
  get(workspaceId: string): string | null {
    return targets.get(workspaceId) ?? null;
  },
  set(workspaceId: string, resource: string | null) {
    if (targets.get(workspaceId) === resource) return;
    targets.set(workspaceId, resource);
    version += 1;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getVersion: () => version,
};
