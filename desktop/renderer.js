const api = window.keyshoal;
const $ = id => document.getElementById(id);
const app = $('app');
let model, page = 'vault', selected, editor = null, query = '', backupKey, revealTimer, qrTimer;
let renderVersion = 0;
let joining = false;
let refreshVersion = 0;
let lastActivity = 0;

async function call(action, ...args) {
  const response = await api.call(action, ...args);
  if (response.error) throw new Error(response.error);
  return response.result;
}
function error(message = '') {
  $('error').textContent = message;
  $('error').hidden = !message;
}
function act(callback) {
  return async event => {
    error();
    try { await callback(event); }
    catch (failure) { error(failure.message); }
  };
}
function add(container, tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  container.append(element);
  return element;
}
function template(container, name) { container.replaceChildren($(name).content.cloneNode(true)); }
function clearReveal() {
  clearTimeout(revealTimer);
  for (const field of document.querySelectorAll('[data-conflict-secret]')) field.textContent = '••••••••••••';
  if ($('secret')) $('secret').textContent = '••••••••••••';
  if ($('reveal')) $('reveal').textContent = 'Reveal';
  if ($('recovery-value')) {
    $('recovery-value').textContent = '';
    $('recovery-value').hidden = true;
  }
  const input = $('editor-form')?.elements.password;
  if (input) input.type = 'password';
  if ($('edit-reveal')) $('edit-reveal').textContent = 'Show password';
}
function clearQr() {
  clearTimeout(qrTimer);
  if ($('qr-image')) $('qr-image').removeAttribute('src');
  if ($('qr')) $('qr').hidden = true;
}
function render() {
  if (!model) return;
  renderVersion++;
  clearReveal();
  clearQr();
  $('nav').hidden = model.state !== 'open' || Boolean(backupKey);
  updateSync();
  if (model.state !== 'open') return renderAccess();
  if (backupKey) {
    template(app, 'backup');
    $('backup-value').textContent = backupKey;
    $('finish').onclick = () => { backupKey = undefined; render(); };
    return;
  }
  if (page === 'devices') return renderDevices();
  template(app, 'vault');
  $('search').value = query;
  $('search').oninput = () => { query = $('search').value; renderList(); };
  $('add').onclick = () => showEditor();
  renderList();
  if (editor) return renderEditor();
  const row = model.catalogue.find(item => item.id === selected);
  if (row?.conflict) renderConflicts(row);
  else if (row) renderEntry(row);
  else {
    add($('detail'), 'p', 'Personal vault', 'eyebrow');
    add($('detail'), 'h2', model.catalogue.length ? 'Choose a login' : 'No logins yet');
    add($('detail'), 'p', 'Passwords stay encrypted until you open one to reveal, edit, copy, or fill it.', 'note');
  }
}
async function refresh(keepEditor = true) {
  const current = ++refreshVersion;
  const next = await call('status');
  if (current !== refreshVersion) return;
  const catalogueUnchanged = model?.state === 'open' && next.state === 'open' &&
    model.catalogue.length === next.catalogue.length &&
    model.catalogue.every((row, i) => row.stamp === next.catalogue[i].stamp && row.id === next.catalogue[i].id);
  model = next;
  updateSync();
  if (model.state !== 'open') {
    page = 'vault';
    selected = undefined;
    editor = null;
    backupKey = undefined;
    query = '';
  } else if (keepEditor && editor && $('editor-form')) {
    renderList();
    return;
  }
  if (keepEditor && catalogueUnchanged && model.state === 'open' && app.childElementCount) return;
  render();
}
function renderAccess() {
  template(app, 'access');
  const first = model.state === 'new';
  const creating = first && !joining;
  const join = first && joining;
  $('access-title').textContent = creating ? 'Create your vault' : join ? 'Join a vault' : 'Unlock Keyshoal';
  $('access-note').textContent = creating
    ? 'Choose a long passphrase, ideally several randomly chosen words. Keyshoal will generate a separate security key.'
    : join ? 'Paste a setup code from any existing replica and enter the same passphrase. The new device can receive existing records when it finds a peer.'
      : 'Enter the passphrase and security key you saved when you created this vault.';
  $('confirm-label').hidden = !creating;
  $('confirm').required = creating;
  $('key-label').hidden = first;
  $('key').required = !first;
  $('setup-label').hidden = !join;
  $('setup-code').required = join;
  $('access-switch').hidden = !first;
  $('access-switch').textContent = join ? 'Create a new vault' : 'Use setup code';
  $('access-switch').onclick = () => { joining = !joining; render(); };
  const label = creating ? 'Create vault' : join ? 'Join vault' : 'Unlock vault';
  $('access-submit').textContent = label;
  $('access-form').onsubmit = act(async event => {
    event.preventDefault();
    const pass = $('passphrase').value;
    if (creating && pass !== $('confirm').value) throw new Error('The passphrases don’t match.');
    const key = join ? $('setup-code').value : $('key').value.trim().toLowerCase();
    $('passphrase').value = $('confirm').value = $('key').value = $('setup-code').value = '';
    const button = $('access-submit');
    button.disabled = $('access-switch').disabled = true;
    button.textContent = creating ? 'Creating…' : 'Unlocking…';
    try {
      const result = creating ? await call('create', pass) : await call(join ? 'join' : 'unlock', pass, key);
      backupKey = result.securityKey;
      joining = false;
      await refresh(false);
    } finally {
      button.disabled = false;
      if ($('access-switch')) $('access-switch').disabled = false;
      button.textContent = label;
    }
  });
}
function renderList() {
  const list = $('items');
  list.replaceChildren();
  const needle = query.trim().toLowerCase();
  const rows = model.catalogue.filter(row => [row.title, row.origin, row.username].some(v => v.toLowerCase().includes(needle)))
    .sort((a, b) => a.title.localeCompare(b.title));
  if (!rows.length) add(list, 'p', needle ? 'No matching logins.' : 'Your logins will appear here.', 'note');
  for (const row of rows) {
    const button = add(list, 'button', row.title);
    add(button, 'span', row.conflict ? 'Conflict · choose a version' : row.origin);
    button.setAttribute('aria-pressed', String(selected === row.id && !editor));
    button.onclick = () => { editor = null; selected = row.id; render(); };
  }
}
function renderEntry(row) {
  template($('detail'), 'entry');
  $('title').textContent = row.title;
  $('origin').textContent = row.origin;
  $('username').textContent = row.username || '—';
  $('reveal').onclick = act(async () => {
    if ($('reveal').textContent === 'Hide') return clearReveal();
    const version = renderVersion;
    const password = await call('reveal', row.id);
    if (version !== renderVersion) return;
    $('secret').textContent = password;
    $('reveal').textContent = 'Hide';
    revealTimer = setTimeout(clearReveal, 20_000);
  });
  $('copy').onclick = act(async () => {
    const version = renderVersion;
    await call('copy', row.id);
    if (version === renderVersion) $('entry-note').textContent = 'Copied. Keyshoal clears this clipboard value after 30 seconds if unchanged.';
  });
  $('edit').onclick = act(async () => {
    const version = renderVersion;
    const password = await call('reveal', row.id);
    if (version === renderVersion) showEditor({ ...row, password });
  });
  $('delete').onclick = () => { $('delete-confirm').hidden = false; $('delete-no').focus(); };
  $('delete-no').onclick = () => { $('delete-confirm').hidden = true; $('delete').focus(); };
  $('delete-yes').onclick = act(async () => {
    await call('remove', row.id, row.stamp);
    selected = undefined;
    await refresh();
  });
}
function showEditor(fields = {}) {
  editor = fields;
  render();
  $('editor-form').elements.title.focus();
}
function renderEditor() {
  template($('detail'), 'editor');
  $('editor-title').textContent = editor.id ? 'Edit login' : 'New login';
  const form = $('editor-form');
  for (const name of ['title', 'origin', 'username', 'password']) form.elements[name].value = editor[name] ?? '';
  // Keep the DOM as the only renderer copy of the password while editing.
  delete editor.password;
  $('generate').onclick = act(async () => {
    const password = await call('generate');
    if (form.isConnected) form.elements.password.value = password;
  });
  $('edit-reveal').onclick = () => {
    const hide = form.elements.password.type === 'text';
    clearReveal();
    if (!hide) {
      form.elements.password.type = 'text';
      $('edit-reveal').textContent = 'Hide password';
      revealTimer = setTimeout(clearReveal, 20_000);
    }
  };
  $('cancel').onclick = () => { editor = null; render(); };
  form.onsubmit = act(async event => {
    event.preventDefault();
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      selected = await call('save', Object.fromEntries(new FormData(form)), editor.id, editor.stamp);
      editor = null;
      await refresh(false);
    } finally { submit.disabled = false; }
  });
}
function updateSync() {
  if (!model) return;
  const { sync } = model;
  const peerText = sync.peers + (sync.peers === 1 ? ' peer' : ' peers');
  const conflicts = model.catalogue.filter(item => item.conflict).length;
  const state = {
    paused: 'Offline · sync paused',
    offline: 'Offline · saved on this device',
    checking: 'Checking nearby peers…',
    pending: 'Syncing · waiting for ' + (sync.peers - sync.matched) + ' of ' + peerText,
    synced: 'Synced with ' + peerText,
    unavailable: 'Offline · discovery unavailable'
  }[sync.mode];
  $('sync-badge').textContent = state + (conflicts ? ' · ' + conflicts + (conflicts === 1 ? ' conflict' : ' conflicts') : '');
  if (!$('lan-status')) return;
  $('lan-status').textContent = state;
  $('last-sync').textContent = sync.lastSync ? 'Last synced at ' + new Date(sync.lastSync).toLocaleTimeString() : 'No completed sync in this session.';
  const stopped = ['paused', 'unavailable'].includes(sync.mode);
  $('start-sync').hidden = !stopped;
  $('stop-sync').hidden = $('sync-now').hidden = stopped;
}

