/**
 * EAS build dashboard for one project or a whole folder of projects.
 * Uses `eas build:list --json`, so it works with whatever account the EAS CLI is logged into.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { run } from './util.ts';

export interface EasBuild {
  id: string;
  status: string;
  platform: string;
  buildProfile?: string;
  distribution?: string;
  appVersion?: string;
  appBuildVersion?: string;
  createdAt: string;
  completedAt?: string;
  metrics?: { buildDuration?: number };
  artifacts?: { buildUrl?: string };
  app?: { slug?: string; ownerAccount?: { name?: string } };
  error?: { message?: string; errorCode?: string };
}

export interface AppSummary {
  app: string;
  latest: EasBuild[]; // newest build per platform
  total: number;
  finished: number;
  errored: number;
  avgMinutes: number | null;
  error?: string;
}

const DONE = new Set(['FINISHED', 'ERRORED', 'CANCELED']);

export function buildPageUrl(b: EasBuild): string | undefined {
  const owner = b.app?.ownerAccount?.name;
  return owner && b.app?.slug ? `https://expo.dev/accounts/${owner}/projects/${b.app.slug}/builds/${b.id}` : undefined;
}

export function summarise(app: string, builds: EasBuild[]): AppSummary {
  const sorted = [...builds].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const latest = new Map<string, EasBuild>();
  for (const b of sorted) if (!latest.has(b.platform)) latest.set(b.platform, b);
  const finished = sorted.filter((b) => b.status === 'FINISHED');
  const durations = finished.map((b) => b.metrics?.buildDuration).filter((d): d is number => typeof d === 'number');
  return {
    app,
    latest: [...latest.values()],
    total: sorted.filter((b) => DONE.has(b.status)).length,
    finished: finished.length,
    errored: sorted.filter((b) => b.status === 'ERRORED').length,
    avgMinutes: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length / 60_000 : null,
  };
}

export async function fetchBuilds(root: string, limit: number): Promise<EasBuild[]> {
  const eas = process.env.SHIPKIT_EAS ?? 'npx';
  const args = eas === 'npx' ? ['--yes', 'eas-cli@latest'] : [];
  const r = await run(eas, [...args, 'build:list', '--json', '--non-interactive', '--limit', String(limit)], root);
  if (r.code !== 0) {
    const msg = r.stderr.split('\n').find((l) => /error|not|log in|logged/i.test(l)) ?? r.stderr.trim().split('\n').pop();
    throw new Error(msg?.trim() || `eas build:list exited with ${r.code}`);
  }
  return JSON.parse(r.stdout) as EasBuild[];
}

/** The folder itself if it has eas.json, otherwise its direct subfolders that do. */
export async function findProjects(dir: string, all: boolean): Promise<string[]> {
  if (!all) return [dir];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => join(dir, e.name))
    .filter((p) => existsSync(join(p, 'eas.json')))
    .sort((a, b) => basename(a).localeCompare(basename(b)));
}
