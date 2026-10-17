// Prepare a pinned source update only. Publishing and deployment are separate.
import { cp, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sourceDigest } from './gemini-engine-source.mjs';

const ref = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(ref || '') || process.argv.length !== 3) throw new Error('Usage: node scripts/update-gemini-engine.mjs <full-commit>');
const root = fileURLToPath(new URL('../', import.meta.url));
const manifestFile = join(root, 'gemini-engine.json');
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
if (ref === manifest.engine.commit) { console.log('Engine already pinned to this commit'); process.exit(0); }
if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Preserve existing changes before updating engine sources');
const temp = await mkdtemp(join(tmpdir(), 'rotator-engine-update-'));
try {
  execFileSync('git', ['init', '--quiet', temp]);
  execFileSync('git', ['-C', temp, 'fetch', '--quiet', '--depth=1', manifest.engine.repository, ref]);
  execFileSync('git', ['-C', temp, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  const license = await readFile(join(temp, 'LICENSE'), 'utf8');
  if (!license.includes('MIT License') || !license.includes('Permission is hereby granted')) throw new Error('Engine license changed; manual review required');
  const source = join(root, manifest.engine.path);
  await rm(source, { recursive: true, force: true });
  for (const path of ['internal', 'go.mod', 'go.sum', 'LICENSE']) await cp(join(temp, path), join(source, path), { recursive: true });
  manifest.engine.commit = ref;
  manifest.engine.sha256 = await sourceDigest(source);
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=true\ncommit=${ref}\n`);
  console.log(`Prepared Gemini engine ${ref}; apply patches, tests and build before review`);
} finally { await rm(temp, { recursive: true, force: true }); }
