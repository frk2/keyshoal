import { bytesToHex, hexToBytes, isKey } from './vault.js';

export const BONJOUR_TYPE = 'keyshoal-v2';
export const MAX_JOURNAL = 8 * 1024 * 1024;
export const MAX_PACKET = MAX_JOURNAL + 64;
export const MAX_EVENTS = 8192;
export const MAX_INVENTORY_PACKET = 4 + 32 * MAX_EVENTS + 40;
export const MAX_RECORD_BOX = 32_768;
export const BOOTSTRAP_BYTES = 76;
export const SETUP_PREFIX = 'keyshoal-v2:';

export function encodeSetup(key, bootstrap) {
  if (!isKey(key) || bootstrap?.length !== BOOTSTRAP_BYTES) throw new Error('Invalid Keyshoal setup data.');
  return SETUP_PREFIX + key + bytesToHex(bootstrap);
}

export function decodeSetup(text) {
  if (typeof text !== 'string' || text.length > 240) throw new Error('Invalid Keyshoal setup code.');
  const clean = text.trim();
  if (!clean.startsWith(SETUP_PREFIX) || clean.length !== SETUP_PREFIX.length + 64 + BOOTSTRAP_BYTES * 2) {
    throw new Error('This is not a Keyshoal peer setup code.');
  }
  const key = clean.slice(SETUP_PREFIX.length, SETUP_PREFIX.length + 64);
  const hex = clean.slice(SETUP_PREFIX.length + 64);
  if (!isKey(key) || !/^[0-9a-f]+$/.test(hex)) throw new Error('Invalid Keyshoal setup code.');
  return { key, bootstrap: hexToBytes(hex) };
}

// Only for reading the earlier preview's local mobile snapshot. No peer role
// or connection settings from that preview survive migration.
export function legacyMobileLocal(data) {
  if (data.length <= 4) throw new Error('Damaged local vault.');
  const size = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
  if (size < BOOTSTRAP_BYTES || size > data.length - 4) throw new Error('Damaged local vault.');
  return data.subarray(4, 4 + size);
}
