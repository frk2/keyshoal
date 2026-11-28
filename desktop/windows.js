import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

const MAX_REQUEST = 4096;
const MAX_RESPONSE = 512 * 1024;

export function windowsDataDirectory(nativeHost) {
  const configured = process.env.KEYSHOAL_DATA_DIR ?? path.join(process.env.LOCALAPPDATA ?? '', 'Keyshoal');
  if (!/^[a-z]:[\\/]/i.test(configured) || path.normalize(configured) === path.parse(configured).root) {
    throw new Error('Keyshoal requires a local Windows data directory.');
  }
  const dir = path.normalize(configured);
  execFileSync(nativeHost, ['--private-directory', dir], { windowsHide: true, stdio: 'ignore', timeout: 8000 });
  return dir;
}

export async function startWindowsBridge(nativeHost, answer) {
  const child = spawn(nativeHost, ['--broker', String(process.pid)], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
  });
  let ready = false;
  let pending = Buffer.alloc(0);
  child.stdin.on('error', () => child.kill());
  child.stdout.on('error', () => child.kill());

  await new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('The Windows Chrome bridge timed out.')); }, 3500);
    child.on('error', () => finish(new Error('Could not launch the Windows Chrome bridge.')));
    child.once('exit', () => {
      if (!ready) finish(new Error('Could not start the private Windows Chrome pipe.'));
    });
    child.stdout.on('data', chunk => {
      if (!ready) {
        if (!chunk.length || chunk[0] !== 0x52) return child.kill();
        ready = true;
        chunk = chunk.subarray(1);
        finish();
      }
      if (pending.length + chunk.length > MAX_REQUEST + 4) return child.kill();
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 4) return;
      const length = pending.readUInt32LE();
      if (length < 2 || length > MAX_REQUEST || pending.length > length + 4) return child.kill();
      if (pending.length !== length + 4) return;
      let result;
      try { result = answer(JSON.parse(pending.subarray(4).toString('utf8'))); }
      catch { result = { error: 'Keyshoal rejected the request.' }; }
      pending = Buffer.alloc(0);
      const reply = Buffer.from(JSON.stringify(result));
      if (reply.length > MAX_RESPONSE) return child.kill();
      const header = Buffer.alloc(4);
      header.writeUInt32LE(reply.length);
      child.stdin.write(Buffer.concat([header, reply]));
    });
  });
  return {
    close: () => child.kill(),
    onClose: callback => child.once('exit', callback)
  };
}
