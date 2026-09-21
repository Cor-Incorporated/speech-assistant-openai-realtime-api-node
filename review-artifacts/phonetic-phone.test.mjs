import test from 'node:test';
import assert from 'node:assert/strict';
import {validateJapaneseCallbackPhoneNumber} from '../lib/phone-number-validation.js';
test('J01 numeric spelling of the synthetic callback number is accepted',()=>{
 const r=validateJapaneseCallbackPhoneNumber('090-0000-1234');assert.equal(r.valid,true);assert.equal(r.normalizedPhoneNumber,'09000001234');
});
test('J02 exact phonetic value emitted by real Live preserves all eleven digits',()=>{
 const r=validateJapaneseCallbackPhoneNumber('ゼロキューゼロ、ゼロゼロゼロゼロ、イチニサンヨン');
 console.log(JSON.stringify({case:'J02',valid:r.valid,reason:r.reason}));assert.equal(r.valid,true);assert.equal(r.normalizedPhoneNumber,'09000001234');
});
