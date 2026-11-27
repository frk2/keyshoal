import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Replica } from '@keyshoal/vault/replica';
import { PeerNetwork, localAddress } from '../desktop/sync.js';

const pass = 'Synthetic test passphrase only';
const origin = 'https://fixture.example.test';
async function waitFor(check, message, ms = 18_000) {
  const until = Date.now() + ms;
  do {
    if (check()) return;
    await delay(100);
  } while (Date.now() < until);
  assert.fail(message);
}
function add(vault, title) {
  const { id, bytes } = vault.withLogin({ title, origin, username: '', password: 'synthetic fixture' });
  vault.replace(bytes);
  return id;
}

test('LAN addressing only allows private, loopback, and usable local addresses', () => {
  for (const ip of ['192.168.1.3', '10.4.3.2', '172.17.3.4', '169.254.10.11', '::1', 'fd00::5', 'fe80::2%eth0', '::ffff:192.168.1.2']) {
    assert.ok(localAddress(ip), ip);
  }
  for (const ip of ['9.1.2.3', '172.32.0.5', '192.168.400.4', 'whatever.local', 'fe80::2', '2001:db8::1']) {
    assert.ok(!localAddress(ip), ip);
  }
});

test('three real Bonjour/TCP replicas converge without the creating device', { skip: !process.env.KEYSHOAL_REQUIRE_LAN }, async () => {
  const { vault: a, securityKey } = await Replica.create(pass, randomBytes);
  const [b, c] = await Promise.all([a, a].map(() => Replica.join(a.bootstrap(), pass, securityKey, randomBytes)));
  const network = [a,b,c].map(peer => new PeerNetwork(() => peer, bytes => peer.replace(bytes)));
  const [A, B, C] = network;
  const one = add(a, 'Created offline');
  try {
    await Promise.all(network.map(node => node.start()));
    await waitFor(() => [b,c].every(peer => peer.eventCount === 1), 'Initial encrypted change did not reach the other replicas.');
    await waitFor(() => network.every(node => node.status().mode === 'synced' && node.status().peers === 2), 'Peers did not report convergence.');
    A.stop();
    const two = add(b, 'New login without the creator');
    B.changed();
    await waitFor(() => c.eventCount === 2 && c.reveal(two) === 'synthetic fixture', 'Peers still depended on the original node.');
    c.replace(c.withoutLogin(one));
    C.changed();
    await waitFor(() => b.eventCount === 3 && b.catalogue().length === 1, 'Deletion failed to replicate.');
    await A.start();
    await waitFor(() => a.eventCount === 3 && a.catalogue().length === 1, 'Rejoining replica failed to catch up.');
    assert.deepEqual(a.bytes(), b.bytes());
    assert.deepEqual(b.bytes(), c.bytes());
  } finally {
    network.forEach(node => node.stop());
    [a,b,c].forEach(v => v.close());
  }
});
