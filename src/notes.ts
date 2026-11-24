/**
 * Release notes from git history. Works with Conventional Commits ("feat: …") and with
 * plain English subjects ("Add dark mode", "Fix crash on launch").
 */
import { run } from './util.ts';

export type Kind = 'new' | 'improved' | 'fixed' | 'internal';
export interface Change {
  kind: Kind;
  text: string;
}

export const LIMITS = { play: 500, appStore: 4000 } as const;

const CONVENTIONAL: Record<string, Kind> = {
  feat: 'new',
  fix: 'fixed',
  perf: 'improved',
  style: 'improved',
  refactor: 'internal',
  docs: 'internal',
  test: 'internal',
  tests: 'internal',
  ci: 'internal',
  build: 'internal',
  chore: 'internal',
  revert: 'internal',
};

// Work users never see. Starts like "Refactor …" or is about tooling ("… GitHub Actions CI …").
// Deliberately not plain "test": "speed test" is a feature.
const INTERNAL_START = /^(refactor|bump|lint|format|chore|wip|initial commit|typo|readme|docs?\b|ci\b|rename|clean ?up|tidy|upgrade|merge)/i;
const INTERNAL_TOPIC =
  /\b(ci|github actions|lint|eslint|prettier|readme|unit tests?|jest|tests|deps|dependencies|packages|tsconfig|gitignore|eas|workflows?|config plugins?|sdk \d+ patch(es)?)\b/i;
const FIXED = /\b(fix|fixes|fixed|bug|bugs|crash|crashes|resolve|resolves|broken|regression)\b/i;
const IMPROVED = /^(improve|update|make|speed|polish|tweak|change|refine|redesign|rework|tune|optimi[sz]e|simplify|reduce|increase|enhance|restyle|adjust|smooth|faster|better)/i;

function tidy(text: string): string {
  const t = text
    .replace(/\s*\(#\d+\)\s*$/, '') // "(#12)" PR refs
    .replace(/\.+$/, '')
    .trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Classify one commit subject. Returns null for merges and empty subjects.
 * `appName` is dropped from scope prefixes: "ShellDeck: dark mode" → "Dark mode",
 * "ShellDeck icon: new prompt" → "Icon: new prompt".
 */
export function classify(subject: string, appName?: string): Change | null {
  const s = subject.trim();
  if (!s || /^merge (pull request|branch|remote)/i.test(s)) return null;

  const conv = s.match(/^(\w+)(\([^)]*\))?!?:\s*(.+)$/);
  if (conv && CONVENTIONAL[conv[1]!.toLowerCase()]) return { kind: CONVENTIONAL[conv[1]!.toLowerCase()]!, text: tidy(conv[3]!) };

  const scoped = s.match(/^([\w .-]{1,30}):\s+(.+)$/);
  const body = scoped ? scoped[2]! : s;
  let text = body;
  if (scoped) {
    const app = appName?.toLowerCase();
    const scope = scoped[1]!.trim();
    const rest = app && scope.toLowerCase().startsWith(app) ? scope.slice(app.length).trim() : scope;
    // Lower-case the first letter after the prefix, but leave acronyms ("EAS", "iOS") alone.
    const lead = /^[A-Z][a-z]/.test(body) ? body.charAt(0).toLowerCase() + body.slice(1) : body;
    if (rest && !/^my\b/i.test(rest)) text = `${tidy(rest)}: ${lead}`;
  }

  if (INTERNAL_START.test(body) || INTERNAL_TOPIC.test(s)) return { kind: 'internal', text: tidy(text) };
  if (FIXED.test(body)) return { kind: 'fixed', text: tidy(text) };
  if (IMPROVED.test(body)) return { kind: 'improved', text: tidy(text) };
  // "Add …", "Support …", or a feature described as a noun phrase ("Offline mode").
  return { kind: 'new', text: tidy(text) };
}

/** Keep whole bullets until the next one would pass `limit` characters. */
export function fit(header: string, bullets: string[], limit: number, more = '• And more improvements'): string {
  let out = header;
  for (let i = 0; i < bullets.length; i++) {
    const line = `\n${bullets[i]}`;
    const tailRoom = i < bullets.length - 1 ? more.length + 1 : 0;
    if (out.length + line.length + tailRoom > limit) {
      return out.length + more.length + 1 <= limit ? `${out}\n${more}` : out;
    }
    out += line;
  }
  return out;
}

const SECTIONS: [Kind, string][] = [
  ['new', 'New'],
  ['improved', 'Improved'],
  ['fixed', 'Fixed'],
];

export interface Notes {
  markdown: string;
  play: string;
  appStore: string;
  counts: Record<Kind, number>;
}

export function buildNotes(changes: Change[], opts: { version?: string; range?: string } = {}): Notes {
  const by = (k: Kind) => changes.filter((c) => c.kind === k).map((c) => c.text);
  const user = SECTIONS.flatMap(([k]) => by(k));
  const counts = { new: by('new').length, improved: by('improved').length, fixed: by('fixed').length, internal: by('internal').length };
  const v = opts.version ? ` in ${opts.version}` : '';

  const fallback = 'Bug fixes and performance improvements.';
  const play = user.length ? fit(`What's new${v}`, user.map((t) => `• ${t}`), LIMITS.play) : fallback;

  const appStoreBody = SECTIONS.filter(([k]) => by(k).length)
    .map(([k, label]) => `${label}\n${by(k).map((t) => `• ${t}`).join('\n')}`)
    .join('\n\n');
  const appStore = user.length ? fit('', appStoreBody.split('\n'), LIMITS.appStore).trim() : fallback;

  const md = [`## ${opts.version ?? 'Unreleased'}${opts.range ? ` (${opts.range})` : ''}`];
  for (const [k, label] of [...SECTIONS, ['internal', 'Under the hood'] as [Kind, string]]) {
    const items = by(k);
    if (items.length) md.push('', `### ${label}`, ...items.map((t) => `- ${t}`));
  }
  if (!changes.length) md.push('', '_No changes._');

  return { markdown: md.join('\n'), play, appStore, counts };
}

/** Commit subjects since the last tag (or `from`, or the whole history). */
export async function readCommits(root: string, from?: string): Promise<{ subjects: string[]; range: string }> {
  let base = from;
  if (!base) {
    const tag = await run('git', ['describe', '--tags', '--abbrev=0'], root);
    if (tag.code === 0) base = tag.stdout.trim();
  }
  const range = base ? `${base}..HEAD` : 'HEAD';
  const log = await run('git', ['log', '--no-merges', '--format=%s', range], root);
  if (log.code !== 0) throw new Error(`git log failed: ${log.stderr.trim()}`);
  return { subjects: log.stdout.split('\n').filter(Boolean).reverse(), range: base ? range : 'all commits' };
}
