import test from'node:test';import assert from'node:assert/strict';
import{switchMessageRecipient,reviewConversationMessage,acknowledgeMessageDraft,messageSelectionUnchanged}from'./message-draft.js';
const owner='uain1'+'1'.repeat(40),a='uain1'+'a'.repeat(40),b='uain1'+'b'.repeat(40),context={enquiryId:'enquiry-A',offerId:'offer-A',title:'Private enquiry A'};
const draft=()=>({owner,to:a,body:'Confidential enquiry reply intended only for A.',context});
const thread=(to,id='conversation-A')=>({conversation:{id,counterparty:to,participants:[owner,to],messagingAvailable:true}});
test('switching to another peer clears enquiry text and restores it only for the original recipient',()=>{
 const original=draft(),other=switchMessageRecipient(original,b);assert.equal(other.to,b);assert.equal(other.body,'');assert.equal(other.context,null);assert.equal(original.body,draft().body);
 const restored=switchMessageRecipient(other,a);assert.equal(restored.body,original.body);assert.deepEqual(restored.context,context);assert.equal(switchMessageRecipient(restored,a),restored);
});
test('editing a recipient cannot carry another recipients text through partial or final addresses',()=>{
 let value=switchMessageRecipient(draft(),'uain1');assert.equal(value.body,'');assert.equal(value.context,null);value=switchMessageRecipient(value,b);assert.equal(value.body,'');assert.equal(switchMessageRecipient(value,a).body,draft().body);
});
test('submission is bound to the reviewed thread, owner and draft recipient, including enquiry switches',()=>{
 const reviewed=reviewConversationMessage(draft(),thread(a),'conversation-A',owner);assert.equal(reviewed.to,a);assert.equal(reviewed.body,draft().body);
 assert.throws(()=>reviewConversationMessage(draft(),thread(b,'conversation-B'),'conversation-B',owner),/recipient|conversation/);
 assert.throws(()=>reviewConversationMessage(draft(),thread(a),'conversation-B',owner));assert.throws(()=>reviewConversationMessage({...draft(),owner:b},thread(a),'conversation-A',owner));assert.throws(()=>reviewConversationMessage({...draft(),body:' '},thread(a),'conversation-A',owner));
});
test('an older acknowledgement never clears newer text or another recipients reply',()=>{
 const reviewed=reviewConversationMessage(draft(),thread(a),'conversation-A',owner),other={...switchMessageRecipient(draft(),b),body:'New private reply for B'};
 const result=acknowledgeMessageDraft(other,reviewed);assert.equal(result.body,other.body);assert.equal(result.to,b);assert.equal(switchMessageRecipient(result,a).body,'','Acknowledged A text must not reappear');
 assert.equal(acknowledgeMessageDraft({...draft(),body:'A newer unsent edit'},reviewed).body,'A newer unsent edit');assert.equal(acknowledgeMessageDraft({...draft(),owner:b},reviewed).body,draft().body);
 const sent=acknowledgeMessageDraft(draft(),reviewed);assert.equal(sent.body,'');assert.equal(sent.context,null);
});
test('late thread responses are discarded after a recipient or enquiry switch but preserve edits to the same draft',()=>{
 const original=draft();assert.equal(messageSelectionUnchanged(original,{...original,body:'Edited while loading'}),true);assert.equal(messageSelectionUnchanged(original,{...original,to:b}),false);assert.equal(messageSelectionUnchanged(original,{...original,context:{...context,enquiryId:'new-enquiry'}}),false);
});
