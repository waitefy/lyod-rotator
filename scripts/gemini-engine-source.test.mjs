import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sourceDigest } from './gemini-engine-source.mjs';

test('vendored engine matches the reviewed manifest and retains its MIT notice', async () => {
  const root = new URL('../', import.meta.url);
  const { engine } = JSON.parse(await readFile(new URL('gemini-engine.json', root), 'utf8'));
  assert.match(engine.commit, /^[a-f0-9]{40}$/);
  assert.equal(await sourceDigest(new URL(engine.path, root).pathname), engine.sha256);
  assert.match(await readFile(new URL(`${engine.path}/LICENSE`, root), 'utf8'), /Permission is hereby granted/);
});

test('source verification detects content changes and rejects links outside the vendor tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'engine-provenance-'));
  try {
    await writeFile(join(root, 'source.go'), 'package original\n');
    const original = await sourceDigest(root);
    await writeFile(join(root, 'source.go'), 'package modified\n');
    assert.notEqual(await sourceDigest(root), original);
    await symlink('/etc/passwd', join(root, 'outside'));
    await assert.rejects(sourceDigest(root), /regular files only/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
