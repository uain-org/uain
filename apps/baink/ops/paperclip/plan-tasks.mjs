// Bounded offline stdin JSON -> stdout plan JSON; never signs or executes work.
import { buildTaskBatch } from './task-plan.mjs';
let bytes=0;const chunks=[];
try {
 for await (const chunk of process.stdin) {
  bytes+=chunk.length;if(bytes>256*1024)throw Error();chunks.push(chunk);
 }
 const input=JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
 const output=JSON.stringify(buildTaskBatch(input),null,2)+'\n';
 if(Buffer.byteLength(output)>2*1024*1024)throw Error();
 process.stdout.write(output);
} catch {
 process.stderr.write('Task planning refused invalid or oversized input.\n');process.exitCode=1;
}
