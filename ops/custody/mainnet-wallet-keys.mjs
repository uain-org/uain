// Internal child process of mainnet_wallets.py. Generate mode returns secrets
// through a captured server-local pipe; never invoke it in a terminal or log it.
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

try {
  const require = createRequire(resolve(process.argv[2], 'contracts/package.json'));
  const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
  const { recoverMessageAddress } = require('viem');
  const { base58Encode } = await import(resolve(process.argv[2], 'contracts/dist/solana.js'));
  const edKey = seed => createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der', type: 'pkcs8',
  });
  let keys;
  if (process.argv[3] === 'generate') {
    const seed = randomBytes(32);
    const pub = createPublicKey(edKey(seed)).export({ format: 'der', type: 'spki' }).subarray(-32);
    keys = { owner: generatePrivateKey(), anchorer: generatePrivateKey(), solana: [...seed, ...pub] };
  } else if (process.argv[3] === 'verify') {
    keys = JSON.parse(readFileSync(0, 'utf8'));
  } else throw new Error();
  const challenge = `UAIN mainnet custody verification ${randomBytes(32).toString('hex')}`;
  const addresses = {};
  for (const role of ['owner', 'anchorer']) {
    const account = privateKeyToAccount(keys[role]);
    const signature = await account.signMessage({ message: challenge });
    if (await recoverMessageAddress({ message: challenge, signature }) !== account.address) throw new Error();
    addresses[role] = account.address;
  }
  if (addresses.owner === addresses.anchorer) throw new Error();
  if (!Array.isArray(keys.solana) || keys.solana.length !== 64 ||
      !keys.solana.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error();
  const solKey = edKey(Buffer.from(keys.solana.slice(0, 32)));
  const solPub = createPublicKey(solKey);
  const solBytes = solPub.export({ format: 'der', type: 'spki' }).subarray(-32);
  if (!solBytes.equals(Buffer.from(keys.solana.slice(32)))) throw new Error();
  const message = Buffer.from(challenge);
  if (!verify(null, message, solPub, sign(null, message, solKey))) throw new Error();
  addresses.solana = base58Encode(solBytes);
  process.stdout.write(JSON.stringify(process.argv[3] === 'generate' ? { keys, addresses } : addresses));
} catch {
  // Never emit library exceptions or key material on failure.
  process.stderr.write('Mainnet wallet key generation/verification failed\n');
  process.exitCode = 1;
}
