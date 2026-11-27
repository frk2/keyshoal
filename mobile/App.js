import React, { useEffect, useRef, useState } from 'react';
import { AppState, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { getRandomValues } from 'expo-crypto';
import { usePreventScreenCapture, enableAppSwitcherProtectionAsync } from 'expo-screen-capture';
import { Vault, generatePassword, isKey } from '@keyshoal/vault';
import { decodeInvite } from '@keyshoal/vault/protocol';
import { syncDevice } from '@keyshoal/vault/client';
import * as storage from './storage';

const blank = () => ({ title: '', origin: '', username: '', password: '' });
const getRandomBytes = size => getRandomValues(new Uint8Array(size));
const POWER_LOCK = 5 * 60_000;

export default function App() {
  return <SafeAreaProvider><VaultScreen /></SafeAreaProvider>;
}

function VaultScreen() {
  usePreventScreenCapture('keyshoal');
  const opened = useRef(null);
  const expiry = useRef(null);
  const revealTimeout = useRef(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const scanned = useRef(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [known, setKnown] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [pairing, setPairing] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState(null);
  const [selected, setSelected] = useState(null);
  const [editor, setEditor] = useState(null);
  const [password, setPassword] = useState(null);
  const [editingVisible, setEditingVisible] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [conflict, setConflict] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  function hideSecret() {
    clearTimeout(revealTimeout.current);
    setPassword(null);
    setEditingVisible(false);
  }
  function lock() {
    generation.current++;
    clearTimeout(expiry.current);
    opened.current?.vault.close();
    opened.current = null;
    setList(null);
    setEditor(null);
    setSelected(null);
    setConflict(null);
    setQuery('');
    setDeleting(false);
    setNotice('');
    setError('');
    setPass('');
    setPairing(null);
    setScanning(false);
    hideSecret();
  }
  function touch() {
    clearTimeout(expiry.current);
    if (opened.current) expiry.current = setTimeout(lock, POWER_LOCK);
  }
  useEffect(() => {
    enableAppSwitcherProtectionAsync().catch(() => {});
    storage.credentials().then(
      value => {
        setKnown(Boolean(value));
        setLoaded(true);
      },
      () => {
        setError('Could not read the Keychain. Check that the device is unlocked.');
        setLoaded(true);
      }
    );
    const change = AppState.addEventListener('change', state => {
      if (state === 'background' || (state === 'inactive' && opened.current)) lock();
    });
    return () => {
      change.remove();
      clearTimeout(expiry.current);
      clearTimeout(revealTimeout.current);
      opened.current?.vault.close();
    };
  }, []);

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
  function enter(vault, base) {
    opened.current = { vault, base };
    setList(vault.catalogue());
    setScanning(false);
    setPairing(null);
    setSelected(null);
    setKnown(true);
    touch();
  }
  function unlock() {
    const input = pass;
    setPass('');
    void run(async live => {
      const info = await storage.credentials();
      if (!info) throw new Error('Pair this iPhone with Keyshoal first.');
      let snapshot = await storage.load();
      let downloaded = false;
      if (!snapshot) {
        const remote = await storage.request(info, 'Device', info.token, { method: 'GET' });
        if (remote.status !== 200) throw new Error('Could not restore the local vault. Pair again with the desktop.');
        snapshot = { local: remote.body, base: remote.body };
        downloaded = true;
      }
      const vault = await Vault.unlock(snapshot.local, input, info.key, getRandomBytes);
      try {
        live();
        vault.validate(snapshot.base);
        if (downloaded) await storage.save(snapshot.local, snapshot.base);
        live();
        enter(vault, snapshot.base);
      } catch (failure) { vault.close(); throw failure; }
    });
  }
  function enrol() {
    const invite = pairing;
    const input = pass;
    setPass('');
    void run(async live => {
      const remote = await storage.request(invite, 'Invite', invite.invite, { method: 'GET' });
      if (remote.status !== 200) throw new Error('The pairing code expired or was already used. Scan a new one.');
      live();
      const old = await storage.load();
      const snapshot = old ?? { local: remote.body, base: remote.body };
      const vault = await Vault.unlock(snapshot.local, input, invite.key, getRandomBytes);
      try {
        live();
        vault.validate(snapshot.base);
        vault.validate(remote.body);
        const result = await storage.request(invite, 'Invite', invite.invite, { method: 'POST', proof: vault.enrolProof(invite.invite) });
        if (result.status !== 201 || !isKey(result.device)) throw new Error('Pairing could not be activated. Scan a new code.');
        live();
        await storage.saveCredentials({ ip: invite.ip, fingerprint: invite.fingerprint, key: invite.key, token: result.device });
        if (!old) await storage.save(snapshot.local, snapshot.base);
        live();
        enter(vault, snapshot.base);
      } catch (failure) { vault.close(); throw failure; }
    });
  }
  async function openCamera() {
    if (!permission?.granted && !(await requestPermission()).granted) {
      setError('Allow camera access in Settings to scan a QR code.');
      return;
    }
    scanned.current = false;
    setPass('');
    setError('');
    setPairing(null);
    setScanning(true);
  }
  function scan(event) {
    if (scanned.current || !scanning) return;
    try {
      const invite = decodeInvite(event.data);
      scanned.current = true;
      setPairing(invite);
      setScanning(false);
      setError('');
    } catch { setError('That is not a Keyshoal pairing QR.'); }
  }
  async function storeMutation(bytes, live) {
    const { vault, base } = opened.current;
    await storage.save(bytes, base);
    live();
    vault.replace(bytes);
    setList(vault.catalogue());
    setConflict(null);
  }
  function sync(choice = undefined) {
    hideSecret();
    const openedHere = opened.current;
    void run(async live => {
      const { vault, base } = openedHere;
      const info = await storage.credentials();
      if (!info) throw new Error('This device needs to be paired again.');
      const result = await syncDevice(vault, base, args => {
        live();
        return storage.request(info, 'Device', info.token, args);
      }, choice);
      live();
      if (result.conflicts) {
        setConflict(result);
        return;
      }
      await storage.save(result.bytes, result.bytes);
      live();
      vault.replace(result.bytes);
      openedHere.base = result.bytes;
      setList(vault.catalogue());
      setConflict(null);
      setSelected(null);
      setEditor(null);
      setDeleting(false);
      setNotice('Synced with desktop.');
    });
  }
  function select(id) { touch(); hideSecret(); setDeleting(false); setSelected(id); setEditor(null); }
  const row = list?.find(item => item.id === selected);
  const update = (name, value) => { touch(); setEditor(previous => ({ ...previous, [name]: value })); };

  return <SafeAreaView style={s.safe}>
    <KeyboardAvoidingView behavior="padding" style={s.flex}>
      <View style={s.header}><View><Text style={s.label}>LOCAL PASSWORD VAULT</Text><Text style={s.brand}>Keyshoal</Text></View>
        {list && <Button label="Lock" secondary onPress={lock} />}</View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
        {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
        {!!notice && <Text style={s.note}>{notice}</Text>}
        {!loaded ? <Text style={s.note}>Opening Keyshoal…</Text> : !list ? (
          scanning ? <View style={s.panel}>
            <Text style={s.title}>Scan pairing QR</Text><Text style={s.note}>On desktop, unlock Keyshoal, start LAN sync, and show a pairing QR.</Text>
            <CameraView style={s.camera} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={scan} />
            <Button label="Cancel" secondary onPress={() => setScanning(false)} />
          </View> : <View style={s.panel}>
            <Text style={s.title}>{pairing ? 'Complete pairing' : known ? 'Unlock your vault' : 'Pair this iPhone'}</Text>
            <Text style={s.note}>{pairing
              ? 'Enter the vault passphrase. This phone must be on the same Wi-Fi as the desktop.'
              : known ? 'The security key is stored in this iPhone’s Keychain.' : 'Connect to the same Wi-Fi as your desktop and scan its private Keyshoal QR.'}</Text>
            {(known || pairing) && <Field label="Passphrase" value={pass} onChangeText={setPass} secure maxLength={1024} onSubmitEditing={pairing ? enrol : unlock} />}
            <Button label={pairing ? 'Pair and unlock' : known ? 'Unlock vault' : 'Scan pairing QR'}
              disabled={busy || Boolean((known || pairing) && !pass)} onPress={pairing ? enrol : known ? unlock : openCamera} />
            {pairing ? <Button label="Cancel pairing" secondary onPress={() => { setPairing(null); setPass(''); }} />
              : known && <Button label="Replace sync connection" secondary disabled={busy} onPress={openCamera} />}
          </View>
        ) : <>
          <View style={s.actions}>
            <Button label="New login" disabled={busy} onPress={() => { select(null); setEditor(blank()); }} />
            <Button label="Sync now" secondary disabled={busy || Boolean(editor)} onPress={() => sync()} />
          </View>
          {conflict && <View style={s.panel}><Text style={s.title}>Review sync conflict</Text>
            <Text style={s.note}>{conflict.conflicts.length} {conflict.conflicts.length === 1 ? 'login was' : 'logins were'} changed on both devices. Choose which version of the conflicting logins to keep. Other changes are merged.</Text>
            {conflict.conflicts.map(id => <Text key={id} style={s.note}>• {list.find(record => record.id === id)?.title ?? 'Login deleted on this phone'}</Text>)}
            <Button label="Keep phone versions" disabled={busy} onPress={() => sync({ revision: conflict.revision, resolution: 'local' })} />
            <Button label="Keep desktop versions" secondary disabled={busy} onPress={() => sync({ revision: conflict.revision, resolution: 'remote' })} />
            <Button label="Decide later" secondary onPress={() => setConflict(null)} />
          </View>}
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
            <View style={s.actions}><Button label="Save login" disabled={busy} onPress={() => run(async live => {
              const next = opened.current.vault.withLogin(editor, editor.id);
              await storeMutation(next.bytes, live);
              setEditor(null); setSelected(next.id); hideSecret();
            })} /><Button label="Cancel" secondary disabled={busy} onPress={() => { setEditor(null); hideSecret(); }} /></View>
          </View> : row ? <View style={s.panel}>
            <Text style={s.title}>{row.title}</Text><Text style={s.note}>{row.origin}</Text><Text>{row.username || 'No username'}</Text>
            <Text selectable={false} style={s.password}>{password ?? '••••••••••••'}</Text>
            <View style={s.actions}>
              <Button label={password !== null ? 'Hide' : 'Reveal'} secondary onPress={() => {
                touch(); if (password !== null) return hideSecret();
                setPassword(opened.current.vault.reveal(row.id));
                revealTimeout.current = setTimeout(hideSecret, 20_000);
              }} />
              <Button label="Copy password" secondary disabled={busy} onPress={() => run(async live => {
                await storage.copy(opened.current.vault.reveal(row.id));
                live(); setNotice('Copied to this device for up to 30 seconds.');
              })} />
              <Button label="Edit" secondary disabled={busy} onPress={() => {
                hideSecret(); setEditor({ ...row, password: opened.current.vault.reveal(row.id) });
              }} />
              <Button label="Delete" secondary disabled={busy} onPress={() => setDeleting(true)} />
            </View>
            {deleting && <View style={s.actions}><Button label="Delete login" disabled={busy} onPress={() => run(async live => {
              await storeMutation(opened.current.vault.withoutLogin(row.id), live);
              select(null);
            })} /><Button label="Cancel" secondary onPress={() => setDeleting(false)} /></View>}
          </View> : null}
          <Text style={s.title}>Logins</Text>
          <Field label="Search" value={query} maxLength={128} onChangeText={v => { touch(); setQuery(v); }} />
          {!list.length && <Text style={s.note}>No logins yet. Add one now or sync with your desktop.</Text>}
          {list.filter(item => [item.title, item.origin, item.username].some(value => value.toLowerCase().includes(query.trim().toLowerCase())))
            .sort((a, b) => a.title.localeCompare(b.title)).map(item => (
              <Pressable key={item.id} accessibilityRole="button" style={s.item} disabled={busy} onPress={() => select(item.id)}>
                <Text style={s.itemTitle}>{item.title}</Text><Text style={s.note}>{item.origin}</Text>
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
  camera:{height:270,borderRadius:8,overflow:'hidden'},actions:{flexDirection:'row',flexWrap:'wrap',gap:8},
  item:{backgroundColor:'#fffdf8',borderColor:'#ccd7cb',borderWidth:1,borderRadius:8,padding:12},
  itemTitle:{fontSize:16,fontWeight:'750',color:'#182d26'},password:{color:'#182d26',fontFamily:'Menlo',paddingVertical:7}
});
