import { _electron as electron, chromium } from 'playwright';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';

export const PASS = 'Synthetic automation fixture only';
export const executable = process.env.KEYSHOAL_TEST_PACKAGE && path.resolve(process.env.KEYSHOAL_TEST_PACKAGE);
const windows = process.platform === 'win32';

async function openPackage(dir, env) {
  const args = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'];
  if (!windows) {
    args.push('--ozone-platform=x11');
    if (process.env.KEYSHOAL_TEST_ALLOW_NO_SANDBOX === '1') args.push('--no-sandbox');
  }
  const child = spawn(executable, args, { env, stdio: 'ignore' });
  let exit, browser;
  const ended = new Promise(resolve => {
    child.once('error', error => { exit = error.message; resolve(); });
    child.once('exit', (code, signal) => { exit = String(code ?? signal); resolve(); });
  });
  async function close() {
    const cdp = await browser?.newBrowserCDPSession().catch(() => null);
    // Ask Chromium to quit so the app can stop Bonjour and its native broker.
    // A broken renderer or CDP connection must not leave a process behind.
    if (cdp) void cdp.send('Browser.close').catch(() => {});
    await Promise.race([ended, delay(1500, undefined, { ref: false })]);
    if (!exit) child.kill();
    await ended;
    await browser?.close().catch(() => {});
  }
  try {
    let port;
    const deadline = Date.now() + 12_000;
    while (!port) {
      assert.equal(exit, undefined, 'Packaged Keyshoal exited before its UI was ready.');
      assert.ok(Date.now() < deadline, 'Packaged Keyshoal did not open its test-only loopback CDP listener.');
      try {
        const [value, socketPath] = readFileSync(path.join(dir, 'desktop', 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
        if (/^\d+$/.test(value) && socketPath?.startsWith('/devtools/browser/')) port = value;
      } catch (error) {
        // Chromium briefly holds the port file open exclusively on Windows.
        if (error.code !== 'ENOENT' && !(windows && error.code === 'EBUSY')) throw error;
      }
      if (!port) await delay(75);
    }
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10_000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 10_000 });
    await page.waitForURL(url => url.protocol === 'file:' && url.pathname.endsWith('/app.asar/index.html'), { timeout: 10_000 });
    return { page, app: { close, pid: child.pid } };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function instance() {
  const folder = mkdtempSync(path.join(tmpdir(), 'ks-'));
  const env = {
    ...process.env, XDG_CONFIG_HOME: path.join(folder, 'config'), XDG_CACHE_HOME: path.join(folder, 'cache'),
    XDG_RUNTIME_DIR: path.join(folder, 'run'),
    ...(windows ? { KEYSHOAL_DATA_DIR: path.join(folder, 'Windows vault') } : {})
  };
  for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME','XDG_RUNTIME_DIR']) mkdirSync(env[key], { mode: 0o700 });
  const clean = () => rmSync(folder, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  let app, page;
  try {
    if (executable) {
      ({ app, page } = await openPackage(env.KEYSHOAL_DATA_DIR || path.join(env.XDG_CONFIG_HOME, 'keyshoal'), env));
    } else {
      app = await electron.launch({
        args: [path.resolve('build/desktop'), ...(windows ? [] : ['--ozone-platform=x11'])],
        env, timeout: 20_000
      });
      page = await app.firstWindow({ timeout: 15_000 });
    }
    await page.getByRole('heading', { name: 'Create your vault' }).waitFor({ timeout: 8000 });
  } catch (failure) {
    await app?.close().catch(() => {});
    clean();
    throw failure;
  }
  return {
    app, page, env, folder,
    close: async () => { try { await app.close(); } finally { clean(); } }
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
export async function addLogin(page, origin, title = 'Demo login', beforeSave) {
  await page.getByRole('button', { name: 'New login' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Website').fill(origin);
  await page.getByLabel('Username').fill('demo-login');
  await page.getByRole('button', { name: 'Generate password' }).click();
  await page.waitForFunction(() => document.querySelector('[name=password]')?.value?.length === 28);
  const result = await page.locator('[name=password]').inputValue();
  assert.equal(await page.locator('[name=password]').getAttribute('type'), 'password');
  await beforeSave?.();
  await page.getByRole('button', { name: 'Save login' }).click();
  await page.getByRole('heading', { name: title }).waitFor();
  return result;
}
export async function evidence(page, file, app, { fullPage = false } = {}) {
  if (!process.env.KEYSHOAL_EVIDENCE) return;
  mkdirSync(process.env.KEYSHOAL_EVIDENCE, { recursive: true });
  const filename = path.join(process.env.KEYSHOAL_EVIDENCE, file);
  if (!app) return page.screenshot({ path: filename });
  const safe = await page.evaluate(() => {
    const visible = selector => document.querySelector(selector)?.checkVisibility();
    const masked = '••••••••••••';
    return !visible('#backup-value') && !visible('#recovery-value') && !visible('#qr-image') &&
      !visible('#editor-form [name=password]:not([type=password])') &&
      Array.from(document.querySelectorAll('#secret, [data-conflict-secret]')).every(node => node.textContent === masked);
  });
  assert.ok(safe, 'Refusing to capture displayed security material.');
  if (!windows && app.pid) {
    try {
      // Use the packaged window's Chromium surface. Its DOM can be ready
      // before Electron's first native X11 window becomes visible.
      const picture = await page.screenshot({ fullPage, timeout: 3500 });
      const { data } = PNG.sync.read(picture);
      const first = data.readUInt32LE(0);
      let different = 0;
      for (let i = 4; i < data.length && different <= 500; i += 4) {
        if (data.readUInt32LE(i) !== first) different++;
      }
      assert.ok(different > 500, 'The window surface appears blank.');
      writeFileSync(filename, picture);
      return;
    } catch {
      // Some Linux software-rendered displays need native X11 capture.
    }
  }
  if (windows) {
    try { return await page.screenshot({ fullPage, path: filename }); }
    catch {
      if (!app.evaluate) {
        const cdp = await page.context().newCDPSession(page);
        try {
          const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
          writeFileSync(filename, Buffer.from(data, 'base64'));
        } finally { await cdp.detach(); }
        return;
      }
      const encoded = await app.evaluate(async ({ BrowserWindow }) => {
        const picture = await BrowserWindow.getAllWindows()[0].capturePage();
        if (picture.isEmpty()) throw new Error('Windows desktop screenshot is empty.');
        return picture.toPNG().toString('base64');
      });
      writeFileSync(filename, Buffer.from(encoded, 'base64'));
      return;
    }
  }
  const xdotool = (args) => execFileSync(process.env.KEYSHOAL_XDOTOOL || 'xdotool', args, { encoding: 'utf8', timeout: 5000 });
  const handle = app.pid ? xdotool(['search', '--sync', '--all', '--pid', String(app.pid), '--name', '^Keyshoal$']).trim().split('\n')[0] :
    await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window.isVisible()) window.show();
    window.focus();
    return window.getNativeWindowHandle().readUInt32LE();
  });
  if (app.pid) xdotool(['windowmap', handle]);
  xdotool(['windowraise', String(handle)]);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // Capture only the app window on the isolated X11 display. Chromium's
  // compositor capture can fail on software-rendered CI runners.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'x11grab',
    '-draw_mouse', '0', '-window_id', String(handle), '-i', process.env.DISPLAY,
    '-frames:v', '1', '-threads', '1', filename], { timeout: 10_000 });
  assert.ok(statSync(filename).size > 5000, 'No meaningful desktop screenshot');
}
