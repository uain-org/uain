import {canonical} from './identity.js';
const ADDRESS=/^uain1[a-f0-9]{40}$/;
const sameText=(a,b)=>a?.to===b?.to&&a?.body===b?.body&&canonical(a?.context??null)===canonical(b?.context??null);
/** Drafts stay in the parent React state, partitioned by recipient. No draft is
 * sent, persisted, or copied to a different peer when a thread is selected. */
export function switchMessageRecipient(current,to){
 if(typeof to!=='string'||to.length>45)throw Error('Choose a valid recipient address.');
 if(current.to===to)return current;const remembered={...current.recipientDrafts};
 if(ADDRESS.test(current.to)){
  if(current.body||current.context)remembered[current.to]={to:current.to,body:current.body||'',context:structuredClone(current.context??null)};
  else delete remembered[current.to];
 }
 const restored=ADDRESS.test(to)?remembered[to]:null;
 return{...current,to,body:restored?.body??'',context:structuredClone(restored?.context??null),recipientDrafts:remembered};
}
export function messageSelectionUnchanged(before,current){
 return before?.owner===current?.owner&&before?.to===current?.to&&canonical(before?.context??null)===canonical(current?.context??null);
}
export function conversationRecipient(thread,conversation,owner){
 const row=thread?.conversation,to=row?.counterparty;
 if(!ADDRESS.test(owner)||!ADDRESS.test(to)||to===owner||!conversation||row.id!==conversation||!Array.isArray(row.participants)||row.participants.length!==2||!row.participants.includes(owner)||!row.participants.includes(to))throw Error('Open the conversation for this draft recipient before sending.');
 return to;
}
export function reviewConversationMessage(draft,thread,conversation,owner){
 const to=conversationRecipient(thread,conversation,owner);
 if(draft.to!==to||(draft.owner&&draft.owner!==owner)||thread.conversation.messagingAvailable===false)throw Error('Open the conversation for this draft recipient before sending.');
 if(typeof draft.body!=='string'||!draft.body.trim()||draft.body.length>2000)throw Error('Write a message for this recipient before sending.');
 return Object.freeze({owner,to,conversation,body:draft.body,context:structuredClone(draft.context??null)});
}
export function acknowledgeMessageDraft(current,reviewed){
 if(current.owner&&current.owner!==reviewed.owner)return current;
 const remembered={...current.recipientDrafts},saved=remembered[reviewed.to];if(saved&&sameText(saved,reviewed))delete remembered[reviewed.to];
 return{...current,...(sameText(current,reviewed)?{body:'',context:null}:{}),recipientDrafts:remembered};
}
