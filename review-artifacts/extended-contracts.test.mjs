import test from 'node:test';
import assert from 'node:assert/strict';
import {Firestore} from '@google-cloud/firestore';
import {handleRealtimeToolCalls} from '../lib/realtime-tool-flow.js';
import {projectProviderCall} from '../dist-backend/calls/call-projector.js';
import {InMemoryCallRepository} from '../dist-backend/calls/call-repository.js';
import {InMemoryEscalationRepository} from '../dist-backend/escalations/escalation-service.js';
const firestore=new Firestore({projectId:'local-review-no-network'});

const basePhone={valid:true,normalizedPhoneNumber:'09012345678',confirmed:false,validatedAt:'2026-09-21T00:00:01.000Z'};
const agent=text=>({role:'agent',text,at:'2026-09-21T00:00:02.000Z'});
const user=text=>({role:'user',text,at:'2026-09-21T00:00:03.000Z'});
function finish(state){return handleRealtimeToolCalls({state,callEndConfig:{finalPhrase:'ありがとうございました'},handoffConfig:{enabled:false,numbers:[]},event:{type:'response.done',response:{status:'completed',output:[{type:'function_call',name:'finish_reception',call_id:'f',arguments:JSON.stringify({reason:'done',callback_required:true})}]}}});}

test('N01 unrelated assistant question and yes must not confirm a callback number',()=>{
 const state={callbackPhone:{...basePhone},turns:[agent('お問い合わせは見積についてですか'),user('はい、お願いします')]};
 assert.equal(finish(state).callEndRequests.length,0,'Unrelated yes authorized the phone and end call');
});
test('N02 an explicit correct-number affirmation must be accepted',()=>{
 const state={callbackPhone:{...basePhone},turns:[agent('電話番号は09012345678でよろしいですか'),user('間違いありません')]};
 assert.equal(finish(state).callEndRequests.length,1,'The affirmative 間違いありません was treated as a negation');
});
test('N03 later correction must invalidate an already confirmed number',()=>{
 const state={callbackPhone:{...basePhone,confirmed:true,confirmedAt:'2026-09-21T00:00:02.000Z'},turns:[user('違います。その番号にはかけないでください')]};
 assert.equal(finish(state).callEndRequests.length,0,'Confirmed state ignored a subsequent explicit correction');
});

const base={callId:'CA_RECHECK_SYNTHETIC',transportState:'connected',startedAt:'2026-09-21T00:00:00.000Z',endedAt:null,durationSeconds:null,fromNumberMasked:null,toNumberMasked:null,callbackRequired:false,outcome:'abandoned'};
test('N04 start then completion must populate unedited effective fields',async()=>{
 const repo=new InMemoryCallRepository();
 await projectProviderCall(repo,null,base);
 const {record}=await projectProviderCall(repo,null,{...base,transportState:'ended',outcome:'completed',endedAt:'2026-09-21T00:01:00.000Z',extraction:{summary:'合成問い合わせ',intent:'general_inquiry',callerName:'テスト'}});
 assert.equal(record.effective.summary,'合成問い合わせ','Real start-time projection permanently froze effective.summary to null');
});
test('N05 later escalation must raise needsReview on the existing start record',async()=>{
 const repo=new InMemoryCallRepository(),escRepo=new InMemoryEscalationRepository();
 await projectProviderCall(repo,escRepo,base);
 const {record,escalation}=await projectProviderCall(repo,escRepo,{...base,transportState:'ended',severity:{importance:'high'},handoff:{requested:true,destination:'general',outcome:'failed'}});
 assert.ok(escalation);
 assert.equal(record.ops.needsReview,true,'Start-time false suppressed later review requirement');
});
test('N06 projection must produce data accepted by the actual Firestore serializer',async()=>{
 const repo=new InMemoryCallRepository();
 const {record}=await projectProviderCall(repo,null,{...base,transportState:'ended',outcome:'completed',extraction:{summary:'合成問い合わせ',model:undefined,extractedAt:'2026-09-21T00:01:00.000Z'}});
 assert.doesNotThrow(()=>firestore.batch().set(firestore.doc('review/synthetic'),record));
});
test('N07 late start must not roll back an already ended call',async()=>{
 const repo=new InMemoryCallRepository();
 await projectProviderCall(repo,null,{...base,transportState:'ended',outcome:'completed',endedAt:'2026-09-21T00:01:00.000Z'});
 const {record}=await projectProviderCall(repo,null,base);
 assert.equal(record.transportState,'ended','An out-of-order start overwrote ended with connected');
});
