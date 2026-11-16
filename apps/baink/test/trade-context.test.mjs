import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createTradeService } from '../server/trade.mjs';
const member = () => {
  const key = generateKeyPairSync('ed25519')
    .publicKey.export({ format: 'der', type: 'spki' })
    .subarray(-32);
  return {
    address:
      'uain1' + createHash('sha256').update(key).digest('hex').slice(0, 40),
    publicKey: key.toString('base64'),
  };
};
test('transaction-bound enquiry context protects identity, historical reads and new writes', async () => {
  let state = {};
  const store = {
    read: () => structuredClone(state),
    transact: async (fn) => {
      const next = structuredClone(state);
      const out = await fn(next);
      state = next;
      return out;
    },
  };
  const service = createTradeService({ store }),
    seller = member(),
    buyer = member(),
    other = member();
  const { offer } = await service.create(seller, {
    clientRequestId: 'context-offer-01',
    title: 'Synthetic review',
    description: 'Review a synthetic dataset.',
    price: '0.000001',
    publish: true,
  });
  const { enquiry } = await service.enquire(buyer, offer.id, {
    clientRequestId: 'context-enquiry-01',
    message: 'One test package.',
    expectedRevision: offer.revision,
  });
  const before = JSON.stringify(state);
  const context = service.termsContext(state, buyer, enquiry.id, {
    write: true,
  });
  assert.equal(context.enquiry.id, enquiry.id);
  assert.equal(context.buyerPublicKey, buyer.publicKey);
  assert.equal(context.sellerPublicKey, seller.publicKey);
  assert.equal(JSON.stringify(state), before);
  assert.throws(
    () => service.termsContext(state, other, enquiry.id),
    (e) => e.status === 404,
  );
  assert.throws(
    () =>
      service.termsContext(
        state,
        { ...buyer, publicKey: other.publicKey },
        enquiry.id,
      ),
    (e) => e.status === 401,
  );
  state.peerMessages = {
    version: 1,
    blocks: { [seller.address]: [buyer.address] },
  };
  assert.throws(
    () => service.termsContext(state, buyer, enquiry.id, { write: true }),
    (e) => e.code === 'peer_blocked',
  );
  assert.equal(
    service.termsContext(state, buyer, enquiry.id).enquiry.id,
    enquiry.id,
  );
  delete state.peerMessages;
  await service.withdraw(seller, offer.id);
  assert.throws(
    () => service.termsContext(state, buyer, enquiry.id, { write: true }),
    (e) => e.code === 'offer_withdrawn',
  );
  assert.equal(
    service.termsContext(state, seller, enquiry.id).enquiry.id,
    enquiry.id,
  );
});
