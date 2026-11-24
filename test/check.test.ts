import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runChecks, type Facts } from '../src/check.ts';
import type { ExpoConfig, Project } from '../src/project.ts';

const goodIcon = { width: 1024, height: 1024, hasAlpha: false };

function project(config: Partial<ExpoConfig> = {}, extra: Partial<Project> = {}): Project {
  return {
    root: '/app',
    config: {
      name: 'Demo',
      slug: 'demo',
      version: '1.0.0',
      icon: './icon.png',
      plugins: ['expo-splash-screen'],
      ios: { bundleIdentifier: 'com.me.demo' },
      android: { package: 'com.me.demo', adaptiveIcon: { foregroundImage: './fg.png' } },
      ...config,
    },
    eas: { cli: { appVersionSource: 'remote' }, build: { production: { autoIncrement: true } } },
    deps: {},
    ...extra,
  };
}
const facts = (f: Partial<Facts> = {}): Facts => ({ images: { './icon.png': goodIcon, './fg.png': goodIcon }, lastTag: null, ...f });
const ids = (p: Project, f = facts()) => runChecks(p, f).filter((x) => x.level !== 'ok').map((x) => x.id);

describe('runChecks', () => {
  it('passes a well-configured app', () => {
    assert.deepEqual(ids(project()), []);
  });

  it('rejects hyphens in the Android package', () => {
    const f = runChecks(project({ android: { package: 'com.me.my-app', adaptiveIcon: { foregroundImage: './fg.png' } } }), facts());
    assert.equal(f.find((x) => x.id === 'android-package')?.level, 'error');
  });

  it('flags placeholder identifiers', () => {
    assert.ok(ids(project({ ios: { bundleIdentifier: 'com.anonymous.demo' } })).includes('ios-bundle'));
  });

  it('checks icon size, existence and transparency', () => {
    assert.ok(ids(project(), facts({ images: { './icon.png': { width: 512, height: 512, hasAlpha: false }, './fg.png': goodIcon } })).includes('icon'));
    assert.ok(ids(project(), facts({ images: { './icon.png': null, './fg.png': goodIcon } })).includes('icon'));
    assert.ok(ids(project(), facts({ images: { './icon.png': { ...goodIcon, hasAlpha: true }, './fg.png': goodIcon } })).includes('icon-alpha'));
  });

  it('warns when build numbers will collide', () => {
    assert.ok(ids(project({}, { eas: { build: { production: {} } } })).includes('build-number'));
    assert.ok(ids(project({}, { eas: { cli: { appVersionSource: 'remote' }, build: { production: {} } } })).includes('build-number'));
  });

  it('wants a purpose string for permission packages', () => {
    assert.ok(ids(project({}, { deps: { 'expo-camera': '1' } })).includes('purpose-string'));
    // Set through the plugin…
    assert.ok(!ids(project({ plugins: ['expo-splash-screen', ['expo-camera', { cameraPermission: 'Scan receipts' }]] }, { deps: { 'expo-camera': '1' } })).includes('purpose-string'));
    // …or through infoPlist.
    assert.ok(!ids(project({ ios: { bundleIdentifier: 'com.me.demo', infoPlist: { NSCameraUsageDescription: 'Scan receipts' } } }, { deps: { 'expo-camera': '1' } })).includes('purpose-string'));
  });

  it('warns about Play-restricted Android permissions', () => {
    const p = project({ android: { package: 'com.me.demo', adaptiveIcon: { foregroundImage: './fg.png' }, permissions: ['android.permission.READ_SMS'] } });
    assert.ok(runChecks(p, facts()).some((x) => x.id === 'android-permission' && x.message.startsWith('READ_SMS')));
  });

  it('reminds about iPad screenshots and version bumps', () => {
    assert.ok(ids(project({ ios: { bundleIdentifier: 'com.me.demo', supportsTablet: true } })).includes('ipad'));
    assert.ok(ids(project(), facts({ lastTag: { name: 'v1.0.0', commitsSince: 3 } })).includes('version-bump'));
    assert.ok(!ids(project(), facts({ lastTag: { name: 'v0.9.0', commitsSince: 3 } })).includes('version-bump'));
  });
});
