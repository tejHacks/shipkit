import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import sharp from 'sharp';

import { buildPageUrl, summarise, type EasBuild } from '../src/builds.ts';
import { PRESETS, captionFromFilename, frameOne, wrap } from '../src/frame.ts';

describe('frame', () => {
  it('wraps captions and truncates past the line limit', () => {
    assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four']);
    assert.deepEqual(wrap('a b c d e f', 1, 2), ['a', '…']);
  });

  it('derives captions from file names', () => {
    assert.equal(captionFromFilename('03-dark-mode.png'), 'Dark mode');
    assert.equal(captionFromFilename('settings_screen.jpg'), 'Settings screen');
  });

  it('outputs the exact store size with no transparency', async () => {
    const shot = await sharp({ create: { width: 1179, height: 2556, channels: 3, background: '#336699' } }).png().toBuffer();
    for (const preset of ['ios-6.9', 'android'] as const) {
      const out = await frameOne(shot, { ...PRESETS[preset], caption: 'Find any command <fast> & offline', background: ['#000', '#123'], foreground: '#fff' });
      const m = await sharp(out).metadata();
      assert.equal(m.width, PRESETS[preset].width);
      assert.equal(m.height, PRESETS[preset].height);
      assert.equal(m.hasAlpha, false);
    }
  });
});

describe('builds', () => {
  const b = (o: Partial<EasBuild>): EasBuild => ({ id: 'x', status: 'FINISHED', platform: 'ANDROID', createdAt: '2026-11-01T00:00:00Z', ...o });

  it('keeps the newest build per platform and computes stats', () => {
    const s = summarise('app', [
      b({ id: 'old', createdAt: '2026-10-01T00:00:00Z', metrics: { buildDuration: 600_000 } }),
      b({ id: 'new', createdAt: '2026-11-02T00:00:00Z', status: 'ERRORED' }),
      b({ id: 'ios', platform: 'IOS', metrics: { buildDuration: 1_200_000 } }),
      b({ id: 'running', platform: 'IOS', status: 'IN_PROGRESS', createdAt: '2026-09-01T00:00:00Z' }),
    ]);
    assert.deepEqual(s.latest.map((x) => x.id), ['new', 'ios']);
    assert.equal(s.total, 3); // in-progress builds are not counted yet
    assert.equal(s.finished, 2);
    assert.equal(s.errored, 1);
    assert.equal(s.avgMinutes, 15);
  });

  it('links to the build page', () => {
    assert.equal(buildPageUrl(b({ id: 'abc', app: { slug: 'demo', ownerAccount: { name: 'me' } } })), 'https://expo.dev/accounts/me/projects/demo/builds/abc');
    assert.equal(buildPageUrl(b({})), undefined);
  });
});
