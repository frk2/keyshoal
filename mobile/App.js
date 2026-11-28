import React, { useEffect, useRef, useState } from 'react';
import { AppState, Image, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { getRandomValues } from 'expo-crypto';
import { usePreventScreenCapture, enableAppSwitcherProtectionAsync } from 'expo-screen-capture';
import { generatePassword, isKey } from '@keyshoal/vault';
import { Replica } from '@keyshoal/vault/replica';
import { decodeSetup, encodeSetup } from '@keyshoal/vault/protocol';
import * as storage from './storage';

const blank = () => ({ title: '', origin: '', username: '', password: '' });
const getRandomBytes = size => getRandomValues(new Uint8Array(size));
const POWER_LOCK = 5 * 60_000;

export default function App() {
  return <SafeAreaProvider><VaultScreen /></SafeAreaProvider>;
}

const offline = { mode: 'offline', peers: 0, matched: 0 };
const paused = { mode: 'paused', peers: 0, matched: 0 };

function describe({ mode, peers, matched }) {
  const people = peers + (peers === 1 ? ' peer' : ' peers');
  return {
    paused: 'Offline · sync paused', offline: 'Offline · saved on this device',
    unavailable: 'Offline · Bonjour unavailable', checking: 'Checking nearby peers…',
    synced: 'Synced with ' + people, pending: 'Syncing · waiting for ' + (peers - matched) + ' of ' + people
  }[mode];
}

function VaultScreen() {
  usePreventScreenCapture('keyshoal');
  const opened = useRef(null);
  const expiry = useRef(null);
  const revealTimeout = useRef(null);
  const qrTimeout = useRef(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const scanned = useRef(false);
  const network = useRef(null);
  const writes = useRef(Promise.resolve());
  const [permission, requestPermission] = useCameraPermissions();
  const [known, setKnown] = useState(false);
  const [keyMissing, setKeyMissing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState('choose');
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [entryKey, setEntryKey] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState(null);
  const [backupKey, setBackupKey] = useState(null);
  const [selected, setSelected] = useState(null);
  const [editor, setEditor] = useState(null);
  const [password, setPassword] = useState(null);
  const [editingVisible, setEditingVisible] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sync, setSync] = useState(paused);
  const [lastSync, setLastSync] = useState(null);
  const [showDevices, setShowDevices] = useState(false);
  const [qr, setQr] = useState(null);

  function hideSecret() {
    clearTimeout(revealTimeout.current);
    setPassword(null);
    setEditingVisible(false);
  }
  function hideQr() { clearTimeout(qrTimeout.current); setQr(null); }
  function stopPeers() {
    clearInterval(network.current?.timer);
    network.current = null;
    setSync(paused);
    void storage.peerStop().catch(() => {});
  }
  function lock() {
    generation.current++;
    clearTimeout(expiry.current);
    stopPeers();
    opened.current?.vault.close();
    opened.current = null;
    setList(null);
    setBackupKey(null);
    setEditor(null);
    setSelected(null);
    setQuery('');
    setDeleting(false);
    setNotice('');
    setError('');
    setConfirm('');
    setPass('');
    setEntryKey('');
    setSetupCode('');
    setMode('choose');
    setShowDevices(false);
    setLastSync(null);
    hideSecret();
    hideQr();
  }
  function touch() {
    clearTimeout(expiry.current);
    if (opened.current) expiry.current = setTimeout(lock, POWER_LOCK);
  }
  useEffect(() => {
    enableAppSwitcherProtectionAsync().catch(() => {});
    Promise.all([storage.load(), storage.securityKey()]).then(
      ([data, key]) => {
        setKnown(Boolean(data));
        setKeyMissing(!key);
        setLoaded(true);
      },
      () => { setError('Could not read local vault storage.'); setLoaded(true); }
    );
    const listener = storage.listen((id, bytes) => {
      let response;
      try {
        if (network.current && opened.current) response = opened.current.vault.answer(bytes);
      } catch { /* do not answer packets from outside this vault */ }
      void storage.respond(id, response).catch(() => {});
    });
    const change = AppState.addEventListener('change', state => {
      if (state === 'background') lock();
      else if (state === 'inactive') { hideSecret(); hideQr(); }
    });
    return () => {
      listener.remove();
      change.remove();
      clearInterval(network.current?.timer);
      clearTimeout(expiry.current);
      clearTimeout(revealTimeout.current);
      clearTimeout(qrTimeout.current);
      opened.current?.vault.close();
      void storage.peerStop().catch(() => {});
    };
  }, []);

  function saveFor(current, build) {
    const work = writes.current.then(async () => {
      if (opened.current !== current) throw new Error('Session locked.');
      const change = build(current.vault);
      if (!change.bytes) return change;
      await storage.save(change.bytes);
      if (opened.current !== current) throw new Error('Session locked.');
      current.vault.replace(change.bytes);
      setList(current.vault.catalogue());
      return change;
    });
    writes.current = work.catch(() => {});
    return work;
  }

  async function synchronize(round = network.current) {
    const current = opened.current;
    if (!round || !current || round.busy || network.current !== round) return;
    round.busy = true;
    const live = () => network.current === round && opened.current === current;
    try {
      const seen = await storage.peerList();
      if (!live()) return;
      const { ids, unavailable } = seen;
      if (!ids.length) {
        round.status = { ...offline, mode: unavailable ? 'unavailable' : 'offline' };
        setSync(round.status);
        return;
      }
      if (!round.status.peers) setSync({ ...offline, mode: 'checking' });
      const peers = [];
      for (let i = 0; i < Math.min(ids.length, 8); i++) peers.push(ids[(round.cursor + i) % ids.length]);
      round.cursor = (round.cursor + peers.length) % ids.length;
      const results = await Promise.allSettled(peers.map(async id => {
        const request = current.vault.request();
        const response = await storage.peerRequest(id, request);
        if (!live()) return null;
        const result = await saveFor(current, vault => live() ? vault.integrate(request, response) : { bytes: null });
        return result.digest ?? null;
      }));
      if (!live()) return;
      const hashes = results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
      const digest = current.vault.digest();
      const matched = hashes.filter(remote => remote === digest).length;
      const mode = !hashes.length ? 'offline' : matched === hashes.length ? 'synced' : 'pending';
      if (mode === 'synced' && round.status.mode !== 'synced') setLastSync(Date.now());
      round.status = { mode, peers: hashes.length, matched };
      setSync(round.status);
    } catch {
      if (live()) setSync({ ...offline, mode: 'unavailable' });
    } finally { round.busy = false; }
  }
  async function startPeers() {
    if (!opened.current || network.current) return;
    const round = { busy: false, status: offline, cursor: 0 };
    network.current = round;
    setSync(offline);
    try {
      await storage.peerStart();
      if (network.current !== round) return;
      round.timer = setInterval(() => void synchronize(round), 2800);
      void synchronize(round);
    } catch {
      if (network.current === round) { network.current = null; setSync({ ...offline, mode: 'unavailable' }); }
    }
  }
  function changed() {
    const status = network.current?.status;
    if (!status?.peers) return;
    network.current.status = { ...status, mode: 'pending', matched: 0 };
    setSync(network.current.status);
  }

  async function run(work) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const version = generation.current;
    const live = () => {
      if (version !== generation.current) throw new Error('Session locked.');
    };
    try { touch(); await work(live); }
    catch (failure) { if (version === generation.current) setError(failure.message ?? 'Keyshoal could not finish.'); }
    finally { pending.current = false; setBusy(false); }
  }

  function access(action) {
    const input = pass;
    const repeat = confirm;
    const suppliedKey = entryKey.trim().toLowerCase();
    const code = setupCode;
    setPass('');
    setConfirm('');
    setEntryKey('');
    void run(async live => {
      const existing = await storage.load();
      let vault;
      let key;
      try {
        if (action === 'create') {
          if (existing) throw new Error('A vault already exists.');
          if (input !== repeat) throw new Error('The passphrases don’t match.');
          ({ vault, securityKey: key } = await Replica.create(input, getRandomBytes));
        } else if (action === 'join') {
          if (existing) throw new Error('A vault already exists.');
          const setup = decodeSetup(code);
          key = setup.key;
          vault = await Replica.join(setup.bootstrap, input, key, getRandomBytes);
        } else {
          if (!existing) throw new Error('Create or join a vault first.');
          key = keyMissing ? suppliedKey : await storage.securityKey();
          if (!isKey(key)) throw new Error('Enter the 64-character security key.');
          vault = await Replica.unlock(existing, input, key, getRandomBytes);
        }
        live();
        await storage.saveKey(key);
        const bytes = vault.bytes();
        await storage.save(bytes);
        live();
        opened.current = { vault, key };
        setKnown(true);
        setKeyMissing(false);
        setSetupCode('');
        setList(vault.catalogue());
        if (action === 'create') setBackupKey(key);
        touch();
        void startPeers();
      } catch (failure) { vault?.close(); throw failure; }
    });
  }

  async function openCamera() {
    if (pending.current) return;
    if (!permission?.granted && !(await requestPermission()).granted) {
      setError('Allow camera access in Settings or paste a setup code.');
      return;
    }
    scanned.current = false;
    setError('');
    setMode('scan');
  }
  function scan(event) {
    if (scanned.current || mode !== 'scan') return;
    try {
      decodeSetup(event.data);
      scanned.current = true;
      setSetupCode(event.data);
      setMode('join');
      setError('');
    } catch { setError('That is not a Keyshoal setup QR.'); }
  }

  function select(id) { touch(); hideSecret(); setDeleting(false); setSelected(id); setEditor(null); }
  const row = list?.find(item => item.id === selected);
  const variants = row?.conflict && opened.current ? opened.current.vault.variants(row.id) : [];
  const conflictCount = list?.filter(item => item.conflict).length ?? 0;
  const update = (name, value) => { touch(); setEditor(previous => ({ ...previous, [name]: value })); };
  function reveal(id, version) {
    touch();
    hideSecret();
    if (password?.id === id && password.version === version) return;
    setPassword({ id, version, value: opened.current.vault.reveal(id, version) });
    revealTimeout.current = setTimeout(hideSecret, 20_000);
  }
  function localChange(build, after) {
    const current = opened.current;
    void run(async live => {
      const result = await saveFor(current, build);
      live();
      changed();
      after?.(result);
    });
  }
  return <SafeAreaView style={s.safe}>
    <KeyboardAvoidingView behavior="padding" style={s.flex}>
      <View style={s.header}><View><Text style={s.label}>LOCAL PASSWORD VAULT</Text><Text style={s.brand}>Keyshoal</Text></View>
        {list && <View style={s.actions}>
          <Button label={showDevices ? 'Vault' : 'Devices'} secondary onPress={() => { touch(); hideSecret(); hideQr(); setShowDevices(!showDevices); }} />
          <Button label="Lock" secondary onPress={lock} />
        </View>}</View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
        {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
        {!!notice && <Text style={s.note}>{notice}</Text>}
        {!!list && <Text accessibilityLiveRegion="polite" style={s.sync}>{describe(sync)}{conflictCount ? ' · ' + conflictCount + ' conflict' + (conflictCount === 1 ? '' : 's') : ''}</Text>}
        {!loaded ? <Text style={s.note}>Opening Keyshoal…</Text> : !list ? (
          mode === 'scan' ? <View style={s.panel}>
            <Text style={s.title}>Scan setup QR</Text><Text style={s.note}>Show a setup QR from any unlocked replica.</Text>
            <CameraView style={s.camera} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={scan} />
            <Button label="Cancel" secondary onPress={() => setMode('choose')} />
          </View> : !known && mode === 'choose' ? <View style={s.panel}>
            <Text style={s.title}>Set up Keyshoal</Text><Text style={s.note}>Create an offline vault, or join one from any existing replica.</Text>
            <Button label="Create vault" onPress={() => setMode('create')} />
            <Button label="Scan setup QR" secondary onPress={openCamera} />
            <Button label="Use setup code" secondary onPress={() => { setMode('join'); setSetupCode(''); }} />
          </View> : <View style={s.panel}>
            <Text style={s.title}>{known ? 'Unlock your vault' : mode === 'create' ? 'Create your vault' : 'Join a vault'}</Text>
            {!known && mode === 'join' && <Field label="Setup code" value={setupCode} secure maxLength={240} onChangeText={setSetupCode} />}
            {known && keyMissing && <Field label="Security key" value={entryKey} secure maxLength={64} onChangeText={setEntryKey} />}
            <Field label="Passphrase" value={pass} onChangeText={setPass} secure maxLength={1024} />
            {!known && mode === 'create' && <Field label="Confirm passphrase" value={confirm} onChangeText={setConfirm} secure maxLength={1024} />}
            <Button label={known ? 'Unlock vault' : mode === 'create' ? 'Create vault' : 'Join vault'}
              disabled={busy || !pass} onPress={() => access(known ? 'unlock' : mode)} />
            {!known && <Button label="Cancel" secondary disabled={busy} onPress={() => {
              setMode('choose'); setPass(''); setConfirm(''); setSetupCode('');
            }} />}
            {known && !keyMissing && <Button label="Use saved offline security key instead" secondary onPress={() => setKeyMissing(true)} />}
          </View>
        ) : backupKey ? <View style={s.panel}>
          <Text style={s.title}>Save your security key</Text>
          <Text style={s.note}>Keep this key offline and separate from your passphrase. Both are needed to recover the encrypted vault.</Text>
          <Text style={s.password} selectable>{backupKey}</Text>
          <Button label="I saved my security key" onPress={() => setBackupKey(null)} />
        </View> : showDevices ? <View style={s.panel}>
          <Text style={s.title}>Peer sync</Text>
          <Text style={s.note}>{lastSync ? 'Last synced at ' + new Date(lastSync).toLocaleTimeString() : 'No completed sync in this session.'}</Text>
          <Text style={s.note}>Your vault is complete on this iPhone after sync. The app finds nearby peers while it’s open and unlocked.</Text>
          <View style={s.actions}>
            <Button label={!network.current ? 'Resume sync' : 'Pause sync'} onPress={() => {
              touch(); if (network.current) stopPeers(); else void startPeers();
            }} />
            {!!network.current && <Button label="Sync now" secondary onPress={() => { touch(); void synchronize(); }} />}
          </View>
          <Text style={s.title}>Set up another device</Text>
          <Text style={s.note}>Scan this privately. The QR contains your security key. The other device also needs the vault passphrase.</Text>
          <View style={s.actions}>
            <Button label={qr ? 'Hide setup QR' : 'Show setup QR'} secondary onPress={() => {
              if (qr) return hideQr();
              void run(async live => {
                const { vault, key } = opened.current;
                const image = await storage.qr(encodeSetup(key, vault.bootstrap()));
                live();
                setQr(image);
                qrTimeout.current = setTimeout(hideQr, 90_000);
              });
            }} />
            <Button label="Copy setup code" secondary onPress={() => run(async live => {
              const { vault, key } = opened.current;
              await storage.copy(encodeSetup(key, vault.bootstrap()));
              live(); setNotice('Setup code copied. Treat it like your security key.');
            })} />
          </View>
          {qr && <Image accessibilityLabel="Keyshoal setup QR" resizeMode="contain" source={{ uri: qr }} style={s.qr} />}
        </View> : <>
          <View style={s.actions}><Button label="New login" disabled={busy} onPress={() => { select(null); setEditor(blank()); }} /></View>
          {editor ? <View style={s.panel}>
            <Text style={s.title}>{editor.id ? 'Edit login' : 'New login'}</Text>
            <Field label="Title" value={editor.title} maxLength={128} onChangeText={v => update('title', v)} />
            <Field label="Website" value={editor.origin} placeholder="https://example.com" maxLength={2048} onChangeText={v => update('origin', v)} />
            <Field label="Username" value={editor.username} maxLength={512} onChangeText={v => update('username', v)} />
            <Field label="Password" value={editor.password} secure={!editingVisible} maxLength={1024} onChangeText={v => update('password', v)} />
            <View style={s.actions}><Button label="Generate" secondary onPress={() => update('password', generatePassword(getRandomBytes))} />
              <Button label={editingVisible ? 'Hide password' : 'Show password'} secondary onPress={() => {
                if (editingVisible) return hideSecret();
                hideSecret(); setEditingVisible(true); revealTimeout.current = setTimeout(hideSecret, 20_000);
              }} /></View>
            <View style={s.actions}><Button label="Save login" disabled={busy} onPress={() => localChange(vault => {
              if (editor.id && editor.stamp !== vault.recordStamp(editor.id)) throw new Error('This login changed during sync. Reopen it before editing.');
              return vault.withLogin(editor, editor.id);
            }, next => { setEditor(null); setSelected(next.id); hideSecret(); })} />
            <Button label="Cancel" secondary disabled={busy} onPress={() => { setEditor(null); hideSecret(); }} /></View>
          </View> : row?.conflict ? <View style={s.panel}>
            <Text style={s.title}>Review conflict</Text><Text style={s.note}>Choose a version now or later. You can resolve this offline.</Text>
            {variants.map((variant, index) => <View key={variant.version} style={s.item}>
              <Text style={s.itemTitle}>{'Version ' + (index + 1) + (variant.deleted ? ' · deleted' : ' · ' + variant.title)}</Text>
              {!variant.deleted && <>
                <Text style={s.note}>{variant.origin + ' · ' + (variant.username || 'No username')}</Text>
                <Text style={s.password}>{password?.version === variant.version ? password.value : '••••••••••••'}</Text>
                <Button label={'Reveal version ' + (index + 1)} secondary onPress={() => reveal(row.id, variant.version)} />
              </>}
              <Button label={variant.deleted ? 'Keep deletion' : 'Keep version ' + (index + 1)} disabled={busy}
                onPress={() => localChange(vault => ({ bytes: vault.resolve(row.id, variant.version, row.stamp) }), hideSecret)} />
            </View>)}
          </View> : row ? <View style={s.panel}>
            <Text style={s.title}>{row.title}</Text><Text style={s.note}>{row.origin}</Text><Text>{row.username || 'No username'}</Text>
            <Text selectable={false} style={s.password}>{password?.id === row.id && !password.version ? password.value : '••••••••••••'}</Text>
            <View style={s.actions}>
              <Button label={password?.id === row.id ? 'Hide' : 'Reveal'} secondary onPress={() => reveal(row.id)} />
              <Button label="Copy password" secondary disabled={busy} onPress={() => run(async live => {
                await storage.copy(opened.current.vault.reveal(row.id));
                live(); setNotice('Copied to this device for up to 30 seconds.');
              })} />
              <Button label="Edit" secondary disabled={busy} onPress={() => {
                touch(); hideSecret(); setEditor({ ...row, password: opened.current.vault.reveal(row.id) });
              }} />
              <Button label="Delete" secondary disabled={busy} onPress={() => setDeleting(true)} />
            </View>
            {deleting && <View style={s.actions}><Button label="Delete login" disabled={busy} onPress={() => localChange(vault => {
              if (row.stamp !== vault.recordStamp(row.id)) throw new Error('This login changed during sync. Reopen it before deleting.');
              return { bytes: vault.withoutLogin(row.id) };
            }, () => select(null))} /><Button label="Cancel" secondary onPress={() => setDeleting(false)} /></View>}
          </View> : null}
          <Text style={s.title}>Logins</Text>
          <Field label="Search" value={query} maxLength={128} onChangeText={v => { touch(); setQuery(v); }} />
          {!list.length && <Text style={s.note}>No logins yet. Add one now or sync with a nearby replica.</Text>}
          {list.filter(item => [item.title, item.origin, item.username].some(value => value.toLowerCase().includes(query.trim().toLowerCase())))
            .sort((a, b) => a.title.localeCompare(b.title)).map(item => (
              <Pressable key={item.id} accessibilityRole="button" style={s.item} disabled={busy} onPress={() => select(item.id)}>
                <Text style={s.itemTitle}>{item.title}</Text><Text style={s.note}>{item.conflict ? 'Conflict · choose a version' : item.origin}</Text>
              </Pressable>
          ))}
        </>}
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

function Button({ label, onPress, disabled, secondary }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }}
    onPress={onPress} disabled={disabled} style={[s.button, secondary && s.secondary, disabled && s.disabled]}>
    <Text style={[s.buttonText, secondary && s.secondaryText]}>{label}</Text>
  </Pressable>;
}
function Field({ label, secure, ...input }) {
  return <View style={s.field}><Text style={s.fieldLabel}>{label}</Text>
    <TextInput accessibilityLabel={label} autoCapitalize="none" autoCorrect={false} spellCheck={false}
      secureTextEntry={Boolean(secure)} style={s.input} {...input} /></View>;
}
const s = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#f6f5ee'},flex:{flex:1},
  header:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',borderBottomWidth:1,borderColor:'#ccd7cb',paddingHorizontal:19,paddingVertical:12},
  brand:{fontSize:29,fontWeight:'800',color:'#182d26',letterSpacing:-1},
  label:{fontSize:10,fontWeight:'700',letterSpacing:1.8,color:'#16624f'},
  content:{padding:17,gap:12,width:'100%',maxWidth:650,alignSelf:'center'},
  panel:{backgroundColor:'#fffdf8',borderColor:'#ccd7cb',borderWidth:1,borderRadius:12,padding:16,gap:10},
  title:{fontSize:25,fontWeight:'800',letterSpacing:-0.7,color:'#182d26'},
  note:{fontSize:14,color:'#4d655a',lineHeight:21},
  error:{backgroundColor:'#fbe7e0',color:'#8a271e',padding:10,borderRadius:6},
  button:{backgroundColor:'#16624f',minHeight:44,justifyContent:'center',alignItems:'center',borderRadius:7,paddingHorizontal:12,paddingVertical:8},
  secondary:{backgroundColor:'#eaf0e8'},disabled:{opacity:0.55},
  buttonText:{color:'#fff',fontSize:15,fontWeight:'700'},secondaryText:{color:'#16624f'},
  field:{gap:4},fieldLabel:{fontWeight:'650',color:'#274739'},
  input:{fontSize:16,padding:10,minHeight:44,borderRadius:6,borderWidth:1,borderColor:'#9aafa1',color:'#182d26',backgroundColor:'#fff'},
  sync:{fontSize:13,color:'#16624f',backgroundColor:'#e5eee4',padding:9,borderRadius:6,fontWeight:'700'},
  qr:{width:250,height:250,backgroundColor:'#fff',borderWidth:12,borderColor:'#fff'},
  camera:{height:270,borderRadius:8,overflow:'hidden'},actions:{flexDirection:'row',flexWrap:'wrap',gap:8},
  item:{backgroundColor:'#fffdf8',borderColor:'#ccd7cb',borderWidth:1,borderRadius:8,padding:12},
  itemTitle:{fontSize:16,fontWeight:'750',color:'#182d26'},password:{color:'#182d26',fontFamily:'Menlo',paddingVertical:7}
});
