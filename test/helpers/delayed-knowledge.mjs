// Delay only the test child process so a lookup outlives provider fallback.
import { KnowledgeReader } from '../../dist-backend/knowledge/knowledge-reader.js';
const lookup = KnowledgeReader.prototype.lookup;
KnowledgeReader.prototype.lookup = async function (...args) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return lookup.apply(this, args);
};
