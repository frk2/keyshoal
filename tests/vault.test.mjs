import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, createHmac } from 'node:crypto';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Vault, KDF, generatePassword, allowedOrigin } from '@keyshoal/vault';
import { decodeInvite, encodeInvite, isPrivateIPv4, packMobile, unpackMobile } from '@keyshoal/vault/protocol';
import { syncDevice } from '@keyshoal/vault/client';
import { answerNative } from '../desktop/bridge.js';

const pass = 'Fixture passphrase, never in use 🐟';
const login = { title: 'Fixture private catalogue', origin: 'https://login.example.test/signin', username: 'fixture-account', password: 'fixture password never used' };
const changed = (vault, fields, id) => {
  const result = vault.withLogin(fields, id);
  vault.replace(result.bytes);
  return result.id;
};

test('encrypted binary needs both factors, authenticates tampering, and reopens exactly', async () => {
  const { vault, securityKey } = await Vault.create(pass, randomBytes);
  const id = changed(vault, login);
  const bytes = vault.bytes();
  const catalogue = vault.catalogue();
  assert.equal(catalogue.length, 1);
  assert.equal(catalogue[0].origin, 'https://login.example.test');
  assert.ok(!('password' in catalogue[0]));
  for (const value of [...Object.values(login), securityKey, pass]) assert.equal(Buffer.from(bytes).includes(value), false);
  assert.equal(vault.reveal(id), login.password);
  await assert.rejects(Vault.unlock(bytes, pass + '!', securityKey, randomBytes), /Wrong security key or passphrase/);
  await assert.rejects(Vault.unlock(bytes, pass, randomBytes(32).toString('hex'), randomBytes), /Wrong security key or passphrase/);
  const tampered = Uint8Array.from(bytes);
  tampered[tampered.length - 40] ^= 1;
  assert.throws(() => vault.validate(tampered), /damaged/);
  assert.throws(() => vault.validate(bytes.subarray(0, -1)), /damaged/);
  vault.close();
  assert.throws(() => vault.reveal(id), /Unlock/);
  const restored = await Vault.unlock(bytes, pass, securityKey, randomBytes);
  assert.deepEqual(restored.bytes(), bytes);
  assert.equal(restored.reveal(id), login.password);
  restored.close();
});

test('unlock, catalogue, authenticated validation and sync do not open the password box', async () => {
  const { vault, securityKey } = await Vault.create(pass, randomBytes);
  const id = changed(vault, login);
  const bytes = vault.bytes();
  const view = new DataView(bytes.buffer);
  const passwordAt = 68 + view.getUint32(60);
  bytes[passwordAt + 24] ^= 1;
  // Build a deliberately AEAD-invalid password with a valid outer MAC.
  const mixed = createHmac('sha256', Buffer.from(securityKey, 'hex')).update(pass).digest();
  const root = await argon2idAsync(mixed, bytes.subarray(24, 40), KDF);
  const fileKey = hkdf(sha256, root, bytes.subarray(8, 24), new TextEncoder().encode('keyshoal/v1/file'), 32);
  bytes.set(createHmac('sha256', fileKey).update(bytes.subarray(0, -32)).digest(), bytes.length - 32);
  const restored = await Vault.unlock(bytes, pass, securityKey, randomBytes);
  assert.equal(restored.catalogue()[0].title, login.title);
  restored.validate(bytes);
  assert.deepEqual(restored.merge(bytes, bytes), { bytes, conflicts: [] });
  assert.deepEqual(answerNative(restored, { action: 'list', origin: 'https://login.example.test' }), { entries: [{ id, title: login.title }] });
  assert.throws(() => restored.reveal(id));
  vault.close();
  restored.close();
});

test('three-way merge keeps independent edits and surfaces edit/delete conflicts without opening records', async () => {
  const { vault } = await Vault.create(pass, randomBytes);
  const id = changed(vault, login);
  const base = vault.bytes();
  vault.replace(vault.withoutLogin(id));
  const otherId = changed(vault, { ...login, title: 'Only desktop' });
  const remote = vault.bytes();
  vault.replace(base);
  changed(vault, { ...login, title: 'Phone changed it' }, id);
  const result = vault.merge(base, remote);
  assert.deepEqual(result.conflicts, [id]);
  assert.equal(result.bytes, null);
  vault.replace(vault.merge(base, remote, 'local').bytes);
  assert.deepEqual(new Set(vault.catalogue().map(r => r.id)), new Set([id, otherId]));
  vault.replace(vault.merge(base, remote, 'remote').bytes);
  assert.deepEqual(vault.catalogue().map(r => r.id), [otherId]);
  vault.close();
});

