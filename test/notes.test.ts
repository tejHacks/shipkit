import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LIMITS, buildNotes, classify, fit, type Change } from '../src/notes.ts';

describe('classify', () => {
  it('reads Conventional Commits', () => {
    assert.deepEqual(classify('feat(search): fuzzy matching'), { kind: 'new', text: 'Fuzzy matching' });
    assert.deepEqual(classify('fix: crash on empty list (#12)'), { kind: 'fixed', text: 'Crash on empty list' });
    assert.equal(classify('chore: bump deps')?.kind, 'internal');
    assert.equal(classify('perf!: faster startup')?.kind, 'improved');
  });

  it('reads plain English subjects', () => {
    assert.equal(classify('Add dark mode')?.kind, 'new');
    assert.equal(classify('Fix crash when offline')?.kind, 'fixed');
    assert.equal(classify('Improve search ranking')?.kind, 'improved');
    assert.equal(classify('Offline mode for saved commands')?.kind, 'new');
  });

  it('keeps tooling work out of store notes', () => {
    for (const s of ['Add GitHub Actions CI', 'Link ShellDeck to EAS for Android builds', 'Refactor store', 'Update README', 'Initial commit', 'Add unit tests for search'])
      assert.equal(classify(s)?.kind, 'internal', s);
  });

  it('does not mistake a "speed test" feature for tests', () => {
    assert.equal(classify('Instant search, compare tab and speed test')?.kind, 'new');
  });

  it('drops the app name from scope prefixes but keeps the rest', () => {
    assert.equal(classify('ShellDeck: dark mode', 'ShellDeck')?.text, 'Dark mode');
    assert.equal(classify('ShellDeck icon: terminal card stack', 'ShellDeck')?.text, 'Icon: terminal card stack');
  });

  it('skips merges and blanks', () => {
    assert.equal(classify('Merge pull request #1 from x/y'), null);
    assert.equal(classify('   '), null);
  });
});

describe('fit', () => {
  it('keeps whole bullets and notes that more was left out', () => {
    const out = fit('Head', ['• aaaa', '• bbbb', '• cccc', '• dddd'], 26, '• More');
    assert.equal(out, 'Head\n• aaaa\n• bbbb\n• More');
    assert.ok(out.length <= 26);
    assert.equal(fit('Head', ['• aaaa', '• bbbb'], 26, '• More'), 'Head\n• aaaa\n• bbbb');
  });
});

describe('buildNotes', () => {
  const many: Change[] = Array.from({ length: 60 }, (_, i) => ({ kind: 'new', text: `Feature number ${i} with a fairly long description` }));

  it('respects store character limits', () => {
    const n = buildNotes(many, { version: '2.0.0' });
    assert.ok(n.play.length <= LIMITS.play, `play ${n.play.length}`);
    assert.ok(n.appStore.length <= LIMITS.appStore, `appStore ${n.appStore.length}`);
    assert.match(n.play, /^What's new in 2\.0\.0/);
    assert.match(n.play, /And more improvements$/);
  });

  it('falls back when only internal work changed', () => {
    const n = buildNotes([{ kind: 'internal', text: 'Bump deps' }]);
    assert.equal(n.play, 'Bug fixes and performance improvements.');
    assert.match(n.markdown, /### Under the hood\n- Bump deps/);
  });

  it('groups the App Store notes by section', () => {
    const n = buildNotes([
      { kind: 'fixed', text: 'Crash on launch' },
      { kind: 'new', text: 'Widgets' },
    ]);
    assert.equal(n.appStore, 'New\n• Widgets\n\nFixed\n• Crash on launch');
  });
});
