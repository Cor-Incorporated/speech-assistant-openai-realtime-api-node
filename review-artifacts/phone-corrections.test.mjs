import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRealtimeToolCalls} from '../lib/realtime-tool-flow.js';
function finish(reply){
 const state={callbackPhone:{valid:true,normalizedPhoneNumber:'09012345678',confirmed:false,validatedAt:'2026-09-21T00:00:01.000Z'},turns:[{role:'agent',text:'電話番号は09012345678でよろしいですか',at:'2026-09-21T00:00:02.000Z'},{role:'user',text:reply,at:'2026-09-21T00:00:03.000Z'}]};
 return handleRealtimeToolCalls({state,callEndConfig:{finalPhrase:'ありがとうございました'},handoffConfig:{enabled:false,numbers:[]},event:{type:'response.done',response:{status:'completed',output:[{type:'function_call',name:'finish_reception',call_id:'correction-check',arguments:JSON.stringify({reason:'done',callback_required:true})}]}}});
}
for(const [id,reply,expected]of [
 ['C01','いいえ、もう一度お願いします',0],
 ['C02','はい、間違いです',0],
 ['C03','違います。その番号にはかけないでください',0],
 ['C04','はい、間違いありません',1]
])test(id+' '+reply,()=>assert.equal(finish(reply).callEndRequests.length,expected));