function renderConflicts(row) {
  template($('detail'), 'conflicts');
  $('conflict-title').textContent = row.title;
  const container = $('conflict-versions');
  const version = renderVersion;
  void act(async () => {
    const candidates = await call('variants', row.id);
    if (version !== renderVersion) return;
    for (const [index, candidate] of candidates.entries()) {
      const choice = add(container, 'section', '', 'inset');
      add(choice, 'h3', 'Version ' + (index + 1) + (candidate.deleted ? ' · deleted' : ' · ' + candidate.title));
      if (!candidate.deleted) {
        add(choice, 'p', candidate.origin + ' · ' + (candidate.username || 'No username'), 'note');
        const password = add(choice, 'code', '••••••••••••');
        password.dataset.conflictSecret = '';
        const actions = add(choice, 'div', '', 'buttons');
        add(actions, 'button', 'Reveal version ' + (index + 1), 'outline').onclick = act(async () => {
          if (password.textContent !== '••••••••••••') return clearReveal();
          const screen = renderVersion;
          const secret = await call('reveal', row.id, candidate.version);
          if (screen !== renderVersion) return;
          clearReveal();
          password.textContent = secret;
          revealTimer = setTimeout(clearReveal, 20_000);
        });
      }
      add(choice, 'button', candidate.deleted ? 'Keep deletion' : 'Keep version ' + (index + 1)).onclick = act(async () => {
        await call('resolve', row.id, candidate.version, row.stamp);
        await refresh(false);
      });
    }
  })();
}

