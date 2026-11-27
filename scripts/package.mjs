import { packager } from '@electron/packager';
import { flipFuses, FuseV1Options as F, FuseVersion } from '@electron/fuses';
import { chmod, cp, lstat, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
if (process.argv[2] !== 'linux' || process.platform !== 'linux') throw new Error('Run package:linux on Linux.');
execFileSync(process.execPath, ['scripts/build-desktop.mjs'], { stdio: 'inherit' });
const [directory] = await packager({
  dir: 'build/desktop',
  name: 'keyshoal',
  executableName: 'keyshoal',
  electronVersion: '45.5.0',
  arch: process.arch,
  platform: 'linux',
  out: 'dist',
  overwrite: true,
  asar: true,
  prune: false
});
await flipFuses(path.join(directory, 'keyshoal'), {
  version: FuseVersion.V1,
  [F.RunAsNode]: false,
  [F.EnableNodeOptionsEnvironmentVariable]: false,
  [F.EnableNodeCliInspectArguments]: false,
  [F.OnlyLoadAppFromAsar]: true
});
await mkdir(path.join(directory, 'chrome'), { recursive: true });
await Promise.all([
  cp('extension', path.join(directory, 'chrome', 'extension'), { recursive: true }),
  cp('build/keyshoal-chrome-host', path.join(directory, 'chrome', 'keyshoal-chrome-host')),
  cp('scripts/install-chrome-host.sh', path.join(directory, 'chrome', 'install-chrome-host.sh')),
  cp('README.md', path.join(directory, 'README.md')),
  cp('docs', path.join(directory, 'docs'), { recursive: true })
]);
// Distribution files (never user data) must stay usable after a root-owned
// installation even if the build or Electron cache used a private umask.
async function distributionMode(file) {
  const stat = await lstat(file);
  if (stat.isDirectory()) {
    await chmod(file, 0o755);
    await Promise.all((await readdir(file)).map(child => distributionMode(path.join(file, child))));
  } else if (stat.isFile()) {
    await chmod(file, (stat.mode & 0o111) ? 0o755 : 0o644);
  }
}
await distributionMode(directory);
const filename = directory + '.tar.xz';
execFileSync('tar', ['-cJf', filename, '-C', path.dirname(directory), path.basename(directory)], {
  env: { ...process.env, XZ_OPT: '-T2 -3' }, stdio: 'inherit'
});
console.log(filename);
