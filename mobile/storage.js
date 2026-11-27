import { requireNativeModule } from 'expo-modules-core';
import * as secureStore from 'expo-secure-store';
import { fromByteArray, toByteArray } from 'base64-js';
import { isKey } from '@keyshoal/vault';
import { legacyMobileLocal } from '@keyshoal/vault/protocol';

const native = requireNativeModule('KeyshoalNative');
const options = { keychainAccessible: secureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const decode = encoded => toByteArray(encoded);
const encode = bytes => fromByteArray(bytes);
export async function securityKey() {
  const result = await secureStore.getItemAsync('keyshoal-key-v2', options);
  if (result) {
    if (!isKey(result)) throw new Error('Keyshoal’s Keychain entry is damaged.');
    return result;
  }
  const old = await secureStore.getItemAsync('keyshoal-pair-v1', options);
  const key = old ? JSON.parse(old).key : null;
  if (key && !isKey(key)) throw new Error('Keyshoal’s Keychain entry is damaged.');
  return key;
}
export const saveKey = key => secureStore.setItemAsync('keyshoal-key-v2', key, options);
export async function load() {
  const encoded = await native.load();
  if (!encoded) return null;
  const bytes = decode(encoded);
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  return magic === 'KSREPL02' ? bytes : legacyMobileLocal(bytes);
}
export const copy = text => native.copy(text);
export const qr = text => native.qr(text);
export const save = bytes => native.save(encode(bytes));
export const peerStart = () => native.peerStart();
export const peerStop = () => native.peerStop();
export const peerList = () => native.peerList();
export const peerRequest = async (peer, packet) => decode(await native.peerRequest(peer, encode(packet)));
export const respond = (id, packet) => native.peerRespond(id, packet ? encode(packet) : '');
export const listen = handler => native.addListener('peerInventory', ({ id, packet }) => handler(id, decode(packet)));
