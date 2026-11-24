#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { summarise, buildPageUrl, fetchBuilds, findProjects, type AppSummary } from './builds.ts';
import { gatherFacts, runChecks, type Level } from './check.ts';
import { PRESETS, frameDir, type PresetName } from './frame.ts';
import { buildNotes, classify, readCommits, type Change } from './notes.ts';
import { loadProject } from './project.ts';
import { color, mapLimit, table, timeAgo } from './util.ts';

const VERSION = '0.1.0';

const HELP = `${color.bold('shipkit')} ${VERSION} — ship Expo apps without the busywork

${color.bold('Usage')}
  shipkit check  [dir]                 Store-readiness audit of the app config
  shipkit notes  [dir] [--from <ref>]  Release notes from commits since the last tag
                       [--format md|play|appstore|all] [--out <file>]
  shipkit frame  <screenshots-dir>     Store-ready screenshots with captions
                       [--preset ${Object.keys(PRESETS).join('|')}] [--out <dir>]
                       [--bg "#0B0E11,#1E293B"] [--fg "#FFFFFF"] [--captions <file>]
  shipkit builds [dir] [--all] [--limit 10]
                       EAS build status; --all scans every app inside dir

${color.bold('Examples')}
  shipkit check
  shipkit notes --format play
  shipkit frame docs/screenshots --preset ios-6.9
  shipkit builds ~/Developer/mobile-apps --all
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      from: { type: 'string' },
      format: { type: 'string', default: 'all' },
      out: { type: 'string', short: 'o' },
      preset: { type: 'string', default: 'ios-6.9' },
      bg: { type: 'string', default: '#0B0E11,#1E293B' },
      fg: { type: 'string', default: '#FFFFFF' },
      captions: { type: 'string' },
      all: { type: 'boolean' },
      limit: { type: 'string', default: '10' },
    },
  });
  const [cmd, target] = positionals;
  if (values.version) return console.log(VERSION), 0;
  if (!cmd || values.help) return console.log(HELP), cmd ? 0 : 1;
  const dir = resolve(target ?? '.');

  switch (cmd) {
    case 'check':
      return check(dir);
    case 'notes':
      return notes(dir, values.from, values.format, values.out);
    case 'frame': {
      if (!target) throw new Error('Pass the folder with your raw screenshots: shipkit frame <dir>');
      if (!(values.preset in PRESETS)) throw new Error(`Unknown preset "${values.preset}". Use one of: ${Object.keys(PRESETS).join(', ')}`);
      const [a, b] = values.bg.split(',').map((s) => s.trim());
      const files = await frameDir({
        input: dir,
        output: resolve(values.out ?? 'store-screenshots'),
        preset: values.preset as PresetName,
        background: [a!, b ?? a!],
        foreground: values.fg,
        ...(values.captions ? { captionsFile: resolve(values.captions) } : {}),
      });
      const p = PRESETS[values.preset as PresetName];
      console.log(`${color.green('✓')} Framed ${files.length} screenshot(s) for ${p.label} (${p.width}×${p.height})`);
      for (const f of files) console.log(`  ${color.dim(f)}`);
      return 0;
    }
    case 'builds':
      return builds(dir, Boolean(values.all), Math.min(Math.max(Number(values.limit) || 10, 1), 50));
    default:
      console.error(`Unknown command "${cmd}".\n`);
      console.log(HELP);
      return 1;
  }
}

async function check(dir: string): Promise<number> {
  const project = await loadProject(dir);
  const findings = runChecks(project, await gatherFacts(project));
  const icon: Record<Level, string> = { ok: color.green('✓'), warn: color.yellow('!'), error: color.red('✗') };
  console.log(color.bold(`\n${project.config.name ?? basename(dir)} — store readiness\n`));
  for (const level of ['error', 'warn', 'ok'] as Level[]) {
    for (const f of findings.filter((x) => x.level === level)) {
      console.log(`  ${icon[level]} ${f.message}`);
      if (f.fix) console.log(`    ${color.dim(f.fix)}`);
    }
  }
  const errors = findings.filter((f) => f.level === 'error').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  console.log(`\n${errors ? color.red(`${errors} error(s)`) : color.green('0 errors')}, ${warns ? color.yellow(`${warns} warning(s)`) : '0 warnings'}\n`);
  return errors ? 1 : 0;
}

async function notes(dir: string, from: string | undefined, format: string, out: string | undefined): Promise<number> {
  const project = await loadProject(dir).catch(() => null);
  const { subjects, range } = await readCommits(dir, from);
  const changes = subjects.map((s) => classify(s, project?.config.name)).filter((c): c is Change => c !== null);
  const n = buildNotes(changes, { ...(project?.config.version ? { version: project.config.version } : {}), range });

  const blocks: Record<string, string> = {
    md: n.markdown,
    play: n.play,
    appstore: n.appStore,
  };
  let text: string;
  if (format === 'all') {
    text = [
      color.bold(`Google Play — What's new (${n.play.length}/500)`),
      n.play,
      '',
      color.bold(`App Store — What's New (${n.appStore.length}/4000)`),
      n.appStore,
      '',
      color.bold('CHANGELOG.md'),
      n.markdown,
    ].join('\n');
  } else if (blocks[format] !== undefined) text = blocks[format];
  else throw new Error(`Unknown format "${format}". Use md, play, appstore or all.`);

  if (out) {
    await writeFile(resolve(out), (format === 'all' ? n.markdown : text) + '\n');
    console.log(`${color.green('✓')} Wrote ${out}`);
  } else console.log(text);
  console.error(color.dim(`\n${subjects.length} commits (${range}): ${n.counts.new} new, ${n.counts.improved} improved, ${n.counts.fixed} fixed, ${n.counts.internal} internal`));
  return 0;
}

