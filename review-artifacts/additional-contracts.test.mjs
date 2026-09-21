import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRealtimeToolCalls} from '../lib/realtime-tool-flow.js';
import {projectProviderCall} from '../dist-backend/calls/call-projector.js';
import {InMemoryCallRepository} from '../dist-backend/calls/call-repository.js';
const phone={valid:true,normalizedPhoneNumber:'09012345678',confirmed:false,validatedAt:'2026-09-21T00:00:01.000Z'};
const turn=(role,text,n)=>({role,text,at:'2026-09-21T00:00:'+String(n).padStart(2,'0')+'.000Z'});
function finish(turns){return handleRealtimeToolCalls({state:{callbackPhone:{...phone},turns},callEndConfig:{finalPhrase:'ありがとうございました'},handoffConfig:{enabled:false,numbers:[]},event:{type:'response.done',response:{status:'completed',output:[{type:'function_call',name:'finish_reception',call_id:'new-case',arguments:JSON.stringify({reason:'done',callback_required:true})}]}}});}
test('B01 denial invalidates the old readback window before unrelated yes',()=>{
 const turns=[turn('agent','09012345678でよろしいですか',2),turn('user','違います。その番号にはかけないでください',3),turn('agent','担当者への伝言を承りますか',4),turn('user','はい、お願いします',5)];
 assert.equal(finish(turns).callEndRequests.length,0,'Denied number was re-confirmed by unrelated yes');
});
test('B02 an intervening question cannot reuse a previous unconfirmed readback',()=>{
 const turns=[turn('agent','09012345678でよろしいですか',2),turn('user','その前に営業時間を知りたいです',3),turn('agent','営業時間も確認して折り返しましょうか',4),turn('user','はい',5)];
 assert.equal(finish(turns).callEndRequests.length,0,'Yes to opening-hours callback confirmed the phone instead');
});
const base={callId:'CA_ADDITIONAL_SYNTHETIC',transportState:'connected',startedAt:'2026-09-21T00:00:00.000Z',endedAt:null,durationSeconds:null,fromNumberMasked:null,toNumberMasked:null,callbackRequired:false,outcome:'abandoned'};
const end={...base,transportState:'ended',endedAt:'2026-09-21T00:01:00.000Z',outcome:'completed',extraction:{summary:'合成通話の要約',callerName:'テスト',intent:'general_inquiry'}};
test('B03 late start preserves already projected effective fields',async()=>{
 const repo=new InMemoryCallRepository();
 await projectProviderCall(repo,null,end);
 const {record}=await projectProviderCall(repo,null,base);
 assert.equal(record.transportState,'ended');
 assert.equal(record.extraction.summary,end.extraction.summary);
 assert.equal(record.effective.summary,end.extraction.summary,'Late start erased the completed summary');
});
test('B04 editing one field during the call still initializes untouched fields on close',async()=>{
 const repo=new InMemoryCallRepository();
 const {record:initial}=await projectProviderCall(repo,null,base);
 initial.effective.memo='担当者の手入力メモ';await repo.put(initial);
 const {record}=await projectProviderCall(repo,null,end);
 assert.equal(record.effective.memo,'担当者の手入力メモ');
 assert.equal(record.effective.summary,end.extraction.summary,'Editing memo blocked summary initialization');
});

