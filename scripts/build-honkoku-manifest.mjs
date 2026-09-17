#!/usr/bin/env node
// Node >=24. Reads local model assets; never downloads or publishes them.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HONKOKU_FILE_NAMES, HONKOKU_RUNTIME, HONKOKU_UPSTREAM_REPOSITORY, HONKOKU_V19_UPSTREAM_COMMIT,
  canonicalJson, validateHonkokuManifest, honkokuManifestDigest, requireHttpsUrl,
} from '../src/lib/ocr/honkoku/manifest.ts';

export async function buildHonkokuManifest(directory, baseUrl) {
  const base = requireHttpsUrl(baseUrl);
  if (!base.endsWith('/') || !new URL(base).pathname.includes(`/${HONKOKU_V19_UPSTREAM_COMMIT}/`)) {
    throw new Error('Base URL must end in / and contain the pinned upstream commit as a directory.');
  }
  const files = {};
  for (const [role, name] of Object.entries(HONKOKU_FILE_NAMES)) {
    const path = join(directory, name);
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0) throw new Error(`Missing or empty model: ${name}`);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
    if (bytes !== info.size) throw new Error(`Model changed while reading: ${name}`);
    files[role] = { url: new URL(name, base).href, sha256: hash.digest('hex'), bytes };
  }
  const vocab = JSON.parse(await readFile(join(directory, HONKOKU_FILE_NAMES.vocab), 'utf8'));
  if (!Array.isArray(vocab) || vocab.length !== HONKOKU_RUNTIME.vocabularySize
    || !vocab.every((token) => typeof token === 'string')) {
    throw new Error('Expected a vocabulary array of 7710 strings; verify the upstream format.');
  }
  return validateHonkokuManifest({
    schemaVersion: 2, engineId: 'honkoku-v19', modelVersion: 'v19',
    upstreamRepository: HONKOKU_UPSTREAM_REPOSITORY, upstreamCommit: HONKOKU_V19_UPSTREAM_COMMIT,
    license: 'CC-BY-SA-4.0', runtime: HONKOKU_RUNTIME, files,
  }, new URL('manifest.json', base).href);
}

async function main() {
  const [directory, baseUrl, output] = process.argv.slice(2);
  if (!directory || !baseUrl || !output || process.argv.length !== 5) {
    throw new Error('Usage: node scripts/build-honkoku-manifest.mjs MODEL_DIR HTTPS_COMMIT_BASE_URL OUTPUT.json');
  }
  const manifest = await buildHonkokuManifest(resolve(directory), baseUrl);
  const content = canonicalJson(manifest) + '\n';
  let previous;
  try { previous = await readFile(output, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous !== undefined) {
    const old = JSON.parse(previous);
    console.log('Changed file roles:', Object.keys(manifest.files).filter((role) =>
      canonicalJson(old.files?.[role] ?? null) !== canonicalJson(manifest.files[role])).join(', ') || '(none)');
    if (previous !== content) throw new Error('Existing manifest differs. Write to a new output path and review before publishing.');
  } else {
    await writeFile(output, content, { flag: 'wx' });
  }
  console.log('Canonical manifest SHA-256:', await honkokuManifestDigest(manifest));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
