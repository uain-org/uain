import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {nativeState,proofReaderReason} from '../dist/src/api/native-routes.js';

// A refused proof read used to be logged only as "native proof verification refused" (10 Nov 2026):
// the reader's own reason was read and dropped. The caller's error stays generic; the replica's log
// now carries the reader's last line, bounded and with nothing shaped like a credential.
async function reader(dir,body){
 const binary=join(dir,'reader-'+createHash('sha256').update(body).digest('hex').slice(0,8)),genesis=join(dir,'genesis');
 const script=`#!${process.execPath}\n${body}\n`;
 await writeFile(binary,script);await chmod(binary,0o700);await writeFile(genesis,'{}');
 return{binary,binaryHash:createHash('sha256').update(script).digest('hex'),genesis,genesisHash:createHash('sha256').update('{}').digest('hex'),rpc:'http://127.0.0.1:1'};
}
async function capture(run){
 const lines=[],original=console.error;console.error=(...args)=>lines.push(args.join(' '));
 try{await run()}finally{console.error=original}
 return lines.filter(l=>l.startsWith('Native proof reader refused'));
}

test('the reader reason is one bounded line with credentials removed',()=>{
 assert.equal(proofReaderReason('first\nrpc returned status 503\n'),'rpc returned status 503');
 assert.equal(proofReaderReason('a\r\n\n  \n'),'a');
 assert.equal(proofReaderReason(''),'');assert.equal(proofReaderReason(undefined),'');assert.equal(proofReaderReason(Buffer.from('x')),'');
 assert.equal(proofReaderReason('bad\u0000 \u001b[31mred\u001b[0m\ttext more'),'bad red text more');
 assert.equal(proofReaderReason('dial https://user:hunter2@node.example/ failed'),'dial https://[redacted]@node.example/ failed');
 for(const leak of['token=abc123','Authorization: Bearer abc123','password "p w"','api_key:abc123','private key abc123','secret=abc123'])assert.doesNotMatch(proofReaderReason('refused '+leak+' end'),/abc123|hunter2|p w/,leak);
 // Written in two parts so that no scanner reads this test as a key.
 assert.equal(proofReaderReason('x -----BEGIN '+'PRIVATE KEY----- MIIB'),'x [redacted]');
 const long=proofReaderReason('e'.repeat(5000));assert.equal(long.length,300);assert.ok(long.endsWith('…'));
 // Only the tail is read, so a flood before the last line cannot widen the bound.
 assert.equal(proofReaderReason('x'.repeat(10000)+'\nlast line'),'last line');
});

test('a refused proof read logs the reader reason and keeps the caller error generic',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'uain-proof-refusal-'));try{
  const refusing=await reader(dir,`process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('opening checkpoint\\npinned genesis, bounded freshness and exact member/instance selection required\\n');process.exit(3)});`);
  let lines=await capture(()=>assert.rejects(nativeState({keys:['a','b','c']},refusing),e=>e.message==='native proof verification refused'));
  assert.equal(lines.length,1);
  assert.match(lines[0],/^Native proof reader refused \(exit 3, 3 keys, \d+ ms, \d+ running, \d+ waiting\): pinned genesis, bounded freshness and exact member\/instance selection required$/);
  assert.doesNotMatch(lines[0],/opening checkpoint/,'only the last line is logged');

  const silent=await reader(dir,`process.stdin.resume();process.stdin.on('end',()=>process.exit(1));`);
  lines=await capture(()=>assert.rejects(nativeState({member:'uain1'+'0'.repeat(40)},silent),/native proof verification refused/));
  assert.match(lines[0],/\(exit 1, member state, \d+ ms, .*\): no reason given$/);

  const leaking=await reader(dir,`process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('rpc https://u:pw-12345@127.0.0.1:26657 said token=tok-12345 '+'z'.repeat(4000)+'\\n');process.exit(2)});`);
  lines=await capture(()=>assert.rejects(nativeState({keys:[]},leaking),/native proof verification refused/));
  assert.equal(lines.length,1);assert.doesNotMatch(lines[0],/pw-12345|tok-12345/);assert.ok(lines[0].length<500,'bounded line');

  // A read the caller cancelled is not a refusal by the reader.
  const waiting=await reader(dir,`setTimeout(()=>{},60000);`);
  const stop=new AbortController();
  lines=await capture(async()=>{const read=nativeState({keys:[]},waiting,{signal:stop.signal});setTimeout(()=>stop.abort(),200);await assert.rejects(read,{name:'AbortError'})});
  assert.deepEqual(lines,[]);

  // A success logs nothing.
  const fine=await reader(dir,`const fs=require('fs'),a=process.argv.slice(2);process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('note\\n');fs.writeFileSync(a[a.indexOf('--out')+1],'{"ok":true}',{mode:384,flag:'wx'})});`);
  lines=await capture(async()=>assert.deepEqual(await nativeState({keys:[]},fine),{ok:true}));
  assert.deepEqual(lines,[]);

  // A burst of refusals cannot flood the log: 12 lines a minute for each replica.
  lines=await capture(async()=>{for(let i=0;i<14;i++)await assert.rejects(nativeState({keys:[]},refusing),/native proof verification refused/)});
  assert.equal(lines.length,12-3,'three lines of this minute were already used above');
 }finally{await rm(dir,{recursive:true,force:true})}
});
