import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceDigest } from './gemini-engine-source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = await mkdtemp(join(tmpdir(), 'rotator-engine-build-'));
const output = resolve(process.argv[2] || join(root, '.cache/gemini-web-engine'));
const go = process.env.GO || 'go';
function run(command, args) {
  const result = spawnSync(command, args, { cwd: build, stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0' } });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
try {
  const manifest = JSON.parse(await readFile(join(root, 'gemini-engine.json'), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(manifest.engine.commit)) throw new Error('Engine source must be pinned');
  if (await sourceDigest(join(root, manifest.engine.path)) !== manifest.engine.sha256) throw new Error('Vendored engine source digest mismatch');
  await cp(join(root, manifest.engine.path), build, { recursive: true });
  for (const patch of (await readdir(join(root, 'engines/gemini-web/patches'))).filter(p => p.endsWith('.patch')).sort()) {
    run('git', ['apply', '--check', join(root, 'engines/gemini-web/patches', patch)]);
    run('git', ['apply', join(root, 'engines/gemini-web/patches', patch)]);
  }
  await cp(join(root, 'engines/gemini-web/cmd'), join(build, 'cmd'), { recursive: true });
  await cp(join(root, 'engines/gemini-web/internal'), join(build, 'internal'), { recursive: true });
  if (process.env.ROTATOR_ENGINE_TEST === '1') run(go, ['test', './cmd/rotator-engine', './internal/gemini', './internal/cookies', './internal/prompt', './internal/server', './internal/toolbridge', '-count=1']);
  await mkdir(resolve(output, '..'), { recursive: true });
  run(go, ['build', '-buildvcs=false', '-trimpath', '-ldflags', `-s -w -X main.sourceCommit=${manifest.engine.commit}`, '-o', output, './cmd/rotator-engine']);
  console.log(`Gemini Web engine: ${output} (source ${manifest.engine.commit})`);
} finally {
  await rm(build, { recursive: true, force: true });
}
