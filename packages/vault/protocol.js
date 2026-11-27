import { isKey, MAX_VAULT } from './vault.js';

export const PORT = 46321;
export const INVITE_MS = 120_000;
export const MAX_MOBILE_STORE = 2 * MAX_VAULT + 4;

export function isPrivateIPv4(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) return false;
  const [a, b, c, d] = value.split('.').map(Number);
  return [a, b, c, d].every(n => n < 256) &&
    (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
}

export function decodeInvite(qr) {
  if (typeof qr !== 'string' || qr.length > 600 || !qr.startsWith('keyshoal-pair-v1:')) {
    throw new Error('This is not a Keyshoal pairing code.');
  }
  const { ip, fingerprint, invite, key } = JSON.parse(qr.slice('keyshoal-pair-v1:'.length));
  if (!isPrivateIPv4(ip) || !isKey(fingerprint) || !isKey(invite) || !isKey(key)) {
    throw new Error('Invalid Keyshoal pairing code.');
  }
  return { ip, fingerprint, invite, key };
}

export function encodeInvite(fields) {
  const text = 'keyshoal-pair-v1:' + JSON.stringify(fields);
  decodeInvite(text);
  return text;
}

export function packMobile(local, base) {
  if (local.length > MAX_VAULT || base.length > MAX_VAULT) throw new Error('Vault is too large.');
  const data = new Uint8Array(4 + local.length + base.length);
  new DataView(data.buffer).setUint32(0, local.length);
  data.set(local, 4);
  data.set(base, 4 + local.length);
  return data;
}

export function unpackMobile(data) {
  if (data.length <= 4 || data.length > MAX_MOBILE_STORE) throw new Error('Damaged local vault.');
  const size = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
  if (!size || size > MAX_VAULT || size >= data.length - 4 || data.length - 4 - size > MAX_VAULT) {
    throw new Error('Damaged local vault.');
  }
  return { local: data.subarray(4, 4 + size), base: data.subarray(4 + size) };
}
