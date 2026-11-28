import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getCurrentFuseWire, FuseV1Options as F, FuseState } from '@electron/fuses';

const executable = path.resolve(process.argv[2]);
const host = path.join(path.dirname(executable), 'chrome', 'keyshoal-chrome-host.exe');
const fuses = await getCurrentFuseWire(executable);
for (const fuse of [F.RunAsNode, F.EnableNodeOptionsEnvironmentVariable, F.EnableNodeCliInspectArguments]) {
  assert.equal(fuses[fuse], FuseState.DISABLE);
}
for (const fuse of [F.OnlyLoadAppFromAsar, F.EnableEmbeddedAsarIntegrityValidation]) {
  assert.equal(fuses[fuse], FuseState.ENABLE);
}
const temp = mkdtempSync(path.join(tmpdir(), 'keyshoal-package-'));
const child = spawn(executable, [], {
  windowsHide: true,
  env: { ...process.env, KEYSHOAL_DATA_DIR: path.join(temp, 'Vault with spaces') },
  stdio: ['ignore', 'ignore', 'ignore']
});
const ended = new Promise(resolve => {
  child.once('error', resolve);
  child.once('exit', resolve);
});
function runHost(args, input) {
  return new Promise((resolve, reject) => {
    const process = spawn(host, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    const timer = setTimeout(() => process.kill(), 5500);
    process.stdout.on('data', chunk => {
      chunks.push(chunk);
      if (chunks.reduce((total, item) => total + item.length, 0) > 4096) process.kill();
    });
    process.stdin.on('error', () => {});
    process.once('error', error => { clearTimeout(timer); reject(error); });
    process.once('close', code => { clearTimeout(timer); resolve({ code, data: Buffer.concat(chunks) }); });
    process.stdin.end(input);
  });
}
try {
  const json = Buffer.from(JSON.stringify({ action: 'list', origin: 'https://example.test' }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length);
  const frame = Buffer.concat([header, json]);
  const extension = 'chrome-extension://' + 'a'.repeat(32) + '/';
  let locked = false;
  for (let i = 0; i < 30 && !locked; i++) {
    assert.equal(child.exitCode, null, 'The packaged executable exited before its private bridge was ready.');
    const { code, data } = await runHost([extension], frame);
    if (code === 0 && data.length > 4 && data.readUInt32LE() === data.length - 4) {
      locked = /open and unlock/i.test(JSON.parse(data.subarray(4).toString()).error);
    }
    if (!locked) await delay(350);
  }
  assert.ok(locked, 'The packaged app did not answer through its real private Windows pipe.');
  const malformedOrigin = await runHost(['https://example.test/'], frame);
  assert.notEqual(malformedOrigin.code, 0);
  assert.equal(malformedOrigin.data.length, 0);
  const shared = path.join(temp, 'Existing non-Keyshoal directory');
  mkdirSync(shared);
  const rejected = await runHost(['--private-directory', shared]);
  assert.equal(rejected.code, 1, 'Must not alter permissions on an existing unprotected directory.');
  const duplicate = await runHost(['--broker', String(process.pid)]);
  assert.equal(duplicate.code, 1);
  assert.equal(duplicate.data.length, 0);
  console.log('Packaged Windows app started with its hardened fuses and real per-user pipe. The host rejected a bad origin and refused a duplicate broker.');
} finally {
  child.kill();
  await ended;
  await delay(350);
  rmSync(temp, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
}
