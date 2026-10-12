import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const root = resolve(process.env.CONSOLE_RELEASE_ROOT ?? '.runtime/console-release');
const releases = join(root, 'releases');
mkdirSync(releases, { recursive: true, mode: 0o700 });
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const files = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name), prefix + e.name + '/') : [prefix + e.name]).sort();
function verify(id) {
  if (!/^[a-f0-9]{12}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid release ID');
  const directory = join(releases, id), manifest = JSON.parse(readFileSync(join(directory, 'release.json'), 'utf8'));
  if (manifest.id !== id || !manifest.files['index.html'] || !manifest.files['gateway.mjs']) throw new Error('Invalid release manifest');
  for (const [name, checksum] of Object.entries(manifest.files)) {
    if (name.includes('..') || name.startsWith('/') || digest(join(directory, name)) !== checksum) throw new Error('Release checksum mismatch');
  }
  return manifest;
}
function point(name, id) {
  const temp = join(root, name + '.next');
  rmSync(temp, { force: true }); symlinkSync(join(releases, id), temp); renameSync(temp, join(root, name));
}
const action = process.argv[2];
if (action === 'prepare') {
  if (git('status', '--porcelain')) throw new Error('Commit source before preparing a release');
  execFileSync('npm', ['run', 'build:console'], { stdio: 'inherit' });
  const revision = git('rev-parse', 'HEAD'), build = resolve('apps/console/dist');
  const checksums = Object.fromEntries(files(build).map(f => [f, digest(join(build, f))]));
  checksums['gateway.mjs'] = digest('apps/console/deploy/gateway.mjs');
  const content = createHash('sha256').update(JSON.stringify(checksums)).digest('hex');
  const id = revision.slice(0, 12) + '-' + content.slice(0, 12), directory = join(releases, id);
  if (!existsSync(directory)) {
    const staging = directory + '.partial'; rmSync(staging, { recursive: true, force: true });
    cpSync(build, staging, { recursive: true });
    cpSync('apps/console/deploy/gateway.mjs', join(staging, 'gateway.mjs'));
    writeFileSync(join(staging, 'release.json'), JSON.stringify({ id, revision, built_at: new Date().toISOString(), files: checksums }, null, 2) + '\n');
    renameSync(staging, directory);
  }
  verify(id); writeFileSync(join(root, 'prepared'), id + '\n', { mode: 0o600 }); console.log(JSON.stringify({ prepared: id, revision }));
} else if (action === 'activate' || action === 'rollback') {
  const id = action === 'rollback' ? realpathSync(join(root, 'previous')).split('/').pop() : process.argv[3] ?? readFileSync(join(root, 'prepared'), 'utf8').trim();
  verify(id);
  const prior = existsSync(join(root, 'current')) ? realpathSync(join(root, 'current')).split('/').pop() : null;
  point('current', id);
  if (prior && prior !== id) point('previous', prior);
  writeFileSync(join(root, 'activation.json'), JSON.stringify({ release: id, previous: prior, activated_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ release: id, previous: prior }));
} else if (action === 'verify') {
  console.log(JSON.stringify({ result: 'PASSED', release: verify(realpathSync(join(root, 'current')).split('/').pop()).id }));
} else throw new Error('Usage: release-console prepare|activate [id]|rollback|verify');
