import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createActionGateRuntime } from '../lib/action-gate-runtime.js';
import { handleRealtimeToolCalls } from '../lib/realtime-tool-flow.js';
import { KnowledgeReader } from '../dist-backend/knowledge/knowledge-reader.js';
import { maskSensitiveText } from '../dist-backend/routing/jev-classifier.js';

test('REVIEW-R03: production ActionGate bridge must evaluate an allowed transfer without throwing', async()=>{
 const gate=createActionGateRuntime({env:{CALL_GATE_REQUIRED:'true'}});
 const result=await gate.evaluate({actionId:'review-handoff',kind:'handoff_start',target:'contract',targetRevision:1,
 facts:{allowedKinds:['handoff_start'],allowedTargets:['contract'],policyAllows:true,confirmationSatisfied:true,currentRevision:1,lifecyclePhase:'active'}});
 assert.equal(result.allow,true);
});

test('REVIEW-R04: a known revoked item must stay revoked during a settings-read failure',async()=>{
 let revoked=[],down=false;
 const repo={
  async getRuntimeSettings(){if(down)throw Error('simulated outage'); return {currentReleaseId:'r1',revocationEpoch:revoked.length,revokedKnowledgeIds:revoked,updatedAt:''};},
  async getRelease(){return {releaseId:'r1',manifestHash:'test'};},
  async getReleaseItems(){return [{knowledgeId:'k1',key:'company.hours',revision:1,title:'営業時間',category:'hours',keywords:['営業時間'],answerJa:'撤回対象の古い営業時間です',value:{},sourceIds:['official'],asOf:null,requiresHumanReview:false,expiresAt:null}];}
 };
 const reader=new KnowledgeReader(repo);
 assert.equal((await reader.lookup('営業時間')).status,'found');
 revoked=['k1'];
 assert.equal((await reader.lookup('営業時間')).status,'unknown');
 down=true;
 const result=await reader.lookup('営業時間');
 assert.notEqual(result.status,'found','REPRODUCED: previously revoked answer returned after settings outage');
});

test('REVIEW-R05: validating a callback format must not authorize finish before caller confirmation',()=>{
 const state={turns:[{role:'user',text:'折り返しをお願いします'}]};
 const result=handleRealtimeToolCalls({state,callEndConfig:{finalPhrase:'ありがとうございました'},handoffConfig:{enabled:false,numbers:[]},event:{type:'response.done',response:{status:'completed',output:[
 {type:'function_call',name:'validate_callback_phone',call_id:'p',arguments:JSON.stringify({heard_phone_number:'09012345678'})},
 {type:'function_call',name:'finish_reception',call_id:'f',arguments:JSON.stringify({reason:'done',callback_required:true})}
 ]}}});
 assert.equal(result.callEndRequests.length,0,'REPRODUCED: phone validation and finish accepted in SAME model response, no caller confirmation');
});

test('REVIEW-R06: fullwidth contact data must be masked before external Jev submission',()=>{
 const synthetic='連絡先は０９０－００００－００００です';
 assert.ok(!maskSensitiveText(synthetic).includes('０９０'),'REPRODUCED: fullwidth phone survives maskSensitiveText unchanged');
});
