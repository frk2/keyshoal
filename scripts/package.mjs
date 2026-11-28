import { packager } from '@electron/packager';
import { flipFuses, FuseV1Options as F, FuseVersion } from '@electron/fuses';
import { chmod, cp, lstat, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const platform = { linux: 'linux', windows: 'win32' }[process.argv[2]];
if (!platform || platform !== process.platform) throw new Error('Use package:linux on Linux or package:windows on Windows.');
const windows = platform === 'win32';
const host = windows ? 'keyshoal-chrome-host.exe' : 'keyshoal-chrome-host';
const installer = windows ? 'install-chrome-host.ps1' : 'install-chrome-host.sh';
execFileSync(process.execPath, ['scripts/build-desktop.mjs'], { stdio: 'inherit' });
const [directory] = await packager({
  dir: 'build/desktop',
  name: 'keyshoal',
  executableName: 'keyshoal',
  electronVersion: '45.5.0',
  arch: process.arch,
  platform,
  out: 'dist',
  overwrite: true,
  asar: true,
  prune: false
});
await flipFuses(path.join(directory, windows ? 'keyshoal.exe' : 'keyshoal'), {
  version: FuseVersion.V1,
  [F.RunAsNode]: false,
  [F.EnableNodeOptionsEnvironmentVariable]: false,
  [F.EnableNodeCliInspectArguments]: false,
  [F.OnlyLoadAppFromAsar]: true,
  ...(windows ? { [F.EnableEmbeddedAsarIntegrityValidation]: true } : {})
});
await mkdir(path.join(directory, 'chrome'), { recursive: true });
await Promise.all([
  cp('extension', path.join(directory, 'chrome', 'extension'), { recursive: true }),
  cp(path.join('build', host), path.join(directory, 'chrome', host)),
  cp(path.join('scripts', installer), path.join(directory, 'chrome', installer)),
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
const filename = directory + (windows ? '.zip' : '.tar.xz');
if (windows) {
  const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
  execFileSync(tar, ['-acf', filename, '-C', path.dirname(directory), path.basename(directory)], { stdio: 'inherit' });
} else {
  await distributionMode(directory);
  execFileSync('tar', ['-cJf', filename, '-C', path.dirname(directory), path.basename(directory)], {
    env: { ...process.env, XZ_OPT: '-T2 -3' }, stdio: 'inherit'
  });
}
console.log(filename);
