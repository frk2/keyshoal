import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

export { bytesToHex, hexToBytes };
export const MAX_VAULT = 4 * 1024 * 1024;
export const KDF = Object.freeze({ m: 65_536, t: 3, p: 4, dkLen: 32, version: 0x13, asyncTick: 8 });
const MAX_ITEMS = 4096;
const MAX_BOX = 16_384;
const MAGIC = utf8ToBytes('KSHOAL01');
const HEADER = 44;
const TAG = 32;
const NONCE = 24;
const MIN_BOX = NONCE + 16 + 1;
const UUID = /^[0-9a-f]{32}$/;
const KEY = /^[0-9a-f]{64}$/;
const name = label => utf8ToBytes('keyshoal/v1/' + label);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const isKey = value => typeof value === 'string' && KEY.test(value);
export const isId = value => typeof value === 'string' && UUID.test(value);
export const allowedOrigin = value => {
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//i.test(value)) {
    throw new Error('Enter a website address starting with https:// or http://.');
  }
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new Error('Enter a website address without embedded credentials.');
  }
  return url.origin;
};

export function equal(a, b) {
  if (a?.length !== b?.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function checkedRandom(random, size) {
  const bytes = random(size);
  if (!(bytes instanceof Uint8Array) || bytes.length !== size) throw new Error('Secure randomness unavailable.');
  return Uint8Array.from(bytes);
}

export function generatePassword(random, size = 28) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*_-+=';
  if (!Number.isInteger(size) || size < 20 || size > 128) throw new Error('Choose 20–128 characters.');
  const limit = 256 - (256 % alphabet.length);
  // Rejection sampling avoids modulo bias and enforces one character of each class.
  for (;;) {
    let password = '';
    while (password.length < size) {
      const bytes = checkedRandom(random, 2 * size);
      for (const byte of bytes) {
        if (byte < limit && password.length < size) password += alphabet[byte % alphabet.length];
      }
      bytes.fill(0);
    }
    if (/[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password) &&
        /[^A-Za-z0-9]/.test(password)) return password;
  }
}

function passphraseBytes(passphrase, creating = false) {
  if (typeof passphrase !== 'string' || passphrase.length > 1024 ||
      (creating && Array.from(passphrase).length < 16) || passphrase.length === 0) {
    throw new Error(creating ? 'Use a passphrase with at least 16 characters.' : 'Enter your vault passphrase.');
  }
  // Do not silently replace invalid UTF-16 surrogate pairs with U+FFFD.
  const encoded = utf8ToBytes(passphrase);
  if (utf8.decode(encoded) !== passphrase) throw new Error('Passphrase contains invalid Unicode.');
  return encoded;
}

async function derive(passphrase, securityKey, salt, vaultId, creating = false) {
  if (!isKey(securityKey)) throw new Error('Enter the 64-character security key.');
  const pass = passphraseBytes(passphrase, creating);
  const key = hexToBytes(securityKey);
  let mixed, root;
  try {
    mixed = hmac(sha256, key, pass);
    pass.fill(0);
    key.fill(0);
    root = await argon2idAsync(mixed, salt, KDF);
    return Object.fromEntries(['catalogue', 'password', 'file', 'enrol'].map(label =>
      [label, hkdf(sha256, root, vaultId, name(label), 32)]));
  } finally {
    for (const bytes of [pass, key, mixed, root]) bytes?.fill(0);
  }
}

function normalizedMeta(fields) {
  if (!fields || typeof fields !== 'object' || typeof fields.title !== 'string' ||
      !fields.title.trim() || fields.title.length > 128 || typeof fields.username !== 'string' ||
      fields.username.length > 512) throw new Error('Enter a title and a valid username.');
  return { title: fields.title.trim(), origin: allowedOrigin(fields.origin), username: fields.username };
}

function parse(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER + TAG || bytes.length > MAX_VAULT ||
      !equal(bytes.subarray(0, 8), MAGIC)) throw new Error('Unsupported or damaged Keyshoal vault.');
  return { raw: bytes, id: Uint8Array.from(bytes.subarray(8, 24)), salt: Uint8Array.from(bytes.subarray(24, 40)) };
}

