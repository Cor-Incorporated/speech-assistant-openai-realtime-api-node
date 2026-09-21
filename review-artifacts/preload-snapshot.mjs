// Test-only frozen clone of the published production release. No database IO.
import {readFileSync} from 'node:fs';
import {InMemoryKnowledgeRepository} from '../dist-backend/knowledge/repository.js';
const snapshot=JSON.parse(readFileSync(new URL('./knowledge-snapshot.json',import.meta.url),'utf8'));
InMemoryKnowledgeRepository.prototype.getRuntimeSettings=async()=>structuredClone(snapshot.settings);
InMemoryKnowledgeRepository.prototype.getRelease=async(id)=>id===snapshot.release.releaseId?structuredClone(snapshot.release):null;
InMemoryKnowledgeRepository.prototype.getReleaseItems=async(id)=>id===snapshot.release.releaseId?structuredClone(snapshot.items):[];
