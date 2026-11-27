import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Vault, bytesToHex, checkedRandom, equal, hexToBytes, isId, isKey } from './vault.js';
import { BOOTSTRAP_BYTES, MAX_EVENTS, MAX_INVENTORY_PACKET, MAX_JOURNAL, MAX_PACKET, MAX_RECORD_BOX } from './protocol.js';

const MAGIC = utf8ToBytes('KSREPL02');
const EMPTY = new Uint8Array();
const TAG = 32;
const MAX_PARENTS = 256;
const MIN_EVENT = 16 + 2 + 4 + TAG;
const invDomain = 'peer/v2/inventory';
const deltaDomain = 'peer/v2/delta';
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
const hash = bytes => bytesToHex(sha256(bytes));

function packEvents(events, reserved = 0) {
  if (events.size > MAX_EVENTS) throw new Error('The replica reached its change limit.');
  let length = 4;
  for (const { bytes } of events.values()) length += 4 + bytes.length;
  if (length + reserved > MAX_JOURNAL) throw new Error('The replica reached its storage limit.');
  const packet = new Uint8Array(length);
  const data = view(packet);
  data.setUint32(0, events.size);
  let at = 4;
  for (const [, { bytes }] of [...events].sort(([a], [b]) => a < b ? -1 : 1)) {
    data.setUint32(at, bytes.length);
    packet.set(bytes, at + 4);
    at += 4 + bytes.length;
  }
  return packet;
}

function eventBytes(record, parents, box, crypto) {
  if (parents.length > MAX_PARENTS) throw new Error('Too many competing versions for this login.');
  const body = new Uint8Array(22 + parents.length * 32 + box.length);
  body.set(hexToBytes(record));
  view(body).setUint16(16, parents.length);
  view(body).setUint32(18, box.length);
  [...parents].sort().forEach((parent, i) => body.set(hexToBytes(parent), 22 + 32 * i));
  body.set(box, 22 + 32 * parents.length);
  return concatBytes(body, crypto.journalTag('peer/v2/event', body));
}

function decodeEvent(bytes, crypto) {
  if (bytes.length < MIN_EVENT) throw new Error('Invalid change block.');
  const body = bytes.subarray(0, -TAG);
  if (!equal(crypto.journalTag('peer/v2/event', body), bytes.subarray(-TAG))) throw new Error('Unauthenticated change block.');
  const record = bytesToHex(body.subarray(0, 16));
  const count = view(body).getUint16(16);
  const size = view(body).getUint32(18);
  const boxStart = 22 + count * 32;
  if (count > MAX_PARENTS || size > MAX_RECORD_BOX || boxStart + size !== body.length) {
    throw new Error('Invalid change structure.');
  }
  const parents = [];
  for (let i = 0; i < count; i++) {
    const parent = bytesToHex(body.subarray(22 + i * 32, 22 + (i + 1) * 32));
    if (i && parents[i - 1] >= parent) throw new Error('Invalid change ancestry.');
    parents.push(parent);
  }
  const box = body.subarray(boxStart);
  if (box.length) crypto.readRecord(box, record);
  else if (!parents.length) throw new Error('A deletion needs a previous version.');
  return { bytes, record, parents, box };
}

function readEvents(bytes, crypto) {
  if (bytes.length < 4 || bytes.length > MAX_JOURNAL) throw new Error('Invalid change list.');
  const data = view(bytes);
  const count = data.getUint32(0);
  if (count > MAX_EVENTS) throw new Error('Invalid change count.');
  const events = new Map();
  let at = 4;
  let previous = '';
  for (let i = 0; i < count; i++) {
    if (at + 4 > bytes.length) throw new Error('Truncated change list.');
    const size = data.getUint32(at);
    at += 4;
    if (size < MIN_EVENT || size > MIN_EVENT + 32 * MAX_PARENTS + MAX_RECORD_BOX || at + size > bytes.length) {
      throw new Error('Invalid change size.');
    }
    const encoded = Uint8Array.from(bytes.subarray(at, at + size));
    const id = hash(encoded);
    if (id <= previous) throw new Error('Noncanonical change list.');
    events.set(id, decodeEvent(encoded, crypto));
    previous = id;
    at += size;
  }
  if (at !== bytes.length) throw new Error('Unexpected change data.');
  return events;
}