test('sync retries compare-and-swap, preserves updates, and binds conflict consent to reviewed revision', async () => {
  const { vault } = await Vault.create(pass, randomBytes);
  const id = changed(vault, login);
  const base = vault.bytes();
  const remoteId = changed(vault, { ...login, title: 'New remote' });
  let desktop = vault.bytes();
  vault.replace(base);
  changed(vault, { ...login, title: 'Local edit' }, id);
  let attempts = 0;
  const request = async ({ method, match, body }) => {
    if (method === 'GET') return { status: 200, body: desktop };
    assert.equal(match, vault.revision(desktop));
    if (++attempts === 1) return { status: 412 };
    desktop = body;
    return { status: 204 };
  };
  const result = await syncDevice(vault, base, request);
  assert.equal(attempts, 2);
  const oldLocal = vault.bytes();
  vault.replace(result.bytes);
  assert.equal(vault.catalogue().find(row => row.id === id).title, 'Local edit');
  assert.equal(vault.catalogue().find(row => row.id === remoteId).title, 'New remote');
  changed(vault, { ...login, title: 'Remote edit' }, id);
  desktop = vault.bytes();
  vault.replace(oldLocal);
  const conflict = await syncDevice(vault, base, request);
  assert.deepEqual(conflict.conflicts, [id]);
  await assert.rejects(syncDevice(vault, base, request, { revision: 'old', resolution: 'local' }), /desktop changed/);
  assert.deepEqual(vault.bytes(), oldLocal);
  vault.close();
});

test('parsing, password generation, mobile file framing, and exact-origin bridge bounds', async () => {
  assert.equal(allowedOrigin('https://example.test:444/path'), 'https://example.test:444');
  assert.throws(() => allowedOrigin('https://user:secret@example.test'));
  assert.throws(() => allowedOrigin('javascript:alert(1)'));
  const validIPs = ['192.168.1.3', '10.4.3.2', '172.17.3.4'];
  const badIPs = ['8.8.8.8', '172.32.0.1', '10.0.0.256', '10.020.0.2', '192.168.0.1/'];
  for (const ip of validIPs) assert.ok(isPrivateIPv4(ip));
  for (const ip of badIPs) assert.ok(!isPrivateIPv4(ip));
  const token = 'a'.repeat(64);
  const qr = { ip: validIPs[0], fingerprint: token, invite: token, key: token };
  assert.deepEqual(decodeInvite(encodeInvite(qr)), qr);
  assert.throws(() => decodeInvite(encodeInvite(qr).replace(validIPs[0], badIPs[0])));
  const packet = packMobile(Uint8Array.of(1, 2), Uint8Array.of(3));
  assert.deepEqual(unpackMobile(packet), { local: Uint8Array.of(1, 2), base: Uint8Array.of(3) });
  assert.throws(() => unpackMobile(packet.subarray(0, 6)));
  assert.throws(() => generatePassword(randomBytes, 19));
  const samples = new Set(Array.from({ length: 50 }, () => generatePassword(randomBytes)));
  assert.equal(samples.size, 50);
  for (const password of samples) {
    assert.equal(password.length, 28);
    for (const type of [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/]) assert.match(password, type);
  }
  const { vault } = await Vault.create(pass, randomBytes);
  const id = changed(vault, login);
  for (const origin of ['http://login.example.test', 'https://evil.test', 'https://sub.login.example.test', 'https://login.example.test:444', login.origin]) {
    assert.equal(answerNative(vault, { action: 'fill', origin, id }).password, undefined);
  }
  assert.equal(answerNative(null, { action: 'fill', origin: 'https://login.example.test', id }).password, undefined);
  assert.equal(answerNative(vault, { action: 'fill', origin: 'https://login.example.test', id }).password, login.password);
  vault.close();
});
