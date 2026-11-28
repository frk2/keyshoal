import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PASS, instance, createVault, addLogin, evidence } from './smoke-utils.mjs';

const run = await instance();
const { page, env } = run;
try {
  await evidence(page, '01-desktop-create.png', run.app);
  const key = await createVault(page);
  const secret = await addLogin(page, 'https://login.example.test', 'Demo account');
  assert.equal(await page.locator('#secret').textContent(), '••••••••••••');
  await evidence(page, '02-desktop-vault.png', run.app);
  await page.getByRole('button', { name: 'Reveal' }).click();
  await page.waitForFunction(expected => document.getElementById('secret').textContent === expected, secret);
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  assert.equal(await page.locator('#secret').textContent(), '••••••••••••');
  const file = path.join(env.KEYSHOAL_DATA_DIR || path.join(env.XDG_CONFIG_HOME, 'keyshoal'), 'logins.vault');
  const binary = readFileSync(file);
  for (const text of [secret, key, PASS, 'Demo account', 'demo-login', 'https://login.example.test']) {
    assert.equal(binary.includes(text), false);
  }
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('tests/check-windows-vault-acl.ps1'), file],
      { windowsHide: true, stdio: 'inherit', timeout: 12000 });
  } else assert.equal(statSync(file).mode & 0o777, 0o600);
  await page.getByRole('button', { name: 'Devices' }).click();
  assert.match(await page.locator('#bridge-status').textContent(), /bridge is ready/);
  await evidence(page, '03-desktop-devices.png', run.app);
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await page.getByRole('heading', { name: 'Unlock Keyshoal' }).waitFor();
  assert.equal(await page.getByText('Demo account', { exact: true }).count(), 0);
  async function unlock(inputKey) {
    await page.locator('#passphrase').fill(PASS);
    await page.locator('#key').fill(inputKey);
    await page.getByRole('button', { name: 'Unlock vault' }).click();
  }
  await unlock('0'.repeat(64));
  await page.getByText(/Wrong security key or passphrase/).waitFor();
  await unlock(key);
  await page.locator('#items button').filter({ hasText: 'Demo account' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Title').fill('Edited account');
  await page.getByRole('button', { name: 'Save login' }).click();
  await page.getByRole('heading', { name: 'Edited account' }).waitFor();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete login' }).click();
  await page.getByRole('heading', { name: 'No logins yet' }).waitFor();
  console.log('Desktop smoke passed: create, mask/reveal/hide, private ciphertext, lock/wrong key/reopen, edit, delete, native bridge ready.');
} finally {
  await run.close();
}