const STATUS: Record<string, (s: string) => string> = {
  FINISHED: (s) => color.green(`✓ ${s}`),
  ERRORED: (s) => color.red(`✗ ${s}`),
  CANCELED: (s) => color.dim(`– ${s}`),
};

async function builds(dir: string, all: boolean, limit: number): Promise<number> {
  const projects = await findProjects(dir, all);
  if (!projects.length) throw new Error(`No folders with eas.json inside ${dir}`);
  if (projects.length > 1) console.error(color.dim(`Fetching builds for ${projects.length} apps…`));

  const summaries: AppSummary[] = await mapLimit(projects, 4, async (p) => {
    try {
      return summarise(basename(p), await fetchBuilds(p, limit));
    } catch (e) {
      return { app: basename(p), latest: [], total: 0, finished: 0, errored: 0, avgMinutes: null, error: (e as Error).message };
    }
  });

  const rows = [['App', 'Platform', 'Status', 'Version', 'Profile', 'When', 'Avg build', 'Success'].map(color.bold)];
  const failures: string[] = [];
  for (const s of summaries) {
    if (s.error) {
      rows.push([s.app, '', color.red('could not load'), '', '', '', '', '']);
      failures.push(`${s.app}: ${s.error}`);
      continue;
    }
    if (!s.latest.length) {
      rows.push([s.app, '', color.dim('no builds yet'), '', '', '', '', '']);
      continue;
    }
    s.latest.forEach((b, i) => {
      const status = (STATUS[b.status] ?? ((x: string) => color.yellow(`… ${x}`)))(b.status.toLowerCase().replace(/_/g, ' '));
      rows.push([
        i === 0 ? s.app : '',
        b.platform.toLowerCase(),
        status,
        b.appVersion ? `${b.appVersion} (${b.appBuildVersion ?? '?'})` : '',
        b.buildProfile ?? '',
        timeAgo(new Date(b.createdAt)),
        i === 0 && s.avgMinutes !== null ? `${s.avgMinutes.toFixed(0)} min` : '',
        i === 0 && s.total ? `${s.finished}/${s.total}` : '',
      ]);
      if (b.status === 'ERRORED') failures.push(`${s.app} ${b.platform.toLowerCase()}: ${b.error?.message ?? 'build failed'}  ${color.dim(buildPageUrl(b) ?? '')}`);
    });
  }
  console.log('\n' + table(rows) + '\n');

  const loaded = summaries.filter((s) => !s.error);
  const total = loaded.reduce((a, s) => a + s.total, 0);
  const ok = loaded.reduce((a, s) => a + s.finished, 0);
  if (total) console.log(`${ok}/${total} recent builds succeeded (${Math.round((ok / total) * 100)}%) across ${loaded.length} app(s).`);
  if (failures.length) console.log(`\n${color.bold('Needs attention')}\n${failures.map((f) => `  ${color.red('✗')} ${f}`).join('\n')}`);
  console.log();
  return failures.length ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (err: Error) => {
    console.error(color.red(`✗ ${err.message}`));
    process.exitCode = 1;
  },
);
