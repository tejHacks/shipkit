/**
 * Loads an Expo project: the resolved app config, eas.json and package.json dependencies.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { run } from './util.ts';

export type PluginEntry = string | [string, unknown?];

export interface ExpoConfig {
  name?: string;
  slug?: string;
  version?: string;
  icon?: string;
  splash?: unknown;
  plugins?: PluginEntry[];
  ios?: {
    bundleIdentifier?: string;
    buildNumber?: string;
    icon?: string | { light?: string; dark?: string; tinted?: string };
    infoPlist?: Record<string, unknown>;
    supportsTablet?: boolean;
  };
  android?: {
    package?: string;
    versionCode?: number;
    adaptiveIcon?: { foregroundImage?: string; backgroundColor?: string };
    permissions?: string[];
    blockedPermissions?: string[];
  };
}

export interface EasJson {
  cli?: { appVersionSource?: 'local' | 'remote' };
  build?: Record<string, { autoIncrement?: boolean | string; distribution?: string; extends?: string } | undefined>;
  submit?: Record<string, unknown>;
}

export interface Project {
  root: string;
  config: ExpoConfig;
  eas: EasJson | null;
  deps: Record<string, string>;
}

async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

const DYNAMIC_CONFIGS = ['app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs'];

export async function loadProject(root: string): Promise<Project> {
  let config: ExpoConfig;
  if (DYNAMIC_CONFIGS.some((f) => existsSync(join(root, f)))) {
    // Dynamic configs can only be resolved by Expo itself.
    const r = await run('npx', ['expo', 'config', '--json', '--type', 'public'], root);
    if (r.code !== 0) throw new Error(`expo config failed:\n${r.stderr.trim()}`);
    config = JSON.parse(r.stdout) as ExpoConfig;
  } else {
    const raw = await readJson<{ expo?: ExpoConfig } & ExpoConfig>(join(root, 'app.json'));
    if (!raw) throw new Error(`No app.json or app.config.* in ${root}. Is this an Expo project?`);
    config = raw.expo ?? raw;
  }
  const pkg = await readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(root, 'package.json'));
  return {
    root,
    config,
    eas: await readJson<EasJson>(join(root, 'eas.json')),
    deps: { ...pkg?.dependencies, ...pkg?.devDependencies },
  };
}

export function pluginName(p: PluginEntry): string {
  return typeof p === 'string' ? p : p[0];
}

export function pluginOptions(config: ExpoConfig, name: string): unknown {
  const entry = config.plugins?.find((p) => pluginName(p) === name);
  return Array.isArray(entry) ? entry[1] : undefined;
}
