import { build } from 'esbuild';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const out = 'build/desktop';
await mkdir(out, { recursive: true });
await build({
  entryPoints: ['desktop/main.js'],
  bundle: true,
  outfile: out + '/main.mjs',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  legalComments: 'linked',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }
});
await Promise.all(['index.html', 'style.css', 'renderer.js', 'preload.cjs'].map(file => cp('desktop/' + file, out + '/' + file)));
await writeFile(out + '/package.json', JSON.stringify({
  name: 'keyshoal', productName: 'Keyshoal', version: '0.1.0', main: 'main.mjs'
}));
if (process.platform === 'linux') {
  execFileSync(process.env.CC || 'cc', [
    '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_GNU_SOURCE', '-D_FORTIFY_SOURCE=2', '-fstack-protector-strong',
    '-fPIE', '-pie', '-Wl,-z,relro,-z,now', 'desktop/chrome-host.c', '-o', 'build/keyshoal-chrome-host'
  ], { stdio: 'inherit' });
} else if (process.platform === 'win32') {
  execFileSync(process.env.KEYSHOAL_CC || 'cl.exe', [
    '/nologo', '/TC', '/std:c11', '/W4', '/WX', '/O2', '/MT', '/GS', '/guard:cf',
    '/Fobuild/keyshoal-chrome-host-win.obj', '/Febuild/keyshoal-chrome-host.exe',
    'desktop/chrome-host-win.c', '/link', 'advapi32.lib', '/DYNAMICBASE', '/NXCOMPAT', '/HIGHENTROPYVA', '/GUARD:CF'
  ], { stdio: 'inherit' });
}
