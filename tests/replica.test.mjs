import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { Replica } from '@keyshoal/vault/replica';
import { decodeSetup, encodeSetup } from '@keyshoal/vault/protocol';
import { Vault } from '@keyshoal/vault';
import { answerNative } from '../desktop/bridge.js';

const pass = 'Synthetic test passphrase only';
const fields = { title: 'Fixture login', origin: 'https://fixture.example.test', username: 'fixture', password: 'fixture original' };

function save(at, patch = {}, id) {
  const result = at.withLogin({ ...fields, ...patch }, id);
  at.replace(result.bytes);
  return result.id;
}
function pull(at, from) {
  const request = at.request();
  const response = from.answer(request);
  const applied = at.integrate(request, response);
  if (applied.bytes) at.replace(applied.bytes);
  return { changed: Boolean(applied.bytes), size: response.length };
}
function both(a, b) { pull(a, b); pull(b, a); }
async function second(vault, key) {
  return Replica.join(vault.bootstrap(), pass, key, randomBytes);
}

test('setup works offline, reopens with both factors, and does not expose plaintext', async () => {
  const { vault: a, securityKey } = await Replica.create(pass, randomBytes);
  const code = encodeSetup(securityKey, a.bootstrap());
  assert.ok(!code.includes(pass));
  const { bootstrap, key } = decodeSetup(code);
  const b = await Replica.join(bootstrap, pass, key, randomBytes);
  assert.equal(b.eventCount, 0);
  assert.throws(() => decodeSetup(code.replace(/.$/, '!')));
  await assert.rejects(Replica.join(bootstrap, pass + '!', key, randomBytes), /Wrong/);
  const id = save(b);
  const local = b.bytes();
  for (const value of [...Object.values(fields), key, pass]) assert.ok(!Buffer.from(local).includes(value));
  const reopened = await Replica.unlock(local, pass, key, randomBytes);
  assert.equal(reopened.reveal(id), fields.password);
  assert.ok(!('password' in reopened.catalogue()[0]));
  const altered = Uint8Array.from(local);
  altered[altered.length - 50] ^= 1;
  assert.throws(() => reopened.replace(altered), /damaged/);
  assert.throws(() => reopened.replace(local.subarray(0, -30)), /damaged/);
  a.close(); b.close(); reopened.close();
});

test('hash inventory transfers missing blocks only, and works after the creator goes offline', async () => {
  const { vault: a, securityKey } = await Replica.create(pass, randomBytes);
  const [b, c] = await Promise.all([second(a, securityKey), second(a, securityKey)]);
  const one = save(a);
  pull(b, a);
  a.close();
  const two = save(c, { title: 'Independent login' });
  both(b, c);
  assert.deepEqual(b.bytes(), c.bytes());
  assert.equal(b.reveal(two), fields.password);
  assert.equal(c.reveal(one), fields.password);
  const empty = pull(c, b);
  assert.deepEqual(empty, { changed: false, size: 76 });
  const previous = c.bytes().length;
  const edited = save(b, { password: 'new value' }, one);
  assert.equal(edited, one);
  const small = pull(c, b);
  assert.equal(small.changed, true);
  assert.ok(small.size < b.bytes().length && previous < b.bytes().length);
  assert.deepEqual(b.bytes(), c.bytes());
  b.close(); c.close();
});

test('concurrent edits stay sealed and choosing a version offline converges all peers', async () => {
  const { vault: a, securityKey } = await Replica.create(pass, randomBytes);
  const [b, c] = await Promise.all([second(a, securityKey), second(a, securityKey)]);
  const id = save(a);
  pull(b, a); pull(c, a);
  save(a, { title: 'Version on A', password: 'version A' }, id);
  save(b, { title: 'Version on B', password: 'version B' }, id);
  both(a, b);
  assert.ok(b.catalogue()[0].conflict);
  assert.throws(() => b.reveal(id), /specific conflicting/);
  assert.equal(answerNative(b, { action: 'fill', origin: fields.origin, id }).password, undefined);
  const entries = b.variants(id);
  assert.equal(entries.length, 2);
  assert.ok(entries.every(entry => !('password' in entry)));
  const chosen = entries.find(version => version.title === 'Version on B');
  assert.equal(b.reveal(id, chosen.version), 'version B');
  assert.throws(() => b.resolve(id, chosen.version, 'stale'), /changed/);
  const stamp = b.recordStamp(id);
  b.replace(b.resolve(id, chosen.version, stamp));
  assert.equal(b.reveal(id), 'version B');
  both(b, c); both(a, c);
  for (const node of [a, b, c]) assert.equal(node.reveal(id), 'version B');
  assert.deepEqual(a.bytes(), c.bytes());
  a.close(); b.close(); c.close();
});

test('delete versus edit is a choice, unseen edits conflict again, and stale peers cannot resurrect a deletion', async () => {
  const { vault: a, securityKey } = await Replica.create(pass, randomBytes);
  const [b, c] = await Promise.all([second(a, securityKey), second(a, securityKey)]);
  const id = save(a);
  pull(b, a); pull(c, a);
  a.replace(a.withoutLogin(id));
  save(b, { password: 'edit on offline peer' }, id);
  both(a, b);
  const deletion = a.variants(id).find(x => x.deleted);
  assert.ok(deletion);
  a.replace(a.resolve(id, deletion.version, a.recordStamp(id)));
  assert.equal(a.catalogue().length, 0);
  pull(a, c); // no new edit yet, so a stale peer cannot undo the deletion
  assert.equal(a.catalogue().length, 0);
  save(c, { password: 'edit unseen when resolving' }, id);
  both(a, c);
  assert.ok(a.catalogue()[0].conflict);
  const removeAgain = a.variants(id).find(x => x.deleted);
  a.replace(a.resolve(id, removeAgain.version, a.recordStamp(id)));
  both(a, b); both(a, c);
  for (const node of [a, b, c]) { assert.equal(node.catalogue().length, 0); node.close(); }
});

test('a reply is tied to its inventory and foreign or altered wire messages are rejected', async () => {
  const { vault: a, securityKey } = await Replica.create(pass, randomBytes);
  const { vault: outsider } = await Replica.create(pass, randomBytes);
  const b = await second(a, securityKey);
  save(a);
  const req = b.request();
  const reply = a.answer(req);
  assert.throws(() => b.integrate(b.request(), reply));
  assert.throws(() => outsider.answer(req));
  assert.throws(() => outsider.integrate(req, reply));
  const altered = Uint8Array.from(reply);
  altered[altered.length - 8] ^= 1;
  assert.throws(() => b.integrate(req, altered));
  assert.equal(b.catalogue().length, 0);
  a.close(); b.close(); outsider.close();
});

test('the single-device preview snapshot migrates using its existing encrypted record boxes', async () => {
  const { vault, securityKey } = await Vault.create(pass, randomBytes);
  const { id, bytes } = vault.withLogin(fields);
  vault.close();
  const first = await Replica.unlock(bytes, pass, securityKey, randomBytes);
  const second = await Replica.unlock(bytes, pass, securityKey, randomBytes);
  assert.deepEqual(first.bytes(), second.bytes());
  assert.equal(first.reveal(id), fields.password);
  assert.equal(pull(first, second).changed, false);
  first.close(); second.close();
});
