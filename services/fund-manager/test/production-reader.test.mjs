import {test} from 'node:test';import assert from 'node:assert/strict';
import {openProductionInspectionReader} from '../src/production-reader.mjs';
test('production factory rejects all caller configuration/capability overrides before reading a profile',async()=>{
 for(const args of [[{}],[{remoteTransport:{}}],[{rpc:'https://arbitrary.example'}],[{binary:'/tmp/fake'}],[()=>{}]])await assert.rejects(openProductionInspectionReader(...args),e=>e.code==='inspection_reader_arguments');
});
