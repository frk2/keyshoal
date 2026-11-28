import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { chromium } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { instance, createVault, addLogin } from './smoke-utils.mjs';

const run = await instance();
const extension = path.resolve('extension');
const windows = process.platform === 'win32';
const cdpAction = windows || process.env.KEYSHOAL_TEST_CDP_ACTION === '1';
let id = createHash('sha256').update(extension).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, hex => String.fromCharCode(97 + Number.parseInt(hex, 16)));
const xdotool = (...args) => execFileSync(process.env.KEYSHOAL_XDOTOOL || 'xdotool', args, { encoding: 'utf8', timeout: 5000 }).trim();
let browser, server, uninstall;
try {
  const cert = path.join(run.folder, 'fixture-cert.pem');
  const key = path.join(run.folder, 'fixture-key.pem');
  execFileSync(process.env.KEYSHOAL_TEST_OPENSSL || 'openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-days', '1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    const other = req.url === '/external' ? 'https://localhost:1/collect' : '/submit';
    const autocomplete = req.url === '/register' ? 'new-password' : 'current-password';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Keyshoal Chrome fixture</title><main><h1>Keyshoal Chrome fixture</h1>
      <form method="post" action="${other}">
      <label>Username<input autocomplete="username" type="email"></label>
      <label>Password<input autocomplete="${autocomplete}" type="password"></label>
      <button type="submit">Sign in</button></form></main>`);
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const dir = path.join(run.folder, 'packaged-host');
  mkdirSync(dir);
  const profile = path.join(run.folder, 'browser');
  if (!windows) {
    cpSync('build/keyshoal-chrome-host', path.join(dir, 'keyshoal-chrome-host'));
    cpSync('scripts/install-chrome-host.sh', path.join(dir, 'install-chrome-host.sh'));
    execFileSync(path.join(dir, 'install-chrome-host.sh'), [id, 'google-chrome-for-testing', profile], { env: run.env });
  }
  const port = server.address().port;
  const origin = 'https://127.0.0.1:' + port;
  await createVault(run.page);
  await run.page.getByRole('button', { name: 'Devices', exact: true }).click();
  const pause = run.page.getByRole('button', { name: 'Pause sync', exact: true });
  if (await pause.isVisible()) await pause.click();
  await run.page.locator('#sync-badge').filter({ hasText: 'Offline' }).waitFor();
  await run.page.getByRole('button', { name: 'Vault', exact: true }).click();
  const password = await addLogin(run.page, origin);
  browser = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: false, ignoreDefaultArgs: ['--disable-extensions'], ignoreHTTPSErrors: true, env: {
      ...run.env, XDG_SESSION_TYPE: 'x11'
    },
    args: [
      ...(windows ? [] : ['--ozone-platform=x11']),
      ...(cdpAction ? ['--enable-unsafe-extension-debugging'] : []),
      '--disable-extensions-except=' + extension, '--load-extension=' + extension
    ]
  });
  const page = browser.pages()[0];
  const inspect = await browser.newCDPSession(page);
  const browserCDP = cdpAction ? await browser.browser().newBrowserCDPSession() : null;
  if (windows) {
    const { extensions } = await browserCDP.send('Extensions.getExtensions');
    id = extensions.find(candidate => candidate.name === 'Keyshoal')?.id;
    assert.match(id, /^[a-p]{32}$/);
    const helper = path.join(dir, 'install-chrome-host.ps1');
    cpSync('build/keyshoal-chrome-host.exe', path.join(dir, 'keyshoal-chrome-host.exe'));
    cpSync('scripts/install-chrome-host.ps1', helper);
    const runInstaller = (...args) => execFileSync(process.env.KEYSHOAL_TEST_POWERSHELL || 'powershell.exe', [
      '-NoProfile', '-File', helper, '-ManifestDirectory', dir, ...args
    ], { env: run.env, windowsHide: true, timeout: 12000, stdio: 'ignore' });
    uninstall = () => runInstaller('-Uninstall');
    runInstaller('-ExtensionId', id);
  }
  const popupUrl = 'chrome-extension://' + id + '/popup.html';
  async function poll(check, message) {
    const until = Date.now() + 5000;
    do {
      const result = await check();
      if (result) return result;
      await delay(75);
    } while (Date.now() < until);
    throw new Error(message);
  }
  async function action(url, text) {
    await page.goto(url);
    await page.bringToFront();
    if (browserCDP) {
      const { targetInfos } = await browserCDP.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
      assert.equal(targetInfos.length, 1, 'The browser smoke uses a single disposable tab.');
      await browserCDP.send('Extensions.triggerAction', { id, targetId: targetInfos[0].targetId });
    } else {
      const win = xdotool('search', '--sync', '--name', 'Keyshoal Chrome fixture').split('\n').at(-1);
      xdotool('windowfocus', '--sync', win);
      xdotool('key', '--clearmodifiers', 'alt+shift+k');
    }
    // Chrome action popups are browser-owned targets and do not appear in
    // Playwright's normal BrowserContext pages, so inspect that real target.
    const target = await poll(async () => (await inspect.send('Target.getTargets')).targetInfos.find(
      info => info.url === popupUrl
    ), 'The Chrome action popup did not open.');
    const { sessionId } = await inspect.send('Target.attachToTarget', { targetId: target.targetId });
    let counter = 0;
    const pending = new Map();
    const listener = event => {
      if (event.sessionId !== sessionId) return;
      const reply = JSON.parse(event.message);
      pending.get(reply.id)?.(reply);
    };
    inspect.on('Target.receivedMessageFromTarget', listener);
    async function command(method, params = {}) {
      const id = ++counter;
      let timer;
      const answer = new Promise((resolve, reject) => {
        pending.set(id, resolve);
        timer = setTimeout(() => reject(new Error(method + ' timed out')), 5000);
      });
      try {
        await inspect.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
        const reply = await answer;
        if (reply.error) throw new Error(reply.error.message);
        return reply.result;
      } finally { clearTimeout(timer); pending.delete(id); }
    }
    const evaluate = async expression => {
      const result = await command('Runtime.evaluate', { expression, returnByValue: true });
      if (result.exceptionDetails) throw new Error('Popup evaluation failed.');
      return result.result.value;
    };
    const popupStatus = () => evaluate('document.querySelector("#status")?.textContent');
    const waitStatus = text => poll(async () => (await popupStatus())?.includes(text), 'The popup did not show: ' + text)
      .catch(async error => { throw new Error(error.message + ' (status: ' + await popupStatus() + ')'); });
    await waitStatus(text);
    return {
      waitStatus,
      fill: () => evaluate('document.querySelector("#entries button").click()'),
      screenshot: async () => {
        if (!process.env.KEYSHOAL_EVIDENCE) return;
        const result = await command('Page.captureScreenshot', { format: 'png' });
        mkdirSync(process.env.KEYSHOAL_EVIDENCE, { recursive: true });
        writeFileSync(path.join(process.env.KEYSHOAL_EVIDENCE, '04-chrome-popup.png'), Buffer.from(result.data, 'base64'));
      },
      close: async () => {
        inspect.off('Target.receivedMessageFromTarget', listener);
        if (browserCDP) await inspect.send('Target.closeTarget', { targetId: target.targetId });
        else xdotool('key', 'Escape');
        await poll(async () => !(await inspect.send('Target.getTargets')).targetInfos.some(
          info => info.targetId === target.targetId
        ), 'The action popup did not close.');
      }
    };
  }
  let popup = await action(origin + '/', 'Choose a login to fill.');
  await popup.screenshot();
  await popup.fill();
  await popup.waitStatus('Filled. Review');
  assert.equal(await page.getByLabel('Username').inputValue(), 'demo-login');
  assert.equal(await page.getByLabel('Password').inputValue(), password);
  assert.equal(page.url(), origin + '/');
  await popup.close();
  popup = await action('https://localhost:' + port + '/', 'No saved login for this exact website.');
  assert.equal(await page.getByLabel('Password').inputValue(), '');
  await popup.close();
  for (const pathname of ['/external', '/register']) {
    popup = await action(origin + pathname, 'Choose a login to fill.');
    await popup.fill();
    await popup.waitStatus('Nothing was filled');
    assert.equal(await page.getByLabel('Password').inputValue(), '');
    await popup.close();
  }
  await run.page.getByRole('button', { name: 'Delete', exact: true }).click();
  await run.page.getByRole('button', { name: 'Delete login', exact: true }).click();
  await run.page.getByRole('heading', { name: 'No logins yet' }).waitFor();
  popup = await action(origin + '/', 'No saved login for this exact website.');
  assert.equal(await page.getByLabel('Password').inputValue(), '');
  await popup.close();
  await run.page.getByRole('button', { name: 'Lock', exact: true }).click();
  await run.page.getByRole('heading', { name: 'Unlock Keyshoal' }).waitFor();
  popup = await action(origin + '/', 'Open and unlock the Keyshoal desktop app first.');
  assert.equal(await page.getByLabel('Password').inputValue(), '');
  console.log('Chrome smoke passed with peer sync paused: real action popup, native messaging, exact-origin fill, no auto-submit, and rejected cross-origin form, registration form, wrong origin, deleted login and locked vault.');
} finally {
  await browser?.close();
  await server?.close();
  try { uninstall?.(); } finally { await run.close(); }
}