function headsFor(events) {
  const index = new Map();
  for (const [id, event] of events) {
    if (!index.has(event.record)) index.set(event.record, new Set());
    index.get(event.record).add(id);
  }
  for (const { record, parents } of events.values()) {
    for (const parent of parents) {
      if (events.get(parent)?.record !== record) throw new Error('Missing or unrelated change parent.');
      index.get(record).delete(parent);
    }
  }
  if ([...index.values()].some(heads => !heads.size || heads.size > MAX_PARENTS)) {
    throw new Error('Invalid or excessive change branches.');
  }
  return index;
}

export class Replica {
  #crypto;
  #random;
  #bootstrap;
  #events = new Map();
  #heads = new Map();

  constructor(crypto, random) {
    this.#crypto = crypto;
    this.#random = random;
    this.#bootstrap = crypto.bootstrap();
  }

  static async create(pass, random) {
    const { vault, securityKey } = await Vault.create(pass, random);
    return { vault: new Replica(vault, random), securityKey };
  }

  static async join(bootstrap, pass, key, random) {
    if (bootstrap.length !== BOOTSTRAP_BYTES) throw new Error('Invalid setup header.');
    return new Replica(await Vault.unlock(bootstrap, pass, key, random), random);
  }

  static async unlock(data, pass, key, random) {
    if (!(data instanceof Uint8Array) || data.length > MAX_JOURNAL) throw new Error('Invalid Keyshoal replica.');
    const current = equal(data.subarray(0, 8), MAGIC);
    const crypto = await Vault.unlock(current ? data.subarray(8, 8 + BOOTSTRAP_BYTES) : data, pass, key, random);
    const replica = new Replica(crypto, random);
    try {
      if (current) replica.replace(data);
      else {
        const migrated = new Map();
        for (const { id, box } of crypto.encryptedRecords()) {
          const bytes = eventBytes(id, [], box, crypto);
          migrated.set(hash(bytes), decodeEvent(bytes, crypto));
        }
        replica.#encode(migrated);
        replica.#set(migrated);
        // Keep only the immutable empty header in the old-format codec.
        crypto.replace(replica.#bootstrap);
      }
      return replica;
    } catch (error) { replica.close(); throw error; }
  }

  #set(events) {
    const heads = headsFor(events);
    this.#heads = heads;
    this.#events = events;
  }

