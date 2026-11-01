#!/usr/bin/env node
/**
 * Generates the local SVG fallbacks used by the `onerror` handlers in index.html.
 *
 * These replace the old https://placehold.co dependency: if a photo in
 * public/images/ is missing (or you deploy before running `npm run fetch-images`),
 * the browser swaps in a branded local SVG instead of a broken image.
 *
 * Output: public/images/fallback/<slug>.svg
 * Re-run after editing public/images/manifest.json.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IMAGE_DIR = path.join(ROOT, 'public', 'images');
const OUT_DIR = path.join(IMAGE_DIR, 'fallback');

const BRAND = { primary: '#FF3E41', ink: '#0F172A', accent: '#06B6D4' };

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  })[c]);
}

function svg({ label, width, height, id }) {
  const w = Math.max(120, Math.round(width));
  const h = Math.max(120, Math.round(height));
  const square = Math.abs(w - h) < 24;

  // Two-line wrap for longer labels so nothing overflows at 150px.
  const words = label.split(' ');
  const head = words.length > 1 && label.length > 12 ? words.slice(0, -1).join(' ') : label;
  const tail = words.length > 1 && label.length > 12 ? words[words.length - 1] : '';

  const base = Math.min(w, h);
  const titleSize = Math.round(Math.max(15, Math.min(base * 0.115, 44)));
  const subSize = Math.round(titleSize * 0.52);
  const midY = h / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeXml(label)}">
  <defs>
    <linearGradient id="g-${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BRAND.ink}"/>
      <stop offset="1" stop-color="#1E293B"/>
    </linearGradient>
    <pattern id="p-${id}" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="28" stroke="${BRAND.accent}" stroke-opacity="0.10" stroke-width="2"/>
    </pattern>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g-${id})"/>
  <rect width="${w}" height="${h}" fill="url(#p-${id})"/>
  <rect x="0" y="0" width="${w}" height="4" fill="${BRAND.primary}"/>
  <g font-family="Inter, Poppins, Segoe UI, Helvetica, Arial, sans-serif" text-anchor="middle" fill="#FFFFFF">
    <text x="${w / 2}" y="${square ? midY - titleSize * 0.15 : midY + titleSize * 0.1}" font-size="${titleSize}" font-weight="700" letter-spacing="0.5">${escapeXml(head)}</text>
    ${tail ? `<text x="${w / 2}" y="${(square ? midY - titleSize * 0.15 : midY + titleSize * 0.1) + titleSize * 1.05}" font-size="${titleSize}" font-weight="700" letter-spacing="0.5">${escapeXml(tail)}</text>` : ''}
    <text x="${w / 2}" y="${h - Math.max(16, h * 0.09)}" font-size="${subSize}" font-weight="600" fill="${BRAND.accent}" letter-spacing="${subSize * 0.18}">CARGOTRACKER</text>
  </g>
</svg>
`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(IMAGE_DIR, 'manifest.json'), 'utf8'));

  let n = 0;
  for (const [i, entry] of (manifest.images || []).entries()) {
    const slug = entry.file.replace(/\.(jpe?g|png|webp)$/i, '');
    const out = path.join(OUT_DIR, `${slug}.svg`);
    const body = svg({ label: entry.label || slug, width: entry.width, height: entry.height, id: i });
    await writeFile(out, body, 'utf8');
    n += 1;
  }

  // Generic last-resort fallback for anything not in the manifest.
  await writeFile(
    path.join(OUT_DIR, 'generic.svg'),
    svg({ label: 'Cargo Image', width: 800, height: 600, id: 'generic' }),
    'utf8'
  );

  console.log(`Wrote ${n + 1} SVG placeholders to public/images/fallback/`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
