import { createHash, randomUUID } from 'node:crypto';
import { nativeUnitsFromDecimal, formatNativeUnits } from './native-asset.mjs';

const ADDRESS = /^uain1[a-f0-9]{40}$/;
const ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const INTENT = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_OFFERS = 5000,
  MAX_OWNER_OFFERS = 200,
  MAX_OPEN_OWNER_OFFERS = 100;
const MAX_ENQUIRIES = 10000,
  MAX_BUYER_ENQUIRIES = 500,
  MAX_OFFER_ENQUIRIES = 250;
const MAX_PAGE = 25,
  MAX_RESPONSE = 256 * 1024,
  WRITE_WINDOW = 60000,
  MAX_WRITES = 30,
  MAX_RATE_BUCKETS = 10000;
const forbiddenText =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
export class TradeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'TradeError';
    this.status = status;
    this.code = code;
  }
}
const refuse = (status, code, message) => {
  throw new TradeError(status, code, message);
};
const check = (condition, status, code, message) => {
  if (!condition) refuse(status, code, message);
};
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every(
      (key) =>
        typeof key === 'string' &&
        'value' in Object.getOwnPropertyDescriptor(value, key),
    )
  );
}
function only(value, allowed) {
  check(
    record(value) && Object.keys(value).every((key) => allowed.includes(key)),
    400,
    'invalid_body',
    'The request contains unsupported fields or is not a plain object.',
  );
}
function text(value, max, label, { min = 0, optional = false } = {}) {
  if (value === undefined && optional) return '';
  check(
    typeof value === 'string' &&
      Buffer.byteLength(value, 'utf8') <= max &&
      !forbiddenText.test(value),
    400,
    'invalid_body',
    `${label} must be valid text of at most ${max} UTF-8 bytes.`,
  );
  const normalized = value.trim();
  check(
    Buffer.byteLength(normalized, 'utf8') >= min,
    400,
    'invalid_body',
    `${label} is required.`,
  );
  return normalized;
}
function actor(user) {
  check(
    record(user) &&
      typeof user.address === 'string' &&
      ADDRESS.test(user.address) &&
      typeof user.publicKey === 'string',
    401,
    'authentication_required',
    'A signed BAINK identity is required.',
  );
  check(
    user.publicKey.length === 44 && /^[A-Za-z0-9+/]{43}=$/.test(user.publicKey),
    401,
    'invalid_identity',
    'The public key must be canonical Ed25519 base64.',
  );
  const key = Buffer.from(user.publicKey, 'base64');
  check(
    key.length === 32 &&
      key.toString('base64') === user.publicKey &&
      'uain1' + createHash('sha256').update(key).digest('hex').slice(0, 40) ===
        user.address,
    401,
    'invalid_identity',
    'The public key must match the signed identity address.',
  );
  return { address: user.address, publicKey: user.publicKey };
}
function identifier(value) {
  check(
    typeof value === 'string' && ID.test(value),
    400,
    'invalid_identifier',
    'Enter a valid trade identifier.',
  );
  return value;
}
function requestId(value) {
  check(
    typeof value === 'string' && INTENT.test(value),
    400,
    'invalid_request_id',
    'Use an intent identifier of 8–100 letters, numbers, dashes or underscores.',
  );
  return value;
}
function price(value) {
  try {
    const units = nativeUnitsFromDecimal(value);
    return { price: formatNativeUnits(units), priceUnits: units };
  } catch {
    refuse(
      400,
      'invalid_price',
      'Price must be positive exact decimal text with up to six places, within the native AI$ supply cap.',
    );
  }
}
function publish(body) {
  check(
    body.publish === true,
    400,
    'publication_required',
    'Confirm publication of this offer before creating or changing its public content.',
  );
}
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function pageNumber(value, fallback, max) {
  if (value === undefined) return fallback;
  check(
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' && /^[1-9]\d{0,5}$/.test(value)),
    400,
    'invalid_query',
    'Pagination requires positive whole numbers.',
  );
  const number = Number(value);
  check(
    number >= 1 && number <= max,
    400,
    'invalid_query',
    `Pagination is limited to ${max}.`,
  );
  return number;
}
function paging(query) {
  return {
    page: pageNumber(query.page, 1, 10000),
    pageSize: pageNumber(query.pageSize, 20, MAX_PAGE),
  };
}
function bounded(value) {
  check(
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_RESPONSE,
    503,
    'trade_response_limit',
    'This trade response exceeds its size limit.',
  );
  return value;
}
function publicOffer(value) {
  return {
    id: value.id,
    kind: 'peer-offer',
    owner: value.owner,
    title: value.title,
    description: value.description,
    category: value.category,
    price: value.price,
    priceUnits: value.priceUnits,
    currency: 'AI$',
    availability: value.availability,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    revision: value.revision,
    settlementAvailable: false,
  };
}
function publicEnquiry(value) {
  return {
    id: value.id,
    kind: 'nonbinding-enquiry',
    offerId: value.offerId,
    buyer: value.buyer,
    seller: value.seller,
    message: value.message,
    offer: {
      title: value.offerTitle,
      price: value.offerPrice,
      priceUnits: value.offerPriceUnits,
      currency: 'AI$',
      revision: value.offerRevision,
    },
    createdAt: value.createdAt,
    binding: false,
    settlementAvailable: false,
    notice: 'Interest only. No purchase, contract or payment has been made.',
  };
}
const descending = (a, b) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
function stateTrade(state, { initialize = false } = {}) {
  check(
    record(state),
    503,
    'trade_storage_invalid',
    'Trade storage is not available.',
  );
  if (state.trade === undefined) {
    if (!initialize) return { version: 1, offers: {}, enquiries: {}, rate: {} };
    state.trade = { version: 1, offers: {}, enquiries: {}, rate: {} };
  }
  const trade = state.trade;
  check(
    record(trade) &&
      trade.version === 1 &&
      record(trade.offers) &&
      record(trade.enquiries) &&
      record(trade.rate),
    503,
    'trade_storage_invalid',
    'Trade storage has an unsupported format.',
  );
  check(
    Object.keys(trade.offers).length <= MAX_OFFERS &&
      Object.keys(trade.enquiries).length <= MAX_ENQUIRIES &&
      Object.keys(trade.rate).length <= MAX_RATE_BUCKETS,
    503,
    'trade_storage_invalid',
    'Trade storage exceeds its bounds.',
  );
  return trade;
}
function offerIn(trade, id) {
  const offer = Object.hasOwn(trade.offers, id) ? trade.offers[id] : null;
  check(offer, 404, 'offer_not_found', 'This published offer was not found.');
  return offer;
}
function owns(offer, user) {
  check(
    offer.owner === user.address && offer.ownerPublicKey === user.publicKey,
    403,
    'offer_forbidden',
    'Only the publishing identity can change this offer.',
  );
}
function checkPeerBlocks(state, buyer, seller) {
  // Read the existing messaging policy without creating or changing its state.
  const peers = state.peerMessages;
  if (peers === undefined) return;
  check(
    record(peers) && peers.version === 1 && record(peers.blocks),
    503,
    'trade_storage_invalid',
    'Trade communication policy is unavailable.',
  );
  const lists = [buyer, seller].map((address) =>
    Object.hasOwn(peers.blocks, address) ? peers.blocks[address] : [],
  );
  check(
    lists.every(
      (list) =>
        Array.isArray(list) &&
        list.every(
          (address) => typeof address === 'string' && ADDRESS.test(address),
        ),
    ),
    503,
    'trade_storage_invalid',
    'Trade communication policy is unavailable.',
  );
  check(
    !lists[0].includes(seller) && !lists[1].includes(buyer),
    403,
    'peer_blocked',
    'A new enquiry is unavailable between these identities.',
  );
}
function consumeWrite(trade, user, stamp) {
  for (const [address, bucket] of Object.entries(trade.rate)) {
    check(
      ADDRESS.test(address) &&
        record(bucket) &&
        Number.isSafeInteger(bucket.startedAt) &&
        Number.isSafeInteger(bucket.count) &&
        bucket.count >= 1 &&
        bucket.count <= MAX_WRITES,
      503,
      'trade_storage_invalid',
      'Trade rate storage has an unsupported format.',
    );
    if (stamp - bucket.startedAt >= WRITE_WINDOW) delete trade.rate[address];
  }
  let bucket = trade.rate[user.address];
  if (!bucket) {
    check(
      Object.keys(trade.rate).length < MAX_RATE_BUCKETS,
      503,
      'trade_capacity',
      'Trade write capacity is temporarily full.',
    );
    bucket = { startedAt: stamp, count: 0 };
    trade.rate[user.address] = bucket;
  }
  check(
    bucket.count < MAX_WRITES,
    429,
    'trade_rate_limited',
    'Trade allows 30 new changes per identity per minute. Retry this intent later.',
  );
  bucket.count++;
}