  #encode(events) {
    const data = concatBytes(MAGIC, this.#bootstrap, packEvents(events, 8 + BOOTSTRAP_BYTES + TAG));
    return concatBytes(data, this.#crypto.journalTag('peer/v2/store', data));
  }

  #read(data) {
    if (!(data instanceof Uint8Array) || data.length < 8 + BOOTSTRAP_BYTES + 4 + TAG || data.length > MAX_JOURNAL ||
        !equal(data.subarray(0, 8), MAGIC) || !equal(data.subarray(8, 8 + BOOTSTRAP_BYTES), this.#bootstrap) ||
        !equal(this.#crypto.journalTag('peer/v2/store', data.subarray(0, -TAG)), data.subarray(-TAG))) {
      throw new Error('Wrong vault or damaged replica.');
    }
    return readEvents(data.subarray(8 + BOOTSTRAP_BYTES, -TAG), this.#crypto);
  }

  bytes() { return this.#encode(this.#events); }
  bootstrap() { return Uint8Array.from(this.#bootstrap); }
  replace(data) { this.#set(this.#read(data)); }
  validate(data) { headsFor(this.#read(data)); }
  close() { this.#crypto.close(); this.#events.clear(); this.#heads.clear(); }
  get eventCount() { return this.#events.size; }

  #variants(id) {
    const set = this.#heads.get(id);
    if (!set) throw new Error('That login no longer exists.');
    return [...set].sort();
  }

  recordStamp(id) { return hash(utf8ToBytes(this.#variants(id).join(''))); }

  catalogue() {
    const items = [];
    for (const [id] of this.#heads) {
      const versions = this.#variants(id);
      const visible = versions.find(version => this.#events.get(version).box.length);
      if (!visible && versions.length === 1) continue;
      const meta = visible ? this.#crypto.readRecord(this.#events.get(visible).box, id, 'catalogue') :
        { title: 'Deleted login', origin: '', username: '' };
      items.push({ id, stamp: this.recordStamp(id), ...meta, conflict: versions.length > 1 });
    }
    return items;
  }

  variants(id) {
    return this.#variants(id).map(version => {
      const { box } = this.#events.get(version);
      return box.length ? { version, ...this.#crypto.readRecord(box, id, 'catalogue'), deleted: false } :
        { version, deleted: true };
    });
  }

  reveal(id, explicit) {
    const heads = this.#variants(id);
    if (!explicit && heads.length !== 1) throw new Error('Resolve or select a specific conflicting version.');
    const chosen = explicit ?? heads[0];
    if (!heads.includes(chosen)) throw new Error('This version is no longer current.');
    const { box } = this.#events.get(chosen);
    if (!box.length) throw new Error('This version deletes the login.');
    return this.#crypto.readRecord(box, id, 'password');
  }

  #append(id, parents, box) {
    const bytes = eventBytes(id, parents, box, this.#crypto);
    const events = new Map(this.#events);
    events.set(hash(bytes), decodeEvent(bytes, this.#crypto));
    return this.#encode(events);
  }

  withLogin(fields, id) {
    let parents = [];
    if (id !== undefined) {
      parents = this.#variants(id);
      if (parents.length !== 1 || !this.#events.get(parents[0]).box.length) {
        throw new Error('Resolve the conflicting login before editing.');
      }
    } else {
      do { id = bytesToHex(checkedRandom(this.#random, 16)); } while (this.#heads.has(id));
    }
    return { id, bytes: this.#append(id, parents, this.#crypto.sealRecord(fields, id)) };
  }

  withoutLogin(id) {
    const parents = this.#variants(id);
    if (parents.length !== 1 || !this.#events.get(parents[0]).box.length) throw new Error('Resolve the conflicting login before deleting.');
    return this.#append(id, parents, EMPTY);
  }

  resolve(id, version, stamp) {
    const parents = this.#variants(id);
    if (parents.length < 2 || !isKey(version) || !parents.includes(version) || this.recordStamp(id) !== stamp) {
      throw new Error('These versions changed. Review the conflict again.');
    }
    return this.#append(id, parents, this.#events.get(version).box);
  }

  #inventory() {
    const inventory = new Uint8Array(4 + this.#events.size * 32);
    view(inventory).setUint32(0, this.#events.size);
    [...this.#events.keys()].sort().forEach((id, i) => inventory.set(hexToBytes(id), 4 + i * 32));
    return inventory;
  }

  digest() { return hash(this.#inventory()); }
  request() { return this.#crypto.wrapPacket(invDomain, this.#inventory()); }

  answer(request) {
    if (request.length > MAX_INVENTORY_PACKET) throw new Error('Inventory too large.');
    const inventory = this.#crypto.unwrapPacket(invDomain, request);
    if (inventory.length < 4 || view(inventory).getUint32(0) > MAX_EVENTS ||
        inventory.length !== 4 + 32 * view(inventory).getUint32(0)) throw new Error('Invalid inventory.');
    const known = new Set();
    for (let offset = 4; offset < inventory.length; offset += 32) known.add(bytesToHex(inventory.subarray(offset, offset + 32)));
    const missing = new Map([...this.#events].filter(([id]) => !known.has(id)));
    return this.#crypto.wrapPacket(deltaDomain, concatBytes(sha256(this.#inventory()), packEvents(missing)), sha256(request));
  }

  integrate(request, response) {
    if (response.length > MAX_PACKET) throw new Error('Delta too large.');
    const decoded = this.#crypto.unwrapPacket(deltaDomain, response, sha256(request));
    if (decoded.length < 36) throw new Error('Invalid delta.');
    const digest = bytesToHex(decoded.subarray(0, 32));
    const incoming = readEvents(decoded.subarray(32), this.#crypto);
    const events = new Map(this.#events);
    let added = 0;
    for (const [id, event] of incoming) {
      if (!events.has(id)) { events.set(id, event); added++; }
    }
    if (!added) return { bytes: null, digest };
    headsFor(events);
    return { bytes: this.#encode(events), digest };
  }
}
