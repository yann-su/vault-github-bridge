import { hashText, validatePaths, type Hash } from './model';

export interface RemoteOverwritePlan {
  mode: 'git' | 'api'; source: string; remoteHead: string; localHead: string;
  localCommits: number; stagedPaths: string[];
  changes: Array<{ path: string; before: Hash; target: Hash }>;
  fingerprint: string;
}
export interface RemoteOverwriteResult { changed: number; backup: string; backupBranch?: string }

export function overwritePlan(meta: Omit<RemoteOverwritePlan, 'changes' | 'fingerprint'>,
  local: Map<string, string>, remote: Map<string, string>, context: unknown, extra: string[] = []): RemoteOverwritePlan {
  const paths = [...new Set([...local.keys(), ...remote.keys()])].sort();
  validatePaths(paths);
  const changes = paths.filter(p => local.get(p) !== remote.get(p) || extra.includes(p))
    .map(path => ({ path, before: local.get(path) ?? null, target: remote.get(path) ?? null }));
  const sorted = (map: Map<string, string>) => [...map].sort(([a], [b]) => a.localeCompare(b));
  return { ...meta, changes, fingerprint: hashText(JSON.stringify([meta, sorted(local), sorted(remote), context, extra])) };
}