function bodyEntries(raw) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const count = view.getUint32(40);
  const end = raw.length - TAG;
  if (count > MAX_ITEMS) throw new Error('Invalid vault record count.');
  const entries = new Map();
  let at = HEADER;
  let prev = '';
  for (let i = 0; i < count; i++) {
    if (at + 24 > end) throw new Error('Truncated vault record.');
    const id = bytesToHex(raw.subarray(at, at + 16));
    const metaLength = view.getUint32(at + 16);
    const passwordLength = view.getUint32(at + 20);
    if (id <= prev || metaLength < MIN_BOX || passwordLength < MIN_BOX ||
        metaLength > MAX_BOX || passwordLength > MAX_BOX || at + 24 + metaLength + passwordLength > end) {
      throw new Error('Invalid vault record.');
    }
    at += 24;
    const catalogue = Uint8Array.from(raw.subarray(at, at + metaLength));
    at += metaLength;
    const password = Uint8Array.from(raw.subarray(at, at + passwordLength));
    at += passwordLength;
    prev = id;
    entries.set(id, { catalogue, password });
  }
  if (at !== end) throw new Error('Unexpected vault data.');
  return entries;
}

function box(random, key, aad, value) {
  const plaintext = utf8ToBytes(JSON.stringify(value));
  try {
    const nonce = checkedRandom(random, NONCE);
    return concatBytes(nonce, xchacha20poly1305(key, nonce, aad).encrypt(plaintext));
  } finally {
    plaintext.fill(0);
  }
}

function unbox(key, aad, ciphertext) {
  const plaintext = xchacha20poly1305(key, ciphertext.subarray(0, NONCE), aad).decrypt(ciphertext.subarray(NONCE));
  try {
    return JSON.parse(utf8.decode(plaintext));
  } finally {
    plaintext.fill(0);
  }
}

const same = (a, b) => a === b || Boolean(a && b && equal(a.catalogue, b.catalogue) && equal(a.password, b.password));

// The catalogue and password boxes are separate. Only reveal() opens a password box.
export class Vault {
  #keys;
  #id;
  #salt;
  #random;
  #records;
  constructor(keys, id, salt, random, records = new Map()) {
    this.#keys = keys;
    this.#id = id;
    this.#salt = salt;
    this.#random = random;
    this.#records = records;
  }

  static async create(passphrase, random) {
    const id = checkedRandom(random, 16);
    const salt = checkedRandom(random, 16);
    const secret = checkedRandom(random, 32);
    const securityKey = bytesToHex(secret);
    secret.fill(0);
    const keys = await derive(passphrase, securityKey, salt, id, true);
    return { vault: new Vault(keys, id, salt, random), securityKey };
  }

  static async unlock(bytes, passphrase, securityKey, random) {
    const { raw, id, salt } = parse(bytes);
    const keys = await derive(passphrase, securityKey, salt, id);
    const vault = new Vault(keys, id, salt, random);
    try {
      vault.replace(raw);
      return vault;
    } catch (error) {
      vault.close();
      throw error;
    }
  }

  #requireOpen() {
    if (!this.#keys) throw new Error('Unlock your vault first.');
  }

