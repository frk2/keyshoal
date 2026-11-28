import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, lstatSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getCurrentFuseWire, FuseV1Options as F, FuseState } from '@electron/fuses';

const file = path.resolve(process.argv[2]);
assert.equal(lstatSync(file).mode & 0o777, 0o755);
assert.equal(lstatSync(path.join(path.dirname(file), 'resources', 'app.asar')).mode & 0o777, 0o644);
const fuses = await getCurrentFuseWire(file);
assert.equal(fuses[F.RunAsNode], FuseState.DISABLE);
assert.equal(fuses[F.EnableNodeOptionsEnvironmentVariable], FuseState.DISABLE);
assert.equal(fuses[F.EnableNodeCliInspectArguments], FuseState.DISABLE);
assert.equal(fuses[F.OnlyLoadAppFromAsar], FuseState.ENABLE);
const folder = mkdtempSync(path.join(tmpdir(), 'keyshoal-package-'));
const runtime = path.join(folder, 'run');
mkdirSync(runtime, { mode: 0o700 });
const sandboxException = process.env.KEYSHOAL_TEST_ALLOW_NO_SANDBOX === '1';
const flags = ['--ozone-platform=x11'];
if (sandboxException) flags.push('--no-sandbox');
const child = spawn(file, flags, {
  env: { ...process.env, XDG_CONFIG_HOME: path.join(folder, 'config'), XDG_RUNTIME_DIR: runtime },
  stdio: ['ignore', 'ignore', 'pipe']
});
let errors = '';
child.stderr.on('data', data => { if (errors.length < 2000) errors += data; });
const gone = new Promise(resolve => child.once('exit', resolve));
try {
  const socket = path.join(runtime, 'keyshoal', 'host.sock');
  const until = Date.now() + 12_000;
  while (!lstatSync(socket, { throwIfNoEntry: false })?.isSocket()) {
    assert.equal(child.exitCode, null, errors || 'Packaged app exited.');
    assert.equal(child.signalCode, null, errors || 'Packaged app was killed.');
    assert.ok(Date.now() < until, errors || 'Packaged app did not initialize.');
    await delay(75);
  }
  assert.equal(lstatSync(socket).mode & 0o777, 0o600);
  console.log('Packaged Linux binary started with hardened fuses and its 0600 native socket.' +
    (sandboxException ? ' Synthetic test only: OS renderer sandbox not exercised.' : ' Linux renderer sandbox enabled.'));
} finally {
  child.kill();
  await gone;
  rmSync(folder, { recursive: true, force: true });
}
