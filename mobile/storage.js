import { requireNativeModule } from 'expo-modules-core';
import * as secureStore from 'expo-secure-store';
import { fromByteArray, toByteArray } from 'base64-js';
import { isKey } from '@keyshoal/vault';
import { packMobile, unpackMobile, isPrivateIPv4 } from '@keyshoal/vault/protocol';

const native = requireNativeModule('KeyshoalNative');
const options = { keychainAccessible: secureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export async function credentials() {
  const result = await secureStore.getItemAsync('keyshoal-pair-v1', options);
  if (!result) return null;
  const value = JSON.parse(result);
  if (!isPrivateIPv4(value.ip) || ![value.fingerprint, value.key, value.token].every(isKey)) {
    throw new Error('Keyshoal’s Keychain entry is damaged.');
  }
  return value;
}
export const saveCredentials = value => secureStore.setItemAsync('keyshoal-pair-v1', JSON.stringify(value), options);
export async function load() {
  const encoded = await native.load();
  return encoded ? unpackMobile(toByteArray(encoded)) : null;
}
export const copy = password => native.copy(password);
export const save = (local, base) => native.save(fromByteArray(packMobile(local, base)));
export async function request(connection, kind, token, args) {
  const reply = await native.request({
    ip: connection.ip, fingerprint: connection.fingerprint,
    kind, token, ...args, body: args.body ? fromByteArray(args.body) : null
  });
  return { ...reply, body: toByteArray(reply.body) };
}
