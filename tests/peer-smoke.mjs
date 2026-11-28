import assert from 'node:assert/strict';
import { decodeSetup } from '@keyshoal/vault/protocol';
import { PASS, instance, createVault, addLogin, evidence } from './smoke-utils.mjs';
import { link, sync, settled, edit, scanSetup, wait, row, revealButton } from './peer-ui-utils.mjs';

const runs = [];
const origin = 'https://sync.example.test';
const shot = (run, file, options) => evidence(run.page, 'peer-' + file + '.png', run.app, options);

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
  const code = await scanSetup(a);
  const { key } = decodeSetup(code);
  const b = await instance(); runs.push(b);
  const c = await instance(); runs.push(c);
  await link(b, code);
  await link(c, code);
  assert.equal(await row(b.page, 'Shared demo account').count(), 0);
  await sync(a, 'Resume');
  await Promise.all([settled(a, 2), settled(b, 2), settled(c, 2)]);
  await hasPassword(b, 'Shared demo account', original);
  await hasPassword(c, 'Shared demo account', original);
  await a.page.getByRole('button', { name: 'Devices', exact: true }).click(wait);
  await settled(a, 2);
  await shot(a, '01-two-peers-synced');

  for (const run of runs) await sync(run, 'Pause');
  const versionA = await edit(a, 'Shared demo account', 'Edited on A');
  const versionB = await edit(b, 'Shared demo account', 'Edited on B');
  assert.notEqual(versionA, versionB);
  assert.notEqual(versionA, original);
  await row(c.page, 'Shared demo account').waitFor(wait);
  await shot(a, '02-saved-offline');

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
  await shot(b, '03-choose-conflicting-version', { fullPage: true });
  await option.getByRole('button', { name: /Keep version/ }).click(wait);
  await b.page.getByRole('heading', { name: 'Edited on B', exact: true }).waitFor(wait);

  // The choice survives a full lock and reopen while both other devices are paused.
  await b.page.getByRole('button', { name: 'Lock', exact: true }).click();
  await b.page.getByRole('heading', { name: 'Unlock Keyshoal' }).waitFor(wait);
  await b.page.locator('#passphrase').fill(PASS);
  await b.page.locator('#key').fill(key);
  await b.page.getByRole('button', { name: 'Unlock vault' }).click();
  await hasPassword(b, 'Edited on B', versionB);
  await b.page.locator('#sync-badge').filter({ hasText: 'Offline · saved on this device' }).waitFor(wait);
  await shot(b, '04-choice-survives-reopen-offline');

  // The first device never participates in this reconciliation.
  await sync(c, 'Resume');
  await hasPassword(c, 'Edited on B', versionB);
  await settled(c, 1);
  await shot(c, '05-choice-reaches-other-peer');

  // A fully independent replica deletes offline, then gossips its tombstone
  // to the original device while the peer that chose the version is offline.
  await sync(b, 'Pause');
  await sync(c, 'Pause');
  await c.page.getByRole('button', { name: 'Delete', exact: true }).click(wait);
  await c.page.getByRole('button', { name: 'Delete login', exact: true }).click(wait);
  await c.page.getByRole('heading', { name: 'No logins yet' }).waitFor(wait);
  await shot(c, '06-deleted-offline');
  await sync(c, 'Resume');
  await sync(a, 'Resume');
  await a.page.getByRole('heading', { name: 'No logins yet' }).waitFor(wait);
  await settled(a, 1);
  await shot(a, '07-delete-reached-other-peer');
  console.log('Peer UI smoke passed: three Bonjour replicas, offline create/edit/delete, non-creator sync, offline conflict choice, deletion propagation, and sync status on every node.');
} finally {
  for (const run of runs.reverse()) await run.close();
}
