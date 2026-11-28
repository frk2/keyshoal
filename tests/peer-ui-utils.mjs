import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { PASS } from './smoke-utils.mjs';

export const wait = { timeout: 24_000 };
export const row = (page, text) => page.locator('#items button').filter({ hasText: text });
export const revealButton = page => page.getByRole('button', { name: 'Reveal', exact: true });

export async function link(run, code) {
  const { page } = run;
  await page.getByRole('button', { name: 'Use setup code' }).click();
  await page.getByLabel('Setup code').fill(code);
  await page.locator('#passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Join vault' }).click();
  await page.getByRole('heading', { name: 'Logins', exact: true }).waitFor(wait);
}
export async function sync(run, action, stays = false) {
  const { page } = run;
  if (!(await page.getByRole('heading', { name: 'Devices' }).isVisible())) {
    await page.getByRole('button', { name: 'Devices', exact: true }).click();
  }
  await page.getByRole('button', { name: action + ' sync', exact: true }).click(wait);
  if (action === 'Pause') await page.locator('#sync-badge').filter({ hasText: 'Offline · sync paused' }).waitFor(wait);
  if (!stays) await page.getByRole('button', { name: 'Vault', exact: true }).click();
}
export async function settled(run, peers) {
  await run.page.locator('#sync-badge').filter({ hasText: 'Synced with ' + peers + (peers === 1 ? ' peer' : ' peers') }).waitFor(wait);
}
export async function edit(run, title, updatedTitle) {
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
export async function scanSetup(run) {
  if (!(await run.page.getByRole('heading', { name: 'Devices' }).isVisible())) {
    await run.page.getByRole('button', { name: 'Devices', exact: true }).click();
  }
  await run.page.getByRole('button', { name: 'Show setup QR' }).click();
  const qr = run.page.getByAltText('Keyshoal peer setup code');
  await qr.waitFor(wait);
  // Scan the actual rendered pairing image internally. It carries recovery
  // material and must never appear in build logs or visual artifacts.
  const data = await qr.getAttribute('src');
  assert.ok(data?.startsWith('data:image/png;base64,'), 'Expected a PNG pairing QR.');
  const { width, height, data: pixels } = PNG.sync.read(Buffer.from(data.split(',')[1], 'base64'));
  const code = jsQR(new Uint8ClampedArray(pixels), width, height)?.data;
  assert.ok(code?.startsWith('keyshoal-v2:'), 'Pairing QR did not decode.');
  await run.page.getByRole('button', { name: 'Hide setup QR' }).click();
  await run.page.getByRole('button', { name: 'Copy setup code' }).click();
  await run.page.getByText('Setup code copied.', { exact: false }).waitFor(wait);
  if (run.app.evaluate) {
    const copied = await run.app.evaluate(({ clipboard }) => clipboard.readText());
    assert.ok(copied === code, 'The copied setup code must match the QR.');
  }
  return code;
}
