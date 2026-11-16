import { ready, close } from '../storage/store.ts';
import { indexResearchOne, enabled, researchStatus } from './index.ts';
if (enabled()) {
  await ready();
  try {
    const started = Date.now(); let count=0;
    while (Date.now()-started<240_000 && count<100 && await indexResearchOne()) count++;
    console.log(JSON.stringify({processed:count,...await researchStatus()}));
  } finally { await close(); }
}
