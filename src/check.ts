/**
 * Store-readiness checks. `runChecks` is pure (config + facts in, findings out) so every
 * rule is unit-tested; `gatherFacts` does the file and git reads.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';

import { pluginName, pluginOptions, type Project } from './project.ts';
import { run } from './util.ts';

export type Level = 'error' | 'warn' | 'ok';
export interface Finding {
  level: Level;
  id: string;
  message: string;
  fix?: string;
}

export interface ImageInfo {
  width: number;
  height: number;
  hasAlpha: boolean;
}

export interface Facts {
  /** Image metadata keyed by the path as written in the config. null = file missing. */
  images: Record<string, ImageInfo | null>;
  lastTag: { name: string; commitsSince: number } | null;
}

/** Packages whose iOS permission prompts need a purpose string, and the Info.plist keys they use. */
export const PERMISSION_PACKAGES: Record<string, string[]> = {
  'expo-camera': ['NSCameraUsageDescription'],
  'expo-image-picker': ['NSPhotoLibraryUsageDescription', 'NSCameraUsageDescription'],
  'expo-media-library': ['NSPhotoLibraryUsageDescription'],
  'expo-location': ['NSLocationWhenInUseUsageDescription'],
  'expo-contacts': ['NSContactsUsageDescription'],
  'expo-calendar': ['NSCalendarsUsageDescription'],
  'expo-audio': ['NSMicrophoneUsageDescription'],
  'expo-av': ['NSMicrophoneUsageDescription'],
  'expo-local-authentication': ['NSFaceIDUsageDescription'],
  'expo-tracking-transparency': ['NSUserTrackingUsageDescription'],
};

/** Android permissions Google Play restricts or reviews by hand. */
export const SENSITIVE_ANDROID: Record<string, string> = {
  READ_SMS: 'SMS access is only allowed for default SMS apps or approved exceptions (Play SMS & Call Log policy).',
  RECEIVE_SMS: 'SMS access is only allowed for default SMS apps or approved exceptions (Play SMS & Call Log policy).',
  READ_CALL_LOG: 'Call log access needs an approved Play Console declaration.',
  MANAGE_EXTERNAL_STORAGE: '"All files access" needs a Play Console declaration and is usually rejected.',
  QUERY_ALL_PACKAGES: 'Needs a Play Console declaration explaining why you list installed apps.',
  REQUEST_INSTALL_PACKAGES: 'Play reviews apps that install other APKs closely.',
  ACCESS_BACKGROUND_LOCATION: 'Needs a Play declaration and a video showing the feature.',
  SYSTEM_ALERT_WINDOW: 'Draw-over-other-apps is reviewed and often rejected.',
};

const SEMVER = /^\d+\.\d+\.\d+$/;
const IOS_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const ANDROID_ID = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

export function iconPaths(p: Project): { general?: string; ios?: string; adaptive?: string } {
  const { config } = p;
  const iosIcon = typeof config.ios?.icon === 'string' ? config.ios.icon : config.ios?.icon?.light;
  return { general: config.icon, ios: iosIcon ?? config.icon, adaptive: config.android?.adaptiveIcon?.foregroundImage };
}

