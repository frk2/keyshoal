import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { createHash, randomBytes, timingSafeEqual, webcrypto, X509Certificate } from 'node:crypto';
import { createServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { isKey, MAX_VAULT } from '@keyshoal/vault';
import { encodeInvite, INVITE_MS, isPrivateIPv4, PORT } from '@keyshoal/vault/protocol';
import { readPrivate, writePrivate } from './files.js';

const WEEK = 7 * 24 * 60 * 60 * 1000;
const TOKEN = /^(Invite|Device) ([a-f0-9]{64})$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const secret = () => randomBytes(32).toString('hex');
const options = { minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' };
const sameSecret = (a, b) => isKey(a) && isKey(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

export const addresses = () => [...new Set(Object.values(networkInterfaces()).flat().filter(
  info => !info.internal && info.family === 'IPv4' && isPrivateIPv4(info.address)
).map(info => info.address))].sort();

async function identity(dir, ip) {
  const file = path.join(dir, 'tls-identity.json');
  const saved = readPrivate(file, 16_384);
  if (saved) {
    const old = JSON.parse(saved);
    const cert = new X509Certificate(old.cert);
    if (old.ip === ip && Date.parse(cert.validTo) - Date.now() > WEEK) {
      return { cert: old.cert, key: old.key, fingerprint: hash(cert.raw) };
    }
  }
  const algo = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const pair = await webcrypto.subtle.generateKey(algo, true, ['sign', 'verify']);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01' + randomBytes(16).toString('hex'),
    name: 'CN=Keyshoal LAN sync',
    notBefore: new Date(Date.now() - 12 * 60 * 60 * 1000),
    notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    signingAlgorithm: algo,
    keys: pair,
    extensions: [
      new x509.SubjectAlternativeNameExtension([{ type: 'ip', value: ip }]),
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth])
    ]
  }, webcrypto);
  const cert = certificate.toString('pem');
  const key = x509.PemConverter.encode(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey), 'PRIVATE KEY');
  writePrivate(file, JSON.stringify({ ip, cert, key }));
  return { cert, key, fingerprint: hash(Buffer.from(certificate.rawData)) };
}

function respond(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream', ...headers });
  res.end(body);
}

