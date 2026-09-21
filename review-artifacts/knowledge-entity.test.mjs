import test from 'node:test';
import assert from 'node:assert/strict';
import './preload-snapshot.mjs';
import {KnowledgeReader} from '../dist-backend/knowledge/knowledge-reader.js';
import {InMemoryKnowledgeRepository} from '../dist-backend/knowledge/repository.js';
const reader=new KnowledgeReader(new InMemoryKnowledgeRepository());
test('K01 katakana Grift pricing stays with Grift',async()=>{const r=await reader.lookup('グリフトの料金');assert.equal(r.status,'found');assert.ok(r.items.every(x=>x.key.startsWith('grift.')));});
test('K02 bare unknown product is not assigned generic pricing',async()=>{assert.equal((await reader.lookup('ブリストの料金')).status,'unknown');});
test('K03 unknown product with a noun prefix is not assigned generic pricing',async()=>{assert.equal((await reader.lookup('未知の商品アオゾラの料金')).status,'unknown');});
test('K04 unknown product with an attached pricing noun is not assigned generic pricing',async()=>{assert.equal((await reader.lookup('ブリスト料金')).status,'unknown');});

