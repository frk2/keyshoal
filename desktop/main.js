import { app, BrowserWindow, clipboard, ipcMain, powerMonitor, session } from 'electron';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
import { generatePassword, isId, MAX_VAULT, Vault } from '@keyshoal/vault';
import { privateDirectory, readPrivate, writePrivate } from './files.js';
import { LanHub } from './sync.js';
import { answerNative, startBridge } from './bridge.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(ROOT, 'index.html');
const LOCK_MS = 5 * 60 * 1000;
let dir, vaultFile, win, hub, bridge, active, securityKey, unlockPending, clipboardValue, clipboardTimer, lockTimer;
let generation = 0;
let bridgeReady = false;
let bridgeError = '';

function sendChanged() {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('vault:changed');
}
function clearClipboard() {
  clearTimeout(clipboardTimer);
  if (clipboardValue !== undefined && clipboard.readText() === clipboardValue) clipboard.clear();
  clipboardValue = undefined;
}
function lock() {
  generation++;
  clearTimeout(lockTimer);
  hub?.stop();
  active?.close();
  active = undefined;
  securityKey = undefined;
  clearClipboard();
  sendChanged();
}
function touch() {
  clearTimeout(lockTimer);
  if (active) lockTimer = setTimeout(lock, LOCK_MS);
}
function vault() {
  if (!active) throw new Error('Unlock your vault first.');
  return active;
}
function commit(bytes) {
  writePrivate(vaultFile, bytes);
  vault().replace(bytes);
  sendChanged();
}
function status() {
  return {
    state: active ? 'open' : readPrivate(vaultFile, MAX_VAULT) ? 'locked' : 'new',
    catalogue: active ? active.catalogue() : [],
    sync: hub.status(), bridgeReady, bridgeError
  };
}
async function access(mode, input, key) {
  if (active || unlockPending) throw new Error('A vault is already open or unlocking.');
  unlockPending = true;
  const start = generation;
  let next;
  try {
    const bytes = readPrivate(vaultFile, MAX_VAULT);
    if (mode === 'create') {
      if (bytes) throw new Error('A vault already exists.');
      const result = await Vault.create(input, randomBytes);
      next = result.vault;
      key = result.securityKey;
    } else {
      if (!bytes) throw new Error('Create a vault first.');
      next = await Vault.unlock(bytes, input, key, randomBytes);
    }
    if (start !== generation) throw new Error('Unlock cancelled.');
    if (mode === 'create') writePrivate(vaultFile, next.bytes());
    active = next;
    securityKey = key;
    touch();
    return mode === 'create' ? { securityKey: key } : {};
  } catch (error) {
    next?.close();
    throw error;
  } finally {
    unlockPending = false;
  }
}
const trustedId = id => {
  if (!isId(id)) throw new Error('Invalid login or device.');
  return id;
};

function checkEdit(id, stamp) {
  if (vault().recordStamp(trustedId(id)) !== stamp) {
    throw new Error('This login changed during sync. Reopen it before editing or deleting.');
  }
}

const handlers = {
  status,
  create: pass => access('create', pass),
  unlock: (pass, key) => access('unlock', pass, key),
  lock,
  activity: () => touch(),
  reveal: id => vault().reveal(trustedId(id)),
  recovery: () => { vault(); return securityKey; },
  copy: id => {
    clearClipboard();
    clipboardValue = vault().reveal(trustedId(id));
    clipboard.writeText(clipboardValue);
    clipboardTimer = setTimeout(clearClipboard, 30_000);
  },
  generate: () => { vault(); return generatePassword(randomBytes); },
  save: (fields, id, stamp) => {
    if (id !== undefined) checkEdit(id, stamp);
    const next = vault().withLogin(fields, id === undefined ? undefined : trustedId(id));
    commit(next.bytes);
    return next.id;
  },
  remove: (id, stamp) => { checkEdit(id, stamp); commit(vault().withoutLogin(id)); },
  startSync: ip => hub.start(ip),
  stopSync: () => hub.stop(),
  cancelInvite: () => hub.cancelInvite(),
  invite: async () => {
    vault();
    const time = generation;
    const { qr, expires } = hub.invite(securityKey);
    const image = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M', width: 360, margin: 4 });
    if (time !== generation || !hub.status().ip) throw new Error('Pairing was cancelled.');
    return { image, expires };
  },
  revoke: id => { vault(); hub.revoke(trustedId(id)); }
};

function window() {
  win = new BrowserWindow({
    width: 1040, height: 750, minWidth: 400, minHeight: 540, backgroundColor: '#f6f5ee',
    show: false, autoHideMenuBar: true, title: 'Keyshoal',
    webPreferences: {
      preload: path.join(ROOT, 'preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false,
      webSecurity: true, webviewTag: false, spellcheck: false
    }
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-frame-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('render-process-gone', lock);
  win.on('close', lock);
  win.once('ready-to-show', () => win.show());
  win.loadFile(PAGE);
}

function open() {
  process.umask(0o077);
  dir = privateDirectory(path.join(app.getPath('appData'), 'keyshoal'));
  vaultFile = path.join(dir, 'logins.vault');
  app.setPath('userData', privateDirectory(path.join(dir, 'desktop')));
  if (!app.requestSingleInstanceLock()) return app.quit();
  app.on('second-instance', () => { if (win && !win.isDestroyed()) win.show(); });
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    session.defaultSession.webRequest.onBeforeRequest(({ url }, done) =>
      done({ cancel: !url.startsWith('file:') && !url.startsWith('data:') }));
    hub = new LanHub(dir, () => active, commit);
    hub.onPeer(sendChanged);
    try {
      bridge = await startBridge(process.env.XDG_RUNTIME_DIR, request => answerNative(active, request));
      bridgeReady = Boolean(bridge);
    } catch {
      bridgeError = 'Could not start the per-user Chrome bridge.';
    }
    ipcMain.handle('vault:call', async (event, action, ...args) => {
      if (!win || win.isDestroyed() || event.sender !== win.webContents ||
          event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(PAGE).href ||
          typeof action !== 'string' || !Object.hasOwn(handlers, action)) return { error: 'Request denied.' };
      try {
        if (!['status', 'activity'].includes(action)) touch();
        return { result: await handlers[action](...args) };
      } catch (error) {
        return { error: error.code ? 'The operation could not access local storage or networking.' : error.message };
      }
    });
    for (const event of ['suspend', 'lock-screen']) powerMonitor.on(event, lock);
    window();
  }).catch(() => {
    process.stderr.write('Keyshoal could not initialize the private vault directory.\n');
    app.exit(1);
  });
}
app.enableSandbox();
app.on('before-quit', () => { lock(); bridge?.close(); });
app.on('window-all-closed', () => app.quit());
open();
