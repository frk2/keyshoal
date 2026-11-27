import assert from 'node:assert/strict';
import { decodeSetup } from '@keyshoal/vault/protocol';
import { PASS, instance, createVault, addLogin, evidence } from './smoke-utils.mjs';

const runs = [];
const origin = 'https://sync.example.test';
const wait = { timeout: 24_000 };
const row = (page, text) => page.locator('#items button').filter({ hasText: text });
const revealButton = page => page.getByRole('button', { name: 'Reveal', exact: true });

async function link(run, code) {
  const { page } = run;
  await page.getByRole('button', { name: 'Use setup code' }).click();
  await page.getByLabel('Setup code').fill(code);
  await page.locator('#passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Join vault' }).click();
  await page.getByRole('heading', { name: 'Logins', exact: true }).waitFor(wait);
}
async function sync(run, action, stays = false) {
  const { page } = run;
  if (!(await page.getByRole('heading', { name: 'Devices' }).isVisible())) {
    await page.getByRole('button', { name: 'Devices', exact: true }).click();
  }
  await page.getByRole('button', { name: action + ' sync', exact: true }).click(wait);
  if (action === 'Pause') await page.locator('#sync-badge').filter({ hasText: 'Offline · sync paused' }).waitFor(wait);
  if (!stays) await page.getByRole('button', { name: 'Vault', exact: true }).click();
}
async function settled(run, peers) {
  await run.page.locator('#sync-badge').filter({ hasText: 'Synced with ' + peers + (peers === 1 ? ' peer' : ' peers') }).waitFor(wait);
}
async function edit(run, title, updatedTitle) {
  const { page } = run;
  await row(page, title).click(wait);
  await page.getByRole('button', { name: 'Edit', exact: true }).click(wait);
  await page.getByLabel('Title').fill(updatedTitle);
  const field = page.locator('[name=password]');
  const previous = await field.inputValue();
  await page.getByRole('button', { name: 'Generate password' }).click(wait);
  await page.waitForFunction(old => {
    const value = document.querySelector('[name=password]')?.value;
    return value?.length === 28 && value !== old;
  }, previous, wait);
  const value = await field.inputValue();
  await page.getByRole('button', { name: 'Save login' }).click(wait);
  await page.getByRole('heading', { name: updatedTitle, exact: true }).waitFor(wait);
  return value;
}
async function hasPassword(run, title, expected) {
  const { page } = run;
  await row(page, title).click(wait);
  await revealButton(page).click(wait);
  await page.waitForFunction(value => document.querySelector('#secret')?.textContent === value, expected, wait);
  await page.getByRole('button', { name: 'Hide', exact: true }).click(wait);
}

try {
  const a = await instance(); runs.push(a);
  await createVault(a.page);
  await sync(a, 'Pause');
  const original = await addLogin(a.page, origin, 'Shared demo account');
  await a.page.getByRole('button', { name: 'Devices', exact: true }).click();
  await a.page.getByRole('button', { name: 'Show setup QR' }).click();
  await a.page.getByAltText('Keyshoal peer setup code').waitFor(wait);
  await a.page.getByRole('button', { name: 'Hide setup QR' }).click();
  await a.page.getByRole('button', { name: 'Copy setup code' }).click();
  await a.page.getByText('Setup code copied.', { exact: false }).waitFor(wait);
  const code = await a.app.evaluate(({ clipboard }) => clipboard.readText());
  assert.ok(code.startsWith('keyshoal-v2:'));
  const b = await instance(); runs.push(b);
  const c = await instance(); runs.push(c);
  await link(b, code);
  await link(c, code);
  assert.equal(await row(b.page, 'Shared demo account').count(), 0);
  await sync(a, 'Resume');
  await Promise.all([settled(a, 2), settled(b, 2), settled(c, 2)]);
  await hasPassword(b, 'Shared demo account', original);
  await hasPassword(c, 'Shared demo account', original);

  for (const run of runs) await sync(run, 'Pause');
  const versionA = await edit(a, 'Shared demo account', 'Edited on A');
  const versionB = await edit(b, 'Shared demo account', 'Edited on B');
  assert.notEqual(versionA, versionB);
  assert.notEqual(versionA, original);
  await row(c.page, 'Shared demo account').waitFor(wait);

  await sync(b, 'Resume');
  await sync(c, 'Resume');
  await row(c.page, 'Edited on B').waitFor(wait);
  await settled(b, 1);
  assert.equal(await row(a.page, 'Edited on A').count(), 1);
  await sync(a, 'Resume');
  await Promise.all(runs.map(run => run.page.locator('#sync-badge').filter({ hasText: '1 conflict' }).waitFor(wait)));
  for (const run of runs) await sync(run, 'Pause');
  await b.page.locator('#items button').filter({ hasText: 'Conflict' }).click(wait);
  await b.page.getByRole('heading', { name: /Version \d · Edited on A/ }).waitFor(wait);
  const option = b.page.locator('#conflict-versions section').filter({ hasText: 'Edited on B' });
  await option.getByRole('button', { name: /Reveal version/ }).click(wait);
  await option.getByText(versionB, { exact: true }).waitFor(wait);
  await option.getByRole('button', { name: /Reveal version/ }).click(wait); // no secret in evidence
  await b.page.locator('#sync-badge').filter({ hasText: 'Offline · sync paused' }).waitFor(wait);
  await evidence(b.page, '05-peer-conflict-offline.png', b.app);
  await option.getByRole('button', { name: /Keep version/ }).click(wait);
  await b.page.getByRole('heading', { name: 'Edited on B', exact: true }).waitFor(wait);

  // The choice survives a full lock and reopen while both other devices are paused.
  await b.page.getByRole('button', { name: 'Lock', exact: true }).click();
  await b.page.getByRole('heading', { name: 'Unlock Keyshoal' }).waitFor(wait);
  await b.page.locator('#passphrase').fill(PASS);
  await b.page.locator('#key').fill(decodeSetup(code).key);
  await b.page.getByRole('button', { name: 'Unlock vault' }).click();
  await hasPassword(b, 'Edited on B', versionB);
  await b.page.locator('#sync-badge').filter({ hasText: 'Offline · saved on this device' }).waitFor(wait);

  // The first device never participates in this reconciliation.
  await sync(c, 'Resume');
  await hasPassword(c, 'Edited on B', versionB);
  await settled(c, 1);
  await evidence(c.page, '06-peer-converged.png', c.app);

  // A fully independent replica deletes offline, then gossips its tombstone
  // to the original device while the peer that chose the version is offline.
  await sync(b, 'Pause');
  await sync(c, 'Pause');
  await c.page.getByRole('button', { name: 'Delete', exact: true }).click(wait);
  await c.page.getByRole('button', { name: 'Delete login', exact: true }).click(wait);
  await c.page.getByRole('heading', { name: 'No logins yet' }).waitFor(wait);
  await sync(c, 'Resume');
  await sync(a, 'Resume');
  await a.page.getByRole('heading', { name: 'No logins yet' }).waitFor(wait);
  await settled(a, 1);
  console.log('Peer UI smoke passed: three Bonjour replicas, offline create/edit/delete, non-creator sync, offline conflict choice, deletion propagation, and sync status on every node.');
} finally {
  for (const run of runs.reverse()) await run.close();
}
