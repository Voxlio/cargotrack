#!/usr/bin/env node
/**
 * Downloads every image listed in public/images/manifest.json into public/images/.
 *
 * Usage:
 *   npm run fetch-images            # download anything missing
 *   npm run fetch-images -- --force # re-download everything
 *   npm run fetch-images -- --prune # also delete .jpg files no longer in the manifest
 *
 * Uses only Node built-ins, so it runs before you install any dependencies.
 * Requires Node 18+ (for global fetch).
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IMAGE_DIR = path.join(ROOT, 'public', 'images');
const MANIFEST = path.join(IMAGE_DIR, 'manifest.json');

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const PRUNE = args.has('--prune');

// Some CDNs reject requests without a browser-ish UA.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function exists(file) {
  try {
    const s = await stat(file);
    return s.isFile() && s.size > 512;
  } catch {
    return false;
  }
}

async function download(entry) {
  const dest = path.join(IMAGE_DIR, entry.file);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);

  let res;
  try {
    res = await fetch(entry.source, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': UA, accept: 'image/avif,image/webp,image/jpeg,image/*' },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) {
    throw new Error(`expected an image, server sent "${type || 'no content-type'}"`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 512) throw new Error(`suspiciously small file (${buf.length} bytes)`);

  await writeFile(dest, buf);
  const sha = createHash('sha256').update(buf).digest('hex').slice(0, 12);
  return { bytes: buf.length, sha, type };
}

async function main() {
  await mkdir(IMAGE_DIR, { recursive: true });

  let manifest;
  try {
    manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  } catch (err) {
    console.error(`Cannot read ${path.relative(ROOT, MANIFEST)}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const entries = manifest.images || [];
  if (!entries.length) {
    console.error('Manifest lists no images.');
    process.exitCode = 1;
    return;
  }

  console.log(`\nDownloading ${entries.length} images into public/images/\n`);

  let ok = 0;
  let skipped = 0;
  const failed = [];

  for (const entry of entries) {
    const dest = path.join(IMAGE_DIR, entry.file);
    const already = await exists(dest);

    if (already && !FORCE) {
      const s = await stat(dest);
      console.log(`  skip  ${entry.file.padEnd(32)} ${human(s.size)} (already present)`);
      skipped += 1;
      continue;
    }

    process.stdout.write(`  get   ${entry.file.padEnd(32)} `);
    try {
      const { bytes, type, sha } = await download(entry);
      console.log(`${human(bytes).padStart(8)}  ${type}  sha256:${sha}`);
      ok += 1;
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      failed.push({ file: entry.file, error: err.message });
      // A stale, truncated file is worse than no file: clear it so onerror fallbacks apply.
      if (already) await unlink(dest).catch(() => {});
    }
  }

  if (PRUNE) {
    const wanted = new Set(entries.map((e) => e.file));
    const present = await readdir(IMAGE_DIR);
    for (const file of present) {
      if (file.endsWith('.jpg') && !wanted.has(file)) {
        await unlink(path.join(IMAGE_DIR, file));
        console.log(`  prune ${file}`);
      }
    }
  }

  console.log(`\nDone. ${ok} downloaded, ${skipped} already present, ${failed.length} failed.`);

  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.file}: ${f.error}`);
    console.log(
      '\nIf every download failed with a proxy/403 error, you are probably behind a\n' +
        'restricted network. Run this script from an unrestricted machine, or add\n' +
        'images.unsplash.com to your egress allowlist, then re-run `npm run fetch-images`.'
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\nUnexpected failure:', err);
  process.exitCode = 1;
});
