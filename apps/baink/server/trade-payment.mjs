import {createHash,randomUUID} from 'node:crypto';
import {createTradeTermsService} from './trade-terms.mjs';
import {nativeUnitsFromDecimal,formatNativeUnits} from './native-asset.mjs';
import {PAYMENT_REQUEST_EXPIRY_MS,addPaymentRequestHistory} from './native-payments.mjs';
const ADDRESS=/^uain1[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/;
export class TradePaymentError extends Error{constructor(status,code){super('Review the exact Trade payment-request snapshot before continuing.');this.status=status;this.code=code;}}
const check=(v,status=409,code='trade_payment_changed')=>{if(!v)throw new TradePaymentError(status,code);};
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x))&&Reflect.ownKeys(x).every(k=>typeof k==='string'&&'value'in Object.getOwnPropertyDescriptor(x,k));
const exact=(x,keys)=>plain(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
function canonical(v){if(Array.isArray(v))return'['+v.map(canonical).join(',')+']';if(plain(v))return'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';check(v===null||['string','boolean'].includes(typeof v)||typeof v==='number'&&Number.isSafeInteger(v));return JSON.stringify(v);}
export function tradeProposalDigest(proposal){const bytes=canonical(proposal);check(Buffer.byteLength(bytes)<=24576);return createHash('sha256').update(bytes).digest('hex');}
export const tradePaymentMemo=(p,d)=>`Trade: ${Array.from(p.terms.scope).slice(0,120).join('')}${Array.from(p.terms.scope).length>120?' [scope excerpt]':''}; proposal ${p.id}; snapshot SHA-256 ${d}`;
export function validateTradePaymentRequest(request){
 if(!Object.hasOwn(request,'trade'))return null;
 const tr=request.trade,deal=tr?.schema==='baink-trade-deal-payment-v1';
 // A deal payment carries the signed deal; either party may have authored the terms.
 check(deal?exact(tr,['schema','proposal','snapshotDigest','dealId','dealDigest'])&&/^[a-f0-9-]{36}$/.test(tr.dealId)&&HASH.test(tr.dealDigest):exact(tr,['schema','proposal','snapshotDigest'])&&tr.schema==='baink-trade-payment-v1');check(HASH.test(tr.snapshotDigest));
 const p=tr.proposal,e=p?.enquirySnapshot;check(plain(p)&&p.kind==='nonbinding-terms-proposal'&&p.binding===false&&p.nonbinding===true&&p.settlementAvailable===false&&p.acceptanceAvailable===false&&plain(e)&&e.kind==='nonbinding-enquiry'&&e.binding===false&&ADDRESS.test(e.seller)&&ADDRESS.test(e.buyer)&&e.seller!==e.buyer&&(p.author===e.seller||deal&&p.author===e.buyer)&&p.enquiryId===e.id&&typeof p.id==='string'&&/^[a-f0-9-]{36}$/.test(p.id)&&plain(p.terms)&&typeof p.terms.scope==='string'&&p.terms.scope.trim().length>0&&p.terms.currency==='AI$');
 check(tradeProposalDigest(p)===tr.snapshotDigest&&request.from===e.seller&&request.to===e.buyer&&request.currency==='AI$'&&request.memo===tradePaymentMemo(p,tr.snapshotDigest));
 try{check(nativeUnitsFromDecimal(request.amount)===p.terms.priceUnits&&formatNativeUnits(p.terms.priceUnits)===p.terms.price);}catch{throw new TradePaymentError(409,'trade_payment_changed');}
 return{tradeDigest:tr.snapshotDigest,...(deal?{dealId:tr.dealId,dealDigest:tr.dealDigest}:{})};
}
export function createTradePaymentService({store,trade}){
 return{async create(user,id,body){
 check(exact(body,['clientRequestId','snapshotDigest','confirmPaymentRequest'])&&typeof body.clientRequestId==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(body.clientRequestId)&&HASH.test(body.snapshotDigest)&&body.confirmPaymentRequest===true,400,'invalid_trade_payment_request');
 return store.transact(state=>{
 // Resolve and validate the sent proposal against this same serialized state.
 const terms=createTradeTermsService({store:{read:()=>state,transact:()=>{throw new Error('read only');}},context:(...args)=>trade.termsContext(...args)});
 const detail=terms.detail(user,id);check(detail.proposal,404,'trade_proposal_missing');const p=detail.proposal,e=p.enquirySnapshot;
 check(user.address===e.seller&&p.author===e.seller,403,'trade_seller_required');
 check(tradeProposalDigest(p)===body.snapshotDigest);
 const prior=Object.values(state.requests).find(r=>r.from===user.address&&r.clientRequestId===body.clientRequestId);
 if(prior){check(prior.trade?.proposal.id===id&&validateTradePaymentRequest(prior)?.tradeDigest===body.snapshotDigest,409,'trade_payment_intent_conflict');return{created:false,request:structuredClone(prior)};}
 trade.termsContext(state,user,p.enquiryId,{write:true});
 const offer=state.trade.offers[e.offerId];check(offer.revision===e.offer.revision,409,'trade_offer_changed');
 check(p.terms.expiresAt===null||Date.parse(p.terms.expiresAt)>Date.now(),409,'trade_terms_expired');
 check(Object.keys(state.requests).length<10000&&Object.values(state.requests).filter(r=>r.from===user.address).length<1000,429,'request_limit');
 // One immutable proposal cannot produce another independent payment request.
 check(!Object.values(state.requests).some(r=>r.trade?.proposal.id===id),409,'trade_proposal_already_requested');
 const now=Date.now(),at=new Date(now).toISOString();const request={id:randomUUID(),from:e.seller,to:e.buyer,amount:p.terms.price,memo:tradePaymentMemo(p,body.snapshotDigest),clientRequestId:body.clientRequestId,status:'open',createdAt:at,updatedAt:at,expiresAt:new Date(now+PAYMENT_REQUEST_EXPIRY_MS).toISOString(),currency:'AI$',settlementAvailable:false,trade:{schema:'baink-trade-payment-v1',proposal:structuredClone(p),snapshotDigest:body.snapshotDigest}};
 validateTradePaymentRequest(request);state.requests[request.id]=request;addPaymentRequestHistory(state,'request.created',request,user.address);return{created:true,request:structuredClone(request)};
 });
 }};
}