  #read(bytes) {
    this.#requireOpen();
    const { raw, id, salt } = parse(bytes);
    const end = raw.length - TAG;
    if (!equal(this.#id, id) || !equal(this.#salt, salt) ||
        !equal(hmac(sha256, this.#keys.file, raw.subarray(0, end)), raw.subarray(end))) {
      throw new Error('Wrong security key or passphrase, or the vault is damaged.');
    }
    return bodyEntries(raw);
  }

  #serialize(records) {
    this.#requireOpen();
    if (records.size > MAX_ITEMS) throw new Error('The vault has too many entries.');
    let size = HEADER + TAG;
    for (const { catalogue, password } of records.values()) size += 24 + catalogue.length + password.length;
    if (size > MAX_VAULT) throw new Error('The vault reached its size limit.');
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    out.set(MAGIC);
    out.set(this.#id, 8);
    out.set(this.#salt, 24);
    view.setUint32(40, records.size);
    let at = HEADER;
    for (const id of [...records.keys()].sort()) {
      const { catalogue, password } = records.get(id);
      out.set(hexToBytes(id), at);
      view.setUint32(at + 16, catalogue.length);
      view.setUint32(at + 20, password.length);
      at += 24;
      out.set(catalogue, at);
      at += catalogue.length;
      out.set(password, at);
      at += password.length;
    }
    out.set(hmac(sha256, this.#keys.file, out.subarray(0, at)), at);
    return out;
  }

  bytes() { return this.#serialize(this.#records); }
  revision(bytes = this.bytes()) { return bytesToHex(sha256(bytes)); }
  validate(bytes) { this.#read(bytes); }
  replace(bytes) { this.#records = this.#read(bytes); }
  #aad(label, id) { return concatBytes(name(label), this.#id, hexToBytes(id)); }

  catalogue() {
    this.#requireOpen();
    return [...this.#records].map(([id, record]) => ({
      id, stamp: this.recordStamp(id), ...normalizedMeta(unbox(this.#keys.catalogue, this.#aad('catalogue', id), record.catalogue))
    }));
  }

  recordStamp(id) {
    this.#requireOpen();
    const record = this.#records.get(id);
    if (!record) throw new Error('That login no longer exists.');
    return this.revision(concatBytes(record.catalogue, record.password));
  }

  reveal(id) {
    this.#requireOpen();
    const record = this.#records.get(id);
    if (!record) throw new Error('That login no longer exists.');
    return unbox(this.#keys.password, this.#aad('password', id), record.password);
  }

  withLogin(fields, id = undefined) {
    this.#requireOpen();
    const meta = normalizedMeta(fields);
    if (typeof fields.password !== 'string' || fields.password.length < 1 || fields.password.length > 1024) {
      throw new Error('Enter a password of 1–1024 characters.');
    }
    if (id !== undefined && !this.#records.has(id)) throw new Error('That login no longer exists.');
    if (id === undefined) {
      do { id = bytesToHex(checkedRandom(this.#random, 16)); } while (this.#records.has(id));
    }
    const records = new Map(this.#records);
    records.set(id, {
      catalogue: box(this.#random, this.#keys.catalogue, this.#aad('catalogue', id), meta),
      password: box(this.#random, this.#keys.password, this.#aad('password', id), fields.password)
    });
    return { bytes: this.#serialize(records), id };
  }

  withoutLogin(id) {
    this.#requireOpen();
    if (!this.#records.has(id)) throw new Error('That login no longer exists.');
    const records = new Map(this.#records);
    records.delete(id);
    return this.#serialize(records);
  }

  merge(base, remote, resolution) {
    this.#requireOpen();
    if (resolution !== undefined && !['local', 'remote'].includes(resolution)) throw new Error('Invalid resolution.');
    const before = this.#read(base);
    const incoming = this.#read(remote);
    const records = new Map();
    const conflicts = [];
    for (const id of new Set([...before.keys(), ...this.#records.keys(), ...incoming.keys()])) {
      const old = before.get(id);
      const mine = this.#records.get(id);
      const theirs = incoming.get(id);
      let record;
      if (same(mine, theirs) || same(theirs, old)) record = mine;
      else if (same(mine, old)) record = theirs;
      else {
        conflicts.push(id);
        record = resolution === 'remote' ? theirs : mine;
      }
      if (record) records.set(id, record);
    }
    return { conflicts, bytes: conflicts.length && !resolution ? null : this.#serialize(records) };
  }

  enrolProof(invite) {
    this.#requireOpen();
    if (!isKey(invite)) throw new Error('Invalid pairing invite.');
    return bytesToHex(hmac(sha256, this.#keys.enrol, concatBytes(name('invite proof'), hexToBytes(invite))));
  }

  close() {
    if (this.#keys) Object.values(this.#keys).forEach(key => key.fill(0));
    this.#keys = null;
    this.#records.clear();
  }
}
