import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

export const PASS = 'Synthetic automation fixture only';
export async function instance() {
  const folder = mkdtempSync(path.join(tmpdir(), 'ks-'));
  const env = {
    ...process.env, XDG_CONFIG_HOME: path.join(folder, 'config'), XDG_CACHE_HOME: path.join(folder, 'cache'),
    XDG_RUNTIME_DIR: path.join(folder, 'run')
  };
  for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME','XDG_RUNTIME_DIR']) mkdirSync(env[key], { mode: 0o700 });
  const app = await electron.launch({
    args: [path.resolve('build/desktop'), '--ozone-platform=x11'],
    env, timeout: 20_000
  });
  const page = await app.firstWindow({ timeout: 15_000 });
  await page.getByRole('heading', { name: 'Create your vault' }).waitFor({ timeout: 8000 });
  return {
    app, page, env, folder,
    close: async () => { await app.close(); rmSync(folder, { recursive: true, force: true }); }
  };
}
export async function createVault(page) {
  await page.locator('#passphrase').fill(PASS);
  await page.locator('#confirm').fill(PASS);
  await page.getByRole('button', { name: 'Create vault' }).click();
  const key = await page.locator('#backup-value').textContent({ timeout: 15_000 });
  assert.match(key, /^[a-f0-9]{64}$/);
  await page.getByRole('button', { name: 'I saved my security key' }).click();
  return key;
}
export async function addLogin(page, origin, title = 'Demo login') {
  await page.getByRole('button', { name: 'New login' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Website').fill(origin);
  await page.getByLabel('Username').fill('demo-login');
  await page.getByRole('button', { name: 'Generate password' }).click();
  await page.waitForFunction(() => document.querySelector('[name=password]')?.value?.length === 28);
  const result = await page.locator('[name=password]').inputValue();
  await page.getByRole('button', { name: 'Save login' }).click();
  await page.getByRole('heading', { name: title }).waitFor();
  return result;
}
export async function evidence(page, file, app) {
  if (!process.env.KEYSHOAL_EVIDENCE) return;
  mkdirSync(process.env.KEYSHOAL_EVIDENCE, { recursive: true });
  const filename = path.join(process.env.KEYSHOAL_EVIDENCE, file);
  if (!app) return page.screenshot({ path: filename });
  const data = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window.isVisible()) window.show();
    return (await window.capturePage()).toPNG().toString('base64');
  });
  const png = Buffer.from(data, 'base64');
  assert.ok(png.length > 5000, 'No meaningful desktop screenshot');
  writeFileSync(filename, png);
}
