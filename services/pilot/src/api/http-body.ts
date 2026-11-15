import type { IncomingMessage } from 'node:http';

export function readJsonBody(req: IncomingMessage, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    };
    req.on('data', (c) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += chunk.length;
      if (size > max) {
        fail(new Error('body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON'));
      } finally {
        chunks.length = 0;
      }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('request aborted')));
    req.on('close', () => {
      if (!settled) fail(new Error('request aborted'));
    });
  });
}
