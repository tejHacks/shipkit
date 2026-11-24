/**
 * Turns raw simulator/device screenshots into store-ready images:
 * gradient background, caption on top, screenshot with rounded corners and a soft shadow.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import sharp from 'sharp';

/** Pixel sizes App Store Connect and Google Play accept. */
export const PRESETS = {
  'ios-6.9': { width: 1320, height: 2868, label: 'iPhone 6.9"' },
  'ios-6.5': { width: 1284, height: 2778, label: 'iPhone 6.5"' },
  'ipad-13': { width: 2064, height: 2752, label: 'iPad 13"' },
  android: { width: 1080, height: 1920, label: 'Android phone' },
} as const;
export type PresetName = keyof typeof PRESETS;

export interface FrameOptions {
  width: number;
  height: number;
  caption: string;
  background: [string, string];
  foreground: string;
}

const xml = (s: string) => s.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch]!);

/** Greedy word wrap by an estimated character budget. */
export function wrap(text: string, maxChars: number, maxLines = 3): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1]!.replace(/\s*\S*$/, '') + '…';
    return kept;
  }
  return lines;
}

/** "03-dark-mode.png" → "Dark mode" */
export function captionFromFilename(file: string): string {
  const words = basename(file, extname(file)).replace(/^\d+[-_ ]*/, '').replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

export async function frameOne(screenshot: Buffer, o: FrameOptions): Promise<Buffer> {
  const { width: W, height: H } = o;
  const fontSize = Math.round(W * 0.068);
  const lineHeight = Math.round(fontSize * 1.18);
  const lines = o.caption ? wrap(o.caption, Math.floor((W * 0.84) / (fontSize * 0.56))) : [];
  const captionTop = Math.round(H * 0.065);
  const captionBottom = captionTop + lines.length * lineHeight;

  // Fit the screenshot in the space left under the caption.
  const top = lines.length ? captionBottom + Math.round(H * 0.035) : Math.round(H * 0.06);
  const boxW = Math.round(W * 0.8);
  const boxH = H - top - Math.round(H * 0.05);
  const resized = await sharp(screenshot).resize({ width: boxW, height: boxH, fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
  const sw = resized.info.width;
  const sh = resized.info.height;
  const radius = Math.round(sw * 0.07);
  const left = Math.round((W - sw) / 2);

  const rounded = await sharp(resized.data)
    .composite([{ input: Buffer.from(`<svg width="${sw}" height="${sh}"><rect width="${sw}" height="${sh}" rx="${radius}" ry="${radius}"/></svg>`), blend: 'dest-in' }])
    .png()
    .toBuffer();

  const blur = Math.round(W * 0.025);
  const shadow = await sharp({ create: { width: sw + blur * 4, height: sh + blur * 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from(`<svg width="${sw + blur * 4}" height="${sh + blur * 4}"><rect x="${blur * 2}" y="${blur * 2}" width="${sw}" height="${sh}" rx="${radius}" fill="black" fill-opacity="0.45"/></svg>`) }])
    .blur(blur)
    .png()
    .toBuffer();

  const text = lines
    .map((l, i) => `<text x="${W / 2}" y="${captionTop + fontSize + i * lineHeight}" text-anchor="middle">${xml(l)}</text>`)
    .join('');
  const background = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${xml(o.background[0])}"/><stop offset="1" stop-color="${xml(o.background[1])}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <g font-family="SF Pro Display, Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="700" font-size="${fontSize}" fill="${xml(o.foreground)}">${text}</g>
  </svg>`;

  const composed = await sharp(Buffer.from(background))
    .composite([
      { input: shadow, left: left - blur * 2, top: top - blur * 2 + Math.round(blur * 0.6) },
      { input: rounded, left, top },
    ])
    .png()
    .toBuffer();
  // Separate pass: sharp applies flatten() before composite(), and the stores reject alpha channels.
  return sharp(composed).flatten({ background: o.background[1] }).png().toBuffer();
}

export interface FrameDirOptions {
  input: string;
  output: string;
  preset: PresetName;
  background: [string, string];
  foreground: string;
  captionsFile?: string;
}

/**
 * Frame every PNG/JPEG in a folder. Captions come from captions.json ({ "file.png": "Caption" })
 * in the input folder (or --captions), falling back to the file name.
 */
export async function frameDir(o: FrameDirOptions): Promise<string[]> {
  const files = (await readdir(o.input)).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
  if (!files.length) throw new Error(`No PNG or JPEG screenshots in ${o.input}`);
  const captionsPath = o.captionsFile ?? join(o.input, 'captions.json');
  const captions: Record<string, string> = existsSync(captionsPath) ? JSON.parse(await readFile(captionsPath, 'utf8')) : {};
  const { width, height } = PRESETS[o.preset];
  const dir = join(o.output, o.preset);
  await mkdir(dir, { recursive: true });

  const written: string[] = [];
  for (const f of files) {
    const png = await frameOne(await readFile(join(o.input, f)), {
      width,
      height,
      caption: captions[f] ?? captionFromFilename(f),
      background: o.background,
      foreground: o.foreground,
    });
    const out = join(dir, basename(f, extname(f)) + '.png');
    await writeFile(out, png);
    written.push(out);
  }
  return written;
}