async function readBody(req) {
  if (!/^\d{1,7}$/.test(req.headers['content-length'] ?? '')) throw new Error('Missing content length.');
  const size = Number(req.headers['content-length']);
  if (size < 1 || size > MAX_VAULT || req.headers['content-type'] !== 'application/octet-stream') {
    throw new Error('Invalid body.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > size) throw new Error('Invalid body length.');
    chunks.push(chunk);
  }
  if (size !== length) throw new Error('Invalid body length.');
  return Buffer.concat(chunks, length);
}

export class LanHub {
  #dir;
  #getVault;
  #commit;
  #server;
  #sockets = new Set();
  #listeners = new Set();
  #generation = 0;
  #identity;
  #ip;
  #invite;
  #peers;
  #port;
  constructor(dir, getVault, commit, port = PORT) {
    this.#dir = dir;
    this.#getVault = getVault;
    this.#commit = commit;
    this.#port = port;
    this.#peers = JSON.parse(readPrivate(this.#peerFile(), 64_000) ?? '[]');
  }

  #peerFile() { return path.join(this.#dir, 'paired-devices.json'); }
  #setPeers(peers) {
    writePrivate(this.#peerFile(), JSON.stringify(peers));
    this.#peers = peers;
  }
  onPeer(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  status() {
    return { ip: this.#ip ?? null, addresses: addresses(), peers: this.#peers.map(({ id, added }) => ({ id, added })) };
  }
  revoke(id) {
    this.#setPeers(this.#peers.filter(peer => peer.id !== id));
  }

  async start(ip) {
    if (!addresses().includes(ip)) throw new Error('Choose an active private IPv4 address from this computer.');
    if (!this.#getVault()) throw new Error('Unlock your vault first.');
    if (this.#server && this.#ip === ip) return this.status();
    this.stop();
    const generation = this.#generation;
    const credentials = await identity(this.#dir, ip);
    if (generation !== this.#generation || !this.#getVault()) throw new Error('LAN sync start cancelled.');
    const server = createServer({
      ...options, key: credentials.key, cert: credentials.cert,
      maxHeaderSize: 4096, headersTimeout: 5000, requestTimeout: 12_000, keepAliveTimeout: 1000
    }, (req, res) => {
      this.#handle(req, res, generation).catch(() => {
        if (!res.headersSent && !res.destroyed) respond(res, 400);
      });
    });
    server.maxConnections = 16;
    server.timeout = 12_000;
    server.on('connection', socket => {
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
    });
    this.#server = server;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.#port, ip, () => {
          server.removeListener('error', reject);
          server.on('error', () => { if (this.#server === server) this.stop(); });
          resolve();
        });
        server.once('close', () => reject(new Error('LAN sync start cancelled.')));
      });
    } catch (error) {
      if (this.#server === server) this.stop();
      throw error;
    }
    if (generation !== this.#generation) throw new Error('LAN sync start cancelled.');
    this.#identity = credentials.fingerprint;
    this.#ip = ip;
    return this.status();
  }

  stop() {
    this.#generation++;
    this.#invite = undefined;
    this.#ip = undefined;
    this.#identity = undefined;
    this.#server?.close();
    this.#server = undefined;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
  }

  invite(key) {
    if (!this.#ip || !this.#getVault()) throw new Error('Start LAN sync first.');
    if (this.#peers.length >= 32) throw new Error('Revoke a device before pairing another.');
    const token = secret();
    const expires = Date.now() + INVITE_MS;
    this.#invite = { token, expires };
    return { expires, qr: encodeInvite({ ip: this.#ip, fingerprint: this.#identity, invite: token, key }) };
  }

  cancelInvite() { this.#invite = undefined; }

  async #handle(req, res, generation) {
    const vault = this.#getVault();
    if (!vault || generation !== this.#generation) return respond(res, 503);
    if (!['/v1/vault', '/v1/enrol'].includes(req.url)) return respond(res, 404);
    const authorization = TOKEN.exec(req.headers.authorization ?? '');
    if (!authorization) return respond(res, 401);
    const [, kind, token] = authorization;
    if (kind === 'Invite') {
      if (!sameSecret(token, this.#invite?.token) || Date.now() >= this.#invite.expires) return respond(res, 401);
      if (req.method === 'GET' && req.url === '/v1/vault') return respond(res, 200, vault.bytes());
      if (req.method !== 'POST' || req.url !== '/v1/enrol') return respond(res, 405);
      if (!sameSecret(req.headers['x-keyshoal-proof'], vault.enrolProof(token))) return respond(res, 401);
      const device = secret();
      const peer = { id: randomBytes(16).toString('hex'), added: Date.now(), tokenHash: hash(device) };
      this.#setPeers([...this.#peers, peer]);
      this.#invite = undefined;
      for (const listener of this.#listeners) listener();
      return respond(res, 201, undefined, { 'X-Keyshoal-Device': device });
    }

    const tokenHash = hash(token);
    const peer = this.#peers.find(item => sameSecret(tokenHash, item.tokenHash));
    if (!peer) return respond(res, 401);
    if (req.url !== '/v1/vault') return respond(res, 404);
    if (req.method === 'GET') return respond(res, 200, vault.bytes());
    if (req.method !== 'PUT') return respond(res, 405);
    const match = req.headers['if-match'];
    if (typeof match !== 'string' || !/^"[a-f0-9]{64}"$/.test(match)) return respond(res, 428);
    const bytes = await readBody(req);
    if (generation !== this.#generation || vault !== this.#getVault() || !this.#peers.includes(peer)) {
      return respond(res, 401);
    }
    if (match !== '"' + vault.revision() + '"') return respond(res, 412);
    try { vault.validate(bytes); } catch { return respond(res, 422); }
    this.#commit(bytes);
    return respond(res, 204);
  }
}
