import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

export const PASS = 'Synthetic automation fixture only';
export async function instance() {
  const folder = mkdtempSync(path.join(tmpdir(), 'ks-'));
  const env = {
    ...process.env, XDG_CONFIG_HOME: path.join(folder, 'config'), XDG_CACHE_HOME: path.join(folder, 'cache'),
    XDG_RUNTIME_DIR: path.join(folder, 'run')
  };
  for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME','XDG_RUNTIME_DIR']) mkdirSync(env[key], { mode: 0o700 });
  let app, page;
  try {
    app = await electron.launch({
      args: [path.resolve('build/desktop'), '--ozone-platform=x11'],
      env, timeout: 20_000
    });
    page = await app.firstWindow({ timeout: 15_000 });
    await page.getByRole('heading', { name: 'Create your vault' }).waitFor({ timeout: 8000 });
  } catch (failure) {
    await app?.close().catch(() => {});
    rmSync(folder, { recursive: true, force: true });
    throw failure;
  }
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
  const handle = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window.isVisible()) window.show();
    window.focus();
    return window.getNativeWindowHandle().readUInt32LE();
  });
  execFileSync(process.env.KEYSHOAL_XDOTOOL || 'xdotool', ['windowraise', String(handle)], { timeout: 5000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // Capture only the app window on the isolated X11 display. Chromium's
  // compositor capture can fail on software-rendered CI runners.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'x11grab',
    '-draw_mouse', '0', '-window_id', String(handle), '-i', process.env.DISPLAY,
    '-frames:v', '1', '-threads', '1', filename], { timeout: 10_000 });
  assert.ok(statSync(filename).size > 5000, 'No meaningful desktop screenshot');
}