/** Pure workflow authority. The HTTP layer verifies signatures before supplying user. */
export function createTradeService({ store, now = () => Date.now() } = {}) {
  if (
    !store ||
    typeof store.read !== 'function' ||
    typeof store.transact !== 'function' ||
    typeof now !== 'function'
  )
    throw new TypeError(
      'A durable read/transact store and a clock are required.',
    );
  const timestamp = () => {
    const stamp = now();
    if (!Number.isSafeInteger(stamp) || stamp < 0)
      throw new TypeError('Trade clock must return integer milliseconds.');
    return stamp;
  };
  return {
    // Used only by the private terms service, with its own transaction snapshot.
    // Never re-read the store here: authorization and writes must share a state.
    termsContext(state, user, enquiryId, { write = false } = {}) {
      const participant = actor(user),
        id = identifier(enquiryId);
      const trade = stateTrade(state);
      const enquiry = Object.hasOwn(trade.enquiries, id)
        ? trade.enquiries[id]
        : null;
      check(
        enquiry &&
          ((enquiry.buyer === participant.address &&
            enquiry.buyerPublicKey === participant.publicKey) ||
            (enquiry.seller === participant.address &&
              enquiry.sellerPublicKey === participant.publicKey)),
        404,
        'enquiry_not_found',
        'This private enquiry was not found.',
      );
      if (write) {
        checkPeerBlocks(state, enquiry.buyer, enquiry.seller);
        const offer = offerIn(trade, enquiry.offerId);
        check(
          offer.availability === 'open',
          409,
          'offer_withdrawn',
          'This withdrawn offer does not accept new terms. Existing records remain available.',
        );
      }
      return {
        enquiry: publicEnquiry(enquiry),
        buyerPublicKey: enquiry.buyerPublicKey,
        sellerPublicKey: enquiry.sellerPublicKey,
      };
    },
    list(query = {}) {
      only(query, [
        'q',
        'search',
        'category',
        'owner',
        'availability',
        'page',
        'pageSize',
      ]);
      const { page, pageSize } = paging(query);
      check(
        query.q === undefined ||
          query.search === undefined ||
          query.q === query.search,
        400,
        'invalid_query',
        'Use one consistent search value.',
      );
      const q = text(query.q ?? query.search, 100, 'Search', {
          optional: true,
        }).toLowerCase(),
        category = text(query.category, 80, 'Category', {
          optional: true,
        }).toLowerCase();
      const availability =
        query.availability === undefined ? 'open' : query.availability;
      check(
        ['open', 'withdrawn', 'all'].includes(availability),
        400,
        'invalid_query',
        'Choose open, withdrawn or all offer availability.',
      );
      if (query.owner !== undefined)
        check(
          typeof query.owner === 'string' && ADDRESS.test(query.owner),
          400,
          'invalid_query',
          'Owner must be a public UAIN address.',
        );
      const offers = Object.values(stateTrade(store.read()).offers)
        .filter(
          (offer) =>
            (availability === 'all' || offer.availability === availability) &&
            (!query.owner || offer.owner === query.owner) &&
            (!category || offer.category.toLowerCase() === category) &&
            (!q ||
              `${offer.title} ${offer.description} ${offer.category}`
                .toLowerCase()
                .includes(q)),
        )
        .sort(descending);
      return bounded({
        offers: offers
          .slice((page - 1) * pageSize, page * pageSize)
          .map(publicOffer),
        count: offers.length,
        page,
        pageSize,
        pages: Math.max(1, Math.ceil(offers.length / pageSize)),
      });
    },
    detail(id) {
      return bounded({
        offer: publicOffer(offerIn(stateTrade(store.read()), identifier(id))),
      });
    },
    async create(user, body) {
      const owner = actor(user);
      only(body, [
        'clientRequestId',
        'title',
        'description',
        'category',
        'price',
        'publish',
      ]);
      publish(body);
      const intent = requestId(body.clientRequestId),
        title = text(body.title, 160, 'Title', { min: 2 }),
        description = text(body.description, 4000, 'Description', { min: 1 }),
        category = text(body.category, 80, 'Category', { optional: true }),
        amount = price(body.price);
      const fingerprint = digest([title, description, category, amount.price]);
      return store.transact((state) => {
        const trade = stateTrade(state, { initialize: true });
        const prior = Object.values(trade.offers).find(
          (offer) =>
            offer.owner === owner.address && offer.clientRequestId === intent,
        );
        if (prior) {
          owns(prior, owner);
          check(
            prior.fingerprint === fingerprint,
            409,
            'idempotency_conflict',
            'This intent identifier already published different offer content.',
          );
          return bounded({ offer: publicOffer(prior) });
        }
        const all = Object.values(trade.offers),
          mine = all.filter((offer) => offer.owner === owner.address);
        check(
          all.length < MAX_OFFERS,
          503,
          'trade_capacity',
          'The offer catalogue has reached its storage limit.',
        );
        check(
          mine.length < MAX_OWNER_OFFERS &&
            mine.filter((offer) => offer.availability === 'open').length <
              MAX_OPEN_OWNER_OFFERS,
          429,
          'offer_limit',
          'This identity has reached its published-offer limit.',
        );
        const stamp = timestamp();
        consumeWrite(trade, owner, stamp);
        const at = new Date(stamp).toISOString();
        const offer = {
          id: randomUUID(),
          owner: owner.address,
          ownerPublicKey: owner.publicKey,
          clientRequestId: intent,
          fingerprint,
          title,
          description,
          category,
          ...amount,
          availability: 'open',
          revision: 1,
          createdAt: at,
          updatedAt: at,
        };
        trade.offers[offer.id] = offer;
        return bounded({ offer: publicOffer(offer) });
      });
    },
    async update(user, id, body) {
      const owner = actor(user);
      identifier(id);
      only(body, ['title', 'description', 'category', 'price', 'publish']);
      publish(body);
      check(
        ['title', 'description', 'category', 'price'].some((key) =>
          Object.hasOwn(body, key),
        ),
        400,
        'invalid_body',
        'Choose public offer content to update.',
      );
      const changes = {};
      if (Object.hasOwn(body, 'title'))
        changes.title = text(body.title, 160, 'Title', { min: 2 });
      if (Object.hasOwn(body, 'description'))
        changes.description = text(body.description, 4000, 'Description', {
          min: 1,
        });
      if (Object.hasOwn(body, 'category'))
        changes.category = text(body.category, 80, 'Category');
      if (Object.hasOwn(body, 'price'))
        Object.assign(changes, price(body.price));
      return store.transact((state) => {
        const trade = stateTrade(state, { initialize: true }),
          offer = offerIn(trade, id);
        owns(offer, owner);
        check(
          offer.availability === 'open',
          409,
          'offer_withdrawn',
          'A withdrawn offer cannot be edited or reopened.',
        );
        if (
          Object.entries(changes).every(([key, value]) => offer[key] === value)
        )
          return bounded({ offer: publicOffer(offer) });
        const stamp = timestamp();
        consumeWrite(trade, owner, stamp);
        Object.assign(offer, changes, {
          revision: offer.revision + 1,
          updatedAt: new Date(stamp).toISOString(),
        });
        return bounded({ offer: publicOffer(offer) });
      });
    },
    async withdraw(user, id) {
      const owner = actor(user);
      identifier(id);
      return store.transact((state) => {
        const trade = stateTrade(state, { initialize: true }),
          offer = offerIn(trade, id);
        owns(offer, owner);
        if (offer.availability === 'withdrawn')
          return bounded({ offer: publicOffer(offer) });
        const stamp = timestamp();
        consumeWrite(trade, owner, stamp);
        offer.availability = 'withdrawn';
        offer.revision++;
        offer.updatedAt = new Date(stamp).toISOString();
        return bounded({ offer: publicOffer(offer) });
      });
    },
    async enquire(user, id, body) {
      const buyer = actor(user);
      identifier(id);
      only(body, ['clientRequestId', 'message', 'expectedRevision']);
      const intent = requestId(body.clientRequestId),
        message = text(body.message, 2000, 'Enquiry message', { min: 1 });
      const reviewed = Object.hasOwn(body, 'expectedRevision');
      if (reviewed)
        check(
          Number.isSafeInteger(body.expectedRevision) &&
            body.expectedRevision > 0,
          400,
          'invalid_body',
          'The reviewed offer revision must be a positive safe integer. Reload and review the offer before sending.',
        );
      // Keep the original two-field digest only for exact retries of old rows.
      // New rows bind the reviewed revision without rewriting legacy fingerprints.
      const fingerprint = digest(
        reviewed ? [id, message, body.expectedRevision] : [id, message],
      );
      return store.transact((state) => {
        const trade = stateTrade(state, { initialize: true });
        const prior = Object.values(trade.enquiries).find(
          (enquiry) =>
            enquiry.buyer === buyer.address &&
            enquiry.clientRequestId === intent,
        );
        if (prior) {
          check(
            prior.buyerPublicKey === buyer.publicKey,
            403,
            'enquiry_forbidden',
            'This enquiry belongs to another identity.',
          );
          check(
            prior.fingerprint === fingerprint,
            409,
            'idempotency_conflict',
            'This intent identifier already created a different enquiry.',
          );
          return bounded({ enquiry: publicEnquiry(prior) });
        }
        check(
          reviewed,
          400,
          'offer_review_required',
          'Reload and review the current offer before sending a new enquiry.',
        );
        const offer = offerIn(trade, id);
        check(
          offer.owner !== buyer.address,
          400,
          'self_enquiry',
          'Choose an offer published by another identity.',
        );
        check(
          offer.availability === 'open',
          409,
          'offer_withdrawn',
          'This offer is withdrawn and no longer accepts new enquiries.',
        );
        check(
          offer.revision === body.expectedRevision,
          409,
          'offer_changed',
          'This offer changed. Reload and review its current details before sending a new enquiry.',
        );
        checkPeerBlocks(state, buyer.address, offer.owner);
        const all = Object.values(trade.enquiries);
        check(
          all.length < MAX_ENQUIRIES,
          503,
          'trade_capacity',
          'Enquiry storage has reached its limit.',
        );
        check(
          all.filter((enquiry) => enquiry.buyer === buyer.address).length <
            MAX_BUYER_ENQUIRIES,
          429,
          'enquiry_limit',
          'This identity has reached its enquiry limit.',
        );
        check(
          all.filter((enquiry) => enquiry.offerId === id).length <
            MAX_OFFER_ENQUIRIES,
          429,
          'offer_enquiry_limit',
          'This offer has reached its enquiry limit.',
        );
        const stamp = timestamp();
        consumeWrite(trade, buyer, stamp);
        const enquiry = {
          id: randomUUID(),
          offerId: id,
          buyer: buyer.address,
          buyerPublicKey: buyer.publicKey,
          seller: offer.owner,
          sellerPublicKey: offer.ownerPublicKey,
          clientRequestId: intent,
          fingerprint,
          expectedRevision: body.expectedRevision,
          message,
          offerTitle: offer.title,
          offerPrice: offer.price,
          offerPriceUnits: offer.priceUnits,
          offerRevision: offer.revision,
          createdAt: new Date(stamp).toISOString(),
        };
        trade.enquiries[enquiry.id] = enquiry;
        return bounded({ enquiry: publicEnquiry(enquiry) });
      });
    },
    listEnquiries(user, query = {}) {
      const participant = actor(user);
      only(query, ['offerId', 'page', 'pageSize']);
      const { page, pageSize } = paging(query);
      if (query.offerId !== undefined) identifier(query.offerId);
      const enquiries = Object.values(stateTrade(store.read()).enquiries)
        .filter(
          (enquiry) =>
            ((enquiry.buyer === participant.address &&
              enquiry.buyerPublicKey === participant.publicKey) ||
              (enquiry.seller === participant.address &&
                enquiry.sellerPublicKey === participant.publicKey)) &&
            (!query.offerId || enquiry.offerId === query.offerId),
        )
        .sort(descending);
      return bounded({
        enquiries: enquiries
          .slice((page - 1) * pageSize, page * pageSize)
          .map(publicEnquiry),
        count: enquiries.length,
        page,
        pageSize,
        pages: Math.max(1, Math.ceil(enquiries.length / pageSize)),
      });
    },
  };
}
