const api = window.keyshoal;
const $ = id => document.getElementById(id);
const app = $('app');
let model, page = 'vault', selected, editor = null, query = '', backupKey, revealTimer, qrTimer, qrVisible = false;
let renderVersion = 0;
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
function clearQr(cancel = true) {
  clearTimeout(qrTimer);
  if ($('qr-image')) $('qr-image').removeAttribute('src');
  if ($('qr')) $('qr').hidden = true;
  if (cancel && qrVisible) void call('cancelInvite').catch(() => {});
  qrVisible = false;
}
function render() {
  if (!model) return;
  renderVersion++;
  clearReveal();
  clearQr();
  $('nav').hidden = model.state !== 'open' || Boolean(backupKey);
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
  if (row) renderEntry(row);
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
  model = next;
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
  // Keep a live QR until it expires, is claimed, or this screen is left.
  if (qrVisible && page === 'devices' && $('qr') && model.state === 'open' && model.sync.ip &&
      Number($('qr').dataset.peers) === model.sync.peers.length) return;
  render();
}
function renderAccess() {
  template(app, 'access');
  const creating = model.state === 'new';
  $('access-title').textContent = creating ? 'Create your vault' : 'Unlock Keyshoal';
  $('access-note').textContent = creating
    ? 'Choose a long passphrase, ideally several randomly chosen words. Keyshoal will generate a separate security key.'
    : 'Enter the passphrase and security key you saved when you created this vault.';
  $('confirm-label').hidden = !creating;
  $('confirm').required = creating;
  $('key-label').hidden = creating;
  $('key').required = !creating;
  $('access-submit').textContent = creating ? 'Create vault' : 'Unlock vault';
  $('access-form').onsubmit = act(async event => {
    event.preventDefault();
    const pass = $('passphrase').value;
    if (creating && pass !== $('confirm').value) throw new Error('The passphrases don’t match.');
    const key = $('key').value.trim().toLowerCase();
    $('passphrase').value = $('confirm').value = $('key').value = '';
    const button = $('access-submit');
    button.disabled = true;
    button.textContent = creating ? 'Creating…' : 'Unlocking…';
    try {
      const result = creating ? await call('create', pass) : await call('unlock', pass, key);
      backupKey = result.securityKey;
      await refresh(false);
    } finally {
      button.disabled = false;
      button.textContent = creating ? 'Create vault' : 'Unlock vault';
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
    add(button, 'span', row.origin);
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
function renderDevices() {
  template(app, 'devices');
  const { sync, bridgeReady, bridgeError } = model;
  $('lan-status').textContent = sync.ip ? 'Listening on ' + sync.ip + ' while unlocked.' :
    sync.addresses.length ? 'Off. Choose the address on the same Wi-Fi as your phone.' : 'No private IPv4 address found.';
  $('address-label').hidden = Boolean(sync.ip) || !sync.addresses.length;
  for (const ip of sync.addresses) add($('addresses'), 'option', ip).value = ip;
  $('start-sync').hidden = Boolean(sync.ip) || !sync.addresses.length;
  $('stop-sync').hidden = $('invite').hidden = !sync.ip;
  $('start-sync').onclick = act(async () => { await call('startSync', $('addresses').value); await refresh(); });
  $('stop-sync').onclick = act(async () => { clearQr(); await call('stopSync'); await refresh(); });
  $('invite').onclick = act(async () => {
    clearQr(false);
    const version = renderVersion;
    const { image, expires } = await call('invite');
    if (version !== renderVersion) { void call('cancelInvite'); return; }
    qrVisible = true;
    $('qr').dataset.peers = String(model.sync.peers.length);
    $('qr-image').src = image;
    $('qr').hidden = false;
    qrTimer = setTimeout(() => clearQr(), Math.max(expires - Date.now(), 0));
  });
  $('hide-qr').onclick = () => clearQr();
  $('bridge-status').textContent = bridgeReady ? 'The local Chrome bridge is ready.' :
    bridgeError || 'The Chrome bridge is unavailable in this desktop session.';
  for (const peer of sync.peers) {
    const line = add($('peer-list'), 'div', '', 'peer');
    add(line, 'span', 'Device ' + peer.id.slice(0, 6) + ' · ' + new Date(peer.added).toLocaleDateString());
    const revoke = add(line, 'button', 'Revoke', 'danger');
    revoke.onclick = act(async () => { await call('revoke', peer.id); await refresh(); });
  }
  if (!sync.peers.length) add($('peer-list'), 'p', 'No paired devices.', 'note');
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
