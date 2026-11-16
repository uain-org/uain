import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createBainkServer, canonical } from '../../server/app.mjs';
process.send({ kind: 'ready' });
process.once('message', async () => {
  try {
    const app = await createBainkServer({ dataDir: process.argv[2], projectsSource: null, catalogueDir: null });
    process.send({ kind: 'opened' });
    process.on('message', async command => {
      if (command === 'register') {
        await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
        const { publicKey, privateKey } = generateKeyPairSync('ed25519');
        const body = { displayName: 'Durable crash account' };
        const nonce = randomUUID(), timestamp = String(Date.now());
        const message = { audience: 'http://127.0.0.1:8798', method: 'POST', path: '/api/account', body, nonce, timestamp };
        const result = await fetch(`http://127.0.0.1:${app.server.address().port}/api/account`, {
          method: 'POST', body: JSON.stringify(body), headers: {
            'Content-Type': 'application/json',
            'X-BAINK-Public-Key': publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
            'X-BAINK-Nonce': nonce, 'X-BAINK-Timestamp': timestamp,
            'X-BAINK-Signature': sign(null, Buffer.from(canonical(message)), privateKey).toString('base64'),
          },
        });
        process.send({ kind: 'registered', status: result.status, body: await result.json() });
        return;
      }
      await app.close();
      process.send({ kind: 'closed' });
      process.disconnect();
    });
  } catch (error) {
    process.send({ kind: 'rejected', message: error.message });
    process.disconnect();
  }
});