function renderDevices() {
  template(app, 'devices');
  updateSync();
  const { bridgeReady, bridgeError } = model;
  $('start-sync').onclick = act(async () => { await call('startSync'); await refresh(); });
  $('stop-sync').onclick = act(async () => { await call('stopSync'); await refresh(); });
  $('sync-now').onclick = act(async () => { await call('syncNow'); await refresh(); });
  $('copy-setup').onclick = act(async () => {
    await call('copySetup');
    if ($('setup-note')) $('setup-note').textContent = 'Setup code copied. Treat it like your security key.';
  });
  $('invite').onclick = act(async () => {
    clearQr();
    const version = renderVersion;
    const { image, expires } = await call('invite');
    if (version !== renderVersion) return;
    $('qr-image').src = image;
    $('qr').hidden = false;
    qrTimer = setTimeout(clearQr, Math.max(expires - Date.now(), 0));
  });
  $('hide-qr').onclick = clearQr;
  $('bridge-status').textContent = bridgeReady ? 'The local Chrome bridge is ready.' :
    bridgeError || 'The Chrome bridge is unavailable in this desktop session.';
  $('recovery').onclick = act(async () => {
    if (!$('recovery-value').hidden) return clearReveal();
    const version = renderVersion;
    const value = await call('recovery');
    if (version !== renderVersion) return;
    clearReveal();
    $('recovery-value').textContent = value;
    $('recovery-value').hidden = false;
    revealTimer = setTimeout(clearReveal, 20_000);
  });
}
$('nav-vault').onclick = () => { page = 'vault'; render(); };
$('nav-devices').onclick = () => { editor = null; page = 'devices'; render(); };
$('lock').onclick = act(async () => { await call('lock'); await refresh(false); });
window.addEventListener('blur', () => { renderVersion++; clearReveal(); clearQr(); });
for (const event of ['pointerdown', 'keydown']) window.addEventListener(event, () => {
  if (model?.state !== 'open' || Date.now() - lastActivity < 1000) return;
  lastActivity = Date.now();
  void call('activity').catch(() => {});
});
api.onChanged(() => { void act(() => refresh())(); });
void act(() => refresh())();
