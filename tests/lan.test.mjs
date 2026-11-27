import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeInvite } from '@keyshoal/vault/protocol';
import { Vault } from '@keyshoal/vault';
import { addresses, LanHub } from '../desktop/sync.js';

const ip = addresses()[0];
const port = 46322;
const pass = 'Fixture passphrase, never in use';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function call(certificate, fingerprint, { method = 'GET', endpoint = 'vault', authorization, proof, match, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (authorization) headers.Authorization = authorization;
    if (proof) headers['X-Keyshoal-Proof'] = proof;
    if (match) headers['If-Match'] = '"' + match + '"';
    if (body) {
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Length'] = body.length;
    }
    const req = request({
      method, headers, host: ip, port, path: '/v1/' + endpoint, ca: certificate, agent: false,
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
      checkServerIdentity: (host, cert) => checkServerIdentity(host, cert) ??
        (digest(cert.raw) === fingerprint ? undefined : new Error('Certificate pin mismatch.'))
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Timed out')));
    req.end(body);
  });
}

test('TLS binary round trip, one-use pairing, CAS, integrity, and revocation', { skip: !ip && !process.env.KEYSHOAL_REQUIRE_LAN }, async ({ mock }) => {
  assert.ok(ip, 'An active private IPv4 interface is required.');
  const directory = mkdtempSync(path.join(tmpdir(), 'keyshoal-lan-'));
  const { vault, securityKey } = await Vault.create(pass, randomBytes);
  let commits = 0;
  const hub = new LanHub(directory, () => vault, bytes => { commits++; vault.replace(bytes); }, port);
  try {
    await hub.start(ip);
    const old = decodeInvite(hub.invite(securityKey).qr);
    const file = path.join(directory, 'tls-identity.json');
    const { cert } = JSON.parse(readFileSync(file, 'utf8'));
    const send = options => call(cert, old.fingerprint, options);
    const expires = Date.now() + 130_000;
    const clock = mock.method(Date, 'now', () => expires);
    assert.equal((await send({ authorization: 'Invite ' + old.invite })).status, 401);
    clock.mock.restore();
    const cancelled = decodeInvite(hub.invite(securityKey).qr);
    hub.cancelInvite();
    assert.equal((await send({ authorization: 'Invite ' + cancelled.invite })).status, 401);
    const ticket = decodeInvite(hub.invite(securityKey).qr);
    assert.equal(ticket.key, securityKey);
    await assert.rejects(call(cert, '0'.repeat(64)), /pin mismatch/);
    assert.equal((await send()).status, 401);
    const invite = 'Invite ' + ticket.invite;
    const first = await send({ authorization: invite });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, Buffer.from(vault.bytes()));
    const method = 'POST';
    const endpoint = 'enrol';
    assert.equal((await send({ method, endpoint, authorization: invite, proof: '0'.repeat(64) })).status, 401);
    const paired = await send({ method, endpoint, authorization: invite, proof: vault.enrolProof(ticket.invite) });
    assert.equal(paired.status, 201);
    assert.equal((await send({ authorization: invite })).status, 401);
    const token = paired.headers['x-keyshoal-device'];
    const authorization = 'Device ' + token;
    const peersFile = path.join(directory, 'paired-devices.json');
    assert.equal(readFileSync(peersFile, 'utf8').includes(token), false);
    assert.equal(statSync(peersFile).mode & 0o777, 0o600);
    const match = vault.revision();
    const update = vault.withLogin({ title: 'Fixture', origin: 'https://login.example.test', username: 'fixture', password: 'fixture' });
    const damaged = Buffer.from(update.bytes);
    damaged[damaged.length - 1] ^= 1;
    const put = (body, revision = match) => send({ method: 'PUT', authorization, body, match: revision });
    assert.equal((await put(damaged)).status, 422);
    assert.equal(commits, 0);
    assert.equal((await send({ method: 'PUT', authorization, body: update.bytes })).status, 428);
    assert.equal((await put(update.bytes)).status, 204);
    assert.equal((await put(update.bytes)).status, 412);
    assert.equal(commits, 1);
    assert.equal(vault.reveal(update.id), 'fixture');
    assert.equal((await send({ authorization })).status, 200);
    hub.revoke(hub.status().peers[0].id);
    assert.equal((await send({ authorization })).status, 401);
    hub.stop();
    await assert.rejects(send({ authorization }));
  } finally {
    hub.stop();
    vault.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
