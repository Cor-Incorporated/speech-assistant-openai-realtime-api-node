import {Firestore} from '@google-cloud/firestore';
import {InMemoryCallRepository} from '../dist-backend/calls/call-repository.js';
const db=new Firestore({projectId:'local-review-no-network'});
for(const method of ['createIfAbsent','put']){
 const original=InMemoryCallRepository.prototype[method];
 InMemoryCallRepository.prototype[method]=async function(record,...args){
  if(process.env.RECHECK_VALIDATE_FIRESTORE==='true')db.batch().set(db.doc('review/synthetic'),record); // Never commit.
  return original.call(this,record,...args);
 };
}
globalThis.fetch=async(url,opts)=>{
 if(String(url)==='https://api.openai.com/v1/responses')return new Response(JSON.stringify({output_text:JSON.stringify({summary:'合成通話の要約',intent:'general_inquiry',callbackRequired:false,customerName:'テスト',customerPhoneNumber:'',preferredDatetime:''})}),{status:200});
 if(String(url)==='https://api.resend.com/emails'){
  console.log('RECHECK_RESEND_ATTEMPT_BLOCKED',JSON.stringify({subject:JSON.parse(opts.body).subject}));
  return new Response(JSON.stringify({id:'synthetic-blocked-no-real-email'}),{status:200});
 }
 throw Error('Unexpected network request blocked by recheck fixture');
};
