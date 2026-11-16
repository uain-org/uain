import {createServer} from '../node_modules/vite/dist/node/index.js';
import {writeFile,rm} from 'node:fs/promises';import {join,resolve} from 'node:path';import assert from 'node:assert/strict';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root=resolve('apps/baink'),html=join(root,'mcp-compat-fixture.html'),jsx=join(root,'mcp-compat-fixture.jsx');let server,browser;
try{
await writeFile(html,'<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/mcp-compat-fixture.jsx"></script>');
await writeFile(jsx,`import React from 'react';import{createRoot}from'react-dom/client';import Mcp from './web/McpConnections.jsx';import './web/style.css';createRoot(document.getElementById('root')).render(<><p>Wallet paired · payment session unchanged</p><Mcp identity={{address:'uain1'+'a'.repeat(40),publicKeyBase64:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='}} token="fixture-only" pins={null} walletAddresses={null}/></>);`);
server=await createServer({root,configFile:false,server:{host:'127.0.0.1',port:0}});await server.listen();const origin=server.resolvedUrls.local[0];browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
for(const scenario of ['legacy','supported','session','network','wrong404','recover']){
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();const requests=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://127.0.0.1:8848/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;requests.push({method:req.method(),path});if(scenario==='network')return route.abort();let status=200,body=path.endsWith('pending')?(path.includes('signatures')?{challenge:null}:{pending:[]}):{grants:[]};if(scenario==='legacy'){status=404;body={error:'holder_route_missing'};}if(scenario==='session'){status=401;body={error:'holder_session_required'};}if(scenario==='wrong404'){status=404;body={error:'unexpected_route'};}if(scenario==='recover'&&requests.length<=2){status=503;body={error:'holder_stopping'};}await route.fulfill({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(body)});});
 await page.goto(origin+'mcp-compat-fixture.html');await page.getByText('Wallet paired · payment session unchanged').waitFor();
 if(scenario==='legacy'){await page.getByText(/This wallet version does not support connected AI clients/).waitFor();const count=requests.length;await new Promise(r=>setTimeout(r,2300));assert.equal(requests.length,count);assert.equal(count,2);await page.screenshot({path:join(process.env.BAINK_BROWSER_ARTIFACTS || process.env.TMPDIR || '/tmp','mcp-legacy-mobile.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 else if(scenario==='supported'){await page.waitForFunction(()=>document.querySelectorAll('.form-error').length===0);await new Promise(r=>setTimeout(r,100));assert.equal(await page.getByRole('alert').count(),0);assert.ok(requests.some(x=>x.path==='/v1/mcp/signatures/pending'));}
 else if(scenario==='session')await page.getByText('The wallet session ended. Pair the wallet again.').waitFor();
 else if(scenario==='network')await page.getByText('Your local wallet companion is not reachable on this device.').waitFor();
 else if(scenario==='recover'){await page.getByText('Your wallet refused this step. Try again.').waitFor();await page.getByRole('alert').waitFor({state:'detached'});assert.ok(requests.length>=5);}
 else await page.getByText('Your wallet refused this step. Try again.').waitFor();
 assert.ok(requests.every(x=>x.method==='GET'));assert.deepEqual(errors,[]);console.log('PASS',scenario,requests.length,'GET-only');await context.close();
}
}finally{await browser?.close();await server?.close();await rm(html,{force:true});await rm(jsx,{force:true});}
