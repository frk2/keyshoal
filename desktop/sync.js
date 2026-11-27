import { connect, createServer, isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Bonjour } from 'bonjour-service';
import { BONJOUR_TYPE, MAX_PACKET, MAX_INVENTORY_PACKET } from '@keyshoal/vault/protocol';

const TIMEOUT = 6500;
const TICK = 2800;
const localName = /^ks-[a-f0-9]{24}$/;
const offline = { mode: 'offline', peers: 0, matched: 0 };

export function localAddress(address, inbound = false) {
  if (typeof address !== 'string') return false;
  const ip = address.replace(/^::ffff:/i, '');
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return isIP(ip) === 6 && (ip === '::1' || /^f[cd]/i.test(ip) ||
    (/^fe[89ab][0-9a-f]:/i.test(ip) && (inbound || ip.includes('%'))));
}

function sendFrame(socket, packet, end = false) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(packet.length);
  const frame = Buffer.concat([header, packet]);
  if (end) socket.end(frame);
  else socket.write(frame);
}

function readFrame(socket, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0, expected;
    socket.on('data', chunk => {
      length += chunk.length;
      if (length > limit + 4) { socket.destroy(); return reject(new Error('Oversized peer frame.')); }
      chunks.push(chunk);
      if (expected === undefined && length >= 4) {
        expected = Buffer.concat(chunks, length).readUInt32BE();
        if (expected < 40 || expected > limit) { socket.destroy(); return reject(new Error('Invalid peer frame.')); }
      }
      if (expected !== undefined && length >= expected + 4) {
        if (length !== expected + 4) { socket.destroy(); return reject(new Error('Unexpected peer data.')); }
        socket.pause();
        resolve(Buffer.concat(chunks, length).subarray(4));
      }
    });
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('Peer disconnected.')));
    socket.setTimeout(TIMEOUT, () => socket.destroy(new Error('Peer timed out.')));
  });
}

export async function exchange(address, port, inventory, sockets = new Set()) {
  if (!localAddress(address) || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid local peer.');
  const socket = connect({ host: address, port });
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  try {
    const response = readFrame(socket, MAX_PACKET);
    sendFrame(socket, inventory);
    return await response;
  } finally { socket.destroy(); }
}

export class PeerNetwork {
  #current;
  #commit;
  #notify;
  #round;
  #status = { mode: 'paused', peers: 0, matched: 0, lastSync: null };
  constructor(current, commit, notify = () => {}) {
    this.#current = current;
    this.#commit = commit;
    this.#notify = notify;
  }
  status() { return { ...this.#status }; }

  #set(fields) {
    if (Object.entries(fields).some(([k, value]) => this.#status[k] !== value)) {
      this.#status = { ...this.#status, ...fields };
      this.#notify();
    }
  }

  stop() {
    const round = this.#round;
    this.#round = undefined;
    if (round) {
      clearInterval(round.timer);
      for (const socket of round.sockets) socket.destroy();
      round.server?.close();
      round.browser?.stop();
      if (round.ad) {
        const fallback = setTimeout(() => round.bonjour?.destroy(), 900).unref();
        round.ad.stop(() => { clearTimeout(fallback); round.bonjour?.destroy(); });
      } else round.bonjour?.destroy();
    }
    this.#set({ mode: 'paused', peers: 0, matched: 0 });
  }

  async start() {
    if (this.#round || !this.#current()) return;
    const id = 'ks-' + randomBytes(12).toString('hex');
    const round = { id, sockets: new Set(), neighbors: new Map(), busy: false, cursor: 0 };
    this.#round = round;
    this.#set(offline);
    try {
      round.server = createServer(socket => {
        if (!localAddress(socket.remoteAddress, true) || this.#round !== round) return socket.destroy();
        round.sockets.add(socket);
        socket.once('close', () => round.sockets.delete(socket));
        readFrame(socket, MAX_INVENTORY_PACKET).then(inventory => {
          const replica = this.#current();
          if (!replica || this.#round !== round) return socket.destroy();
          sendFrame(socket, replica.answer(inventory), true);
        }).catch(() => socket.destroy());
      });
      round.server.maxConnections = 12;
      await new Promise((resolve, reject) => {
        round.server.once('error', reject);
        round.server.once('close', resolve);
        round.server.listen({ host: '::', port: 0 }, resolve);
      });
      if (this.#round !== round) return;
      round.bonjour = new Bonjour({}, () => {
        if (this.#round === round) { this.stop(); this.#set({ mode: 'unavailable' }); }
      });
      round.ad = round.bonjour.publish({ name: id, type: BONJOUR_TYPE, host: id + '.local', port: round.server.address().port });
      round.ad.on('error', () => {
        if (this.#round === round) { this.stop(); this.#set({ mode: 'unavailable' }); }
      });
      round.browser = round.bonjour.find({ type: BONJOUR_TYPE }, service => {
        if (this.#round !== round || service.name === id || !localName.test(service.name) ||
            round.neighbors.size >= 24) return;
        const addresses = (service.addresses ?? []).filter(address => localAddress(address)).sort((a, b) => Number(isIP(b) === 4) - Number(isIP(a) === 4));
        if (addresses.length) {
          round.neighbors.set(service.name, { addresses: addresses.slice(0, 3), port: service.port });
          void this.syncNow();
        }
      });
      round.browser.on('down', service => round.neighbors.delete(service.name));
      round.timer = setInterval(() => {
        round.browser.update();
        void this.syncNow();
      }, TICK);
    } catch {
      if (this.#round === round) { this.stop(); this.#set({ mode: 'unavailable' }); }
    }
  }

  async syncNow() {
    const round = this.#round;
    const replica = this.#current();
    if (!round || !replica || round.busy) return;
    const all = [...round.neighbors.values()];
    const candidates = [];
    for (let i = 0; i < Math.min(all.length, 8); i++) candidates.push(all[(round.cursor + i) % all.length]);
    if (all.length) round.cursor = (round.cursor + candidates.length) % all.length;
    if (!candidates.length) { this.#set(offline); return; }
    round.busy = true;
    if (!this.#status.peers) this.#set({ mode: 'checking' });
    try {
      const results = await Promise.allSettled(candidates.map(async peer => {
        const request = replica.request();
        let reply;
        for (const address of peer.addresses) {
          try { reply = await exchange(address, peer.port, request, round.sockets); break; }
          catch { if (this.#round !== round) return null; }
        }
        if (!reply || this.#round !== round || this.#current() !== replica) return null;
        const { bytes, digest } = replica.integrate(request, reply);
        if (bytes) this.#commit(bytes);
        return digest;
      }));
      if (this.#round !== round || this.#current() !== replica) return;
      const digests = results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
      const digest = replica.digest();
      const matched = digests.filter(remote => remote === digest).length;
      const mode = !digests.length ? 'offline' : matched === digests.length ? 'synced' : 'pending';
      const last = this.#status.lastSync;
      this.#set({
        mode, peers: digests.length, matched,
        lastSync: mode === 'synced' && (this.#status.mode !== 'synced' || last === null) ? Date.now() : last
      });
    } finally { round.busy = false; }
  }

  changed() {
    if (this.#round && this.#status.peers) this.#set({ mode: 'pending', matched: 0 });
  }
}
