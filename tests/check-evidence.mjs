import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const suites = {
  desktop: [
    'create-vault', 'add-login', 'saved-login', 'copy-masked', 'devices-and-chrome',
    'locked', 'search', 'edit-login', 'confirm-delete', 'deleted'
  ],
  peer: [
    'two-peers-synced', 'saved-offline', 'choose-conflicting-version', 'choice-survives-reopen-offline',
    'choice-reaches-other-peer', 'deleted-offline', 'delete-reached-other-peer'
  ],
  chrome: [
    'select-login', 'filled-awaiting-review', 'filled-form-masked', 'wrong-origin', 'unsafe-target',
    'registration-field', 'conflict-blocked', 'fills-resolved-login', 'deleted-login-unavailable', 'locked-vault'
  ]
};
const folder = process.env.KEYSHOAL_EVIDENCE;
assert.ok(folder, 'KEYSHOAL_EVIDENCE is required to verify screenshots.');
const names = Object.entries(suites).flatMap(([suite, names]) =>
  names.map((name, index) => suite + '-' + String(index + 1).padStart(2, '0') + '-' + name + '.png'));
assert.deepEqual(readdirSync(folder).sort(), names.sort(), 'A screenshot is missing or unexpected.');
for (const name of names) {
  const { width, height, data } = PNG.sync.read(readFileSync(path.join(folder, name)));
  assert.ok(width >= 260 && height >= 100, name + ' is too small to be useful.');
  const first = data.readUInt32LE(0);
  let different = 0;
  for (let i = 4; i < data.length; i += 4) {
    if (data.readUInt32LE(i) !== first) different++;
  }
  assert.ok(different > 500, name + ' appears blank.');
}
console.log('Validated ' + names.length + ' named, non-blank PNGs from the desktop, peers, and real Chrome extension.');
