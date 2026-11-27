import { createServer } from 'node:net';
import { lstatSync, chmodSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { allowedOrigin, isId } from '@keyshoal/vault';
import { privateDirectory } from './files.js';

const MAX_REQ = 4096;
const MAX_RESPONSE = 512 * 1024;

export function answerNative(vault, request) {
  if (!vault) return { error: 'Open and unlock the Keyshoal desktop app first.' };
  if (!request || typeof request !== 'object' || typeof request.origin !== 'string' ||
      !request.origin.startsWith('https://') || allowedOrigin(request.origin) !== request.origin) {
    return { error: 'Keyshoal can only fill an exact HTTPS origin.' };
  }
  const sameOrigin = vault.catalogue().filter(item => item.origin === request.origin);
  const matching = sameOrigin.filter(item => !item.conflict);
  if (!matching.length && sameOrigin.some(item => item.conflict)) {
    return { error: 'Resolve this login’s conflict in Keyshoal before filling it.' };
  }
  if (request.action === 'list') {
    return { entries: matching.slice(0, 100).map(({ id, title }) => ({ id, title })) };
  }
  if (request.action === 'fill' && isId(request.id)) {
    const item = matching.find(entry => entry.id === request.id);
    if (item) return { username: item.username, password: vault.reveal(item.id) };
  }
  return { error: 'No login for this site.' };
}

export async function startBridge(runtime, callback) {
  if (process.platform !== 'linux' || !runtime || !path.isAbsolute(runtime)) return undefined;
  privateDirectory(runtime);
  const directory = privateDirectory(path.join(runtime, 'keyshoal'));
  const filename = path.join(directory, 'host.sock');
  if (Buffer.byteLength(filename) >= 108) throw new Error('The runtime directory path is too long.');
  try {
    const stat = lstatSync(filename);
    if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error('Unsafe native bridge path.');
    unlinkSync(filename); // App's per-user single-instance lock is already held.
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const server = createServer(socket => {
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('error', () => {});
    let frame = Buffer.alloc(0);
    socket.on('data', part => {
      if (frame.length + part.length > MAX_REQ + 4) return socket.destroy();
      frame = Buffer.concat([frame, part]);
      if (frame.length < 4) return;
      const length = frame.readUInt32LE();
      if (length < 2 || length > MAX_REQ || frame.length > length + 4) return socket.destroy();
      if (frame.length !== length + 4) return;
      let result;
      try { result = callback(JSON.parse(frame.subarray(4).toString('utf8'))); }
      catch { result = { error: 'Keyshoal rejected the request.' }; }
      const reply = Buffer.from(JSON.stringify(result));
      if (reply.length > MAX_RESPONSE) return socket.destroy();
      const header = Buffer.alloc(4);
      header.writeUInt32LE(reply.length);
      socket.end(Buffer.concat([header, reply]));
    });
  });
  server.maxConnections = 8;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(filename, () => {
      server.removeListener('error', reject);
      server.on('error', () => server.close());
      try { chmodSync(filename, 0o600); resolve(); }
      catch (error) { server.close(); reject(error); }
    });
  });
  return server;
}