export function runChecks(p: Project, facts: Facts): Finding[] {
  const { config, eas, deps } = p;
  const out: Finding[] = [];
  const add = (level: Level, id: string, message: string, fix?: string) => out.push({ level, id, message, ...(fix ? { fix } : {}) });

  // Identity
  if (!config.name) add('error', 'name', 'App has no name.', 'Set "name" in app.json.');
  if (!config.version) add('error', 'version', 'App has no version.', 'Set "version", e.g. "1.0.0".');
  else if (!SEMVER.test(config.version)) add('warn', 'version', `Version "${config.version}" is not MAJOR.MINOR.PATCH.`, 'The App Store expects up to three numbers, e.g. "1.2.0".');
  else add('ok', 'version', `Version ${config.version}`);

  const bundle = config.ios?.bundleIdentifier;
  if (!bundle) add('error', 'ios-bundle', 'No ios.bundleIdentifier.', 'Add one, e.g. "com.yourname.app". It can never change after the first upload.');
  else if (!IOS_ID.test(bundle)) add('error', 'ios-bundle', `"${bundle}" is not a valid iOS bundle identifier.`);
  else if (/^com\.(anonymous|example)\./.test(bundle)) add('warn', 'ios-bundle', `"${bundle}" is a placeholder.`, 'Use your own reverse domain before the first upload; it is permanent.');
  else add('ok', 'ios-bundle', `iOS bundle ${bundle}`);

  const pkg = config.android?.package;
  if (!pkg) add('error', 'android-package', 'No android.package.', 'Add one, e.g. "com.yourname.app". It can never change after the first upload.');
  else if (!ANDROID_ID.test(pkg)) add('error', 'android-package', `"${pkg}" is not a valid Android package name.`, 'Use letters, digits and underscores only; each part must start with a letter (no hyphens).');
  else if (/^com\.(anonymous|example)\./.test(pkg)) add('warn', 'android-package', `"${pkg}" is a placeholder.`, 'Use your own reverse domain before the first upload; it is permanent.');
  else add('ok', 'android-package', `Android package ${pkg}`);

  // Icons
  const icons = iconPaths(p);
  if (!icons.general && !icons.ios) add('error', 'icon', 'No app icon configured.', 'Set "icon" to a 1024×1024 PNG.');
  for (const [label, path] of [['App icon', icons.general], ['iOS icon', icons.ios !== icons.general ? icons.ios : undefined]] as const) {
    if (!path) continue;
    const info = facts.images[path];
    if (info === null) add('error', 'icon', `${label} ${path} does not exist.`);
    else if (info) {
      if (info.width !== 1024 || info.height !== 1024) add('error', 'icon', `${label} is ${info.width}×${info.height}.`, 'Stores need a 1024×1024 PNG.');
      else if (info.hasAlpha) add('warn', 'icon-alpha', `${label} has an alpha channel.`, 'App Store Connect rejects transparent app icons. Export it without transparency.');
      else add('ok', 'icon', `${label} 1024×1024, opaque`);
    }
  }
  if (!icons.adaptive) add('warn', 'adaptive-icon', 'No Android adaptive icon.', 'Set android.adaptiveIcon.foregroundImage so the icon is not cropped badly on Android.');
  else if (facts.images[icons.adaptive] === null) add('error', 'adaptive-icon', `Adaptive icon ${icons.adaptive} does not exist.`);

  // Splash
  const hasSplash = Boolean(config.splash) || (config.plugins ?? []).some((pl) => pluginName(pl) === 'expo-splash-screen');
  if (!hasSplash) add('warn', 'splash', 'No splash screen configured.', 'Add the expo-splash-screen plugin with an image and background colour.');

  // Build numbers
  const prod = eas?.build?.production;
  if (!eas) add('warn', 'eas', 'No eas.json.', 'Run `npx eas-cli@latest build:configure`.');
  else if (!prod) add('warn', 'eas-production', 'eas.json has no "production" build profile.', 'Store uploads normally come from a production profile.');
  if (eas) {
    const remote = eas.cli?.appVersionSource === 'remote';
    if (remote && prod?.autoIncrement) add('ok', 'build-number', 'Build numbers are managed by EAS and auto-increment');
    else if (remote) add('warn', 'build-number', 'appVersionSource is remote but production does not auto-increment.', 'Add "autoIncrement": true to build.production, or every upload after the first is rejected as a duplicate.');
    else if (!prod?.autoIncrement && (config.android?.versionCode === undefined || config.ios?.buildNumber === undefined))
      add('warn', 'build-number', 'Build numbers are not managed.', 'Set cli.appVersionSource to "remote" and build.production.autoIncrement to true in eas.json.');
  }

  // iOS purpose strings
  const plist = config.ios?.infoPlist ?? {};
  for (const [dep, keys] of Object.entries(PERMISSION_PACKAGES)) {
    if (!deps[dep]) continue;
    const opts = pluginOptions(config, dep);
    const viaPlugin = opts !== null && typeof opts === 'object' && Object.keys(opts).some((k) => /permission|usage/i.test(k));
    const missing = keys.filter((k) => typeof plist[k] !== 'string');
    if (missing.length && !viaPlugin)
      add('warn', 'purpose-string', `${dep} is installed but ${missing.join(', ')} uses Expo's generic text.`, `App Review rejects vague prompts (Guideline 5.1.1). Configure the ${dep} plugin or ios.infoPlist with a sentence saying why you need it.`);
  }

  // Android sensitive permissions
  for (const perm of config.android?.permissions ?? []) {
    const short = perm.replace(/^android\.permission\./, '');
    const why = SENSITIVE_ANDROID[short];
    if (why && !(config.android?.blockedPermissions ?? []).includes(perm)) add('warn', 'android-permission', `${short}: ${why}`);
  }

  // iPad
  if (config.ios?.supportsTablet) add('warn', 'ipad', 'supportsTablet is on, so App Store Connect requires 13" iPad screenshots.', 'Make them with `shipkit frame --preset ipad-13`, or set supportsTablet to false if the app is phone-only.');

  // Version bump
  if (facts.lastTag && config.version && facts.lastTag.commitsSince > 0 && facts.lastTag.name.replace(/^v/, '') === config.version)
    add('warn', 'version-bump', `${facts.lastTag.commitsSince} commit(s) since ${facts.lastTag.name} but version is still ${config.version}.`, 'Bump "version" before submitting an update.');

  return out;
}

export async function gatherFacts(p: Project): Promise<Facts> {
  const images: Facts['images'] = {};
  const paths = Object.values(iconPaths(p)).filter((x): x is string => Boolean(x));
  for (const rel of new Set(paths)) {
    const abs = join(p.root, rel);
    if (!existsSync(abs)) {
      images[rel] = null;
      continue;
    }
    const m = await sharp(abs).metadata();
    images[rel] = { width: m.width ?? 0, height: m.height ?? 0, hasAlpha: Boolean(m.hasAlpha) };
  }

  let lastTag: Facts['lastTag'] = null;
  const tag = await run('git', ['describe', '--tags', '--abbrev=0'], p.root).catch(() => null);
  if (tag && tag.code === 0) {
    const name = tag.stdout.trim();
    const count = await run('git', ['rev-list', '--count', `${name}..HEAD`], p.root);
    lastTag = { name, commitsSince: Number(count.stdout.trim()) || 0 };
  }
  return { images, lastTag };
}
