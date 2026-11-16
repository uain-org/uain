#!/usr/bin/env node
/** Root-owned immutable dispatcher. Installation MUST use a release directory
 * named by SHA256(source-manifest.json), containing this entire pinned closure. */
import {readFile,stat,realpath} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {dirname,resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';
import {boundedProcess,validateRequest} from './house-remote-solver.mjs';
import {RECOVERY_SOURCE_PATHS} from './house-format-recovery.mjs';
const NODE='/opt/uain-review-runtime/node-v22.22.0-linux-x64/bin/node';
const ROOT='/opt/uain-house-solver/current';
export const CLOSURE=RECOVERY_SOURCE_PATHS;
const sha=x=>createHash('sha256').update(x).digest('hex');const need=(v)=>{if(!v)throw Error('immutable dispatcher refused');};
export function systemdArgs(executionId,release=ROOT){
 need(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(executionId));
 return ['--quiet','--wait','--pipe','--collect','--service-type=exec','--unit=uain-house-'+sha(executionId).slice(0,32),
  ...['User=uain-house-solver','Group=uain-house-solver','EnvironmentFile=/etc/uain-broker/claude.env','Environment=HOME=/var/lib/uain-house-solver/home',
   'WorkingDirectory=/var/lib/uain-house-solver','StateDirectory=uain-house-solver','StateDirectoryMode=0700','UMask=0077',
   'ProtectProc=invisible','ProcSubset=pid','ProtectSystem=strict','ProtectHome=yes','PrivateTmp=yes','PrivateDevices=yes','NoNewPrivileges=yes','ProtectKernelTunables=yes','ProtectKernelModules=yes','ProtectControlGroups=yes',
   'RestrictSUIDSGID=yes','LockPersonality=yes','CapabilityBoundingSet=','RestrictAddressFamilies=AF_INET AF_INET6',
   'BindReadOnlyPaths=/opt/uain-broker/claude/2.1.310/claude:/var/lib/uain-house-solver/claude','ReadWritePaths=/var/lib/uain-house-solver','InaccessiblePaths=-/opt/uain-broker -/etc/uain-broker -/var/lib/uain-broker -/etc/uain-custody -/var/lib/uain-custody -/opt/uain-custody -/run/uain-broker -/run/uain-custody -/run/user -/var/lib/uain-wallets -/var/lib/uain-native -/root -/home',
   'RuntimeMaxSec=1220','TimeoutStopSec=5','KillMode=control-group','MemoryMax=2G','TasksMax=128'].map(v=>'--property='+v),
  NODE,join(release,'ops/agents/house-remote-solver-runtime.mjs')];
}
export async function verifyClosure(){
 const release=await realpath(ROOT);need(/^\/opt\/uain-house-solver\/releases\/[a-f0-9]{64}$/.test(release));
 for(let d=release;d!=='/';d=dirname(d)){const m=await stat(d);need(m.isDirectory()&&m.uid===0&&!(m.mode&0o022));}
 const manifestPath=join(release,'source-manifest.json'),s=await stat(manifestPath);need(await realpath(manifestPath)===manifestPath&&s.nlink===1&&s.isFile()&&s.uid===0&&!(s.mode&0o022)&&s.size<=16384);
 const bytes=await readFile(manifestPath);need(sha(bytes)===release.split('/').pop());const manifest=JSON.parse(bytes);need(Object.keys(manifest).sort().join(',')===[...CLOSURE].sort().join(','));
 for(const p of CLOSURE){const path=join(release,p),meta=await stat(path);for(let d=dirname(path);d!==release;d=dirname(d)){const m=await stat(d);need(m.isDirectory()&&m.uid===0&&!(m.mode&0o022));}need(await realpath(path)===path&&meta.isFile()&&meta.uid===0&&!(meta.mode&0o022)&&meta.size<=1048576&&sha(await readFile(path))===manifest[p]);}
 const own=await realpath(fileURLToPath(import.meta.url));need(own===join(release,'ops/agents/house-remote-solver-host.mjs'));return release;
}
async function main(){need(process.getuid()===0&&process.argv.length===2);const release=await verifyClosure();let n=0;const chunks=[];for await(const b of process.stdin){n+=b.length;need(n<=262144);chunks.push(b);}const req=validateRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));return boundedProcess('/usr/bin/systemd-run',systemdArgs(req.executionId,release),JSON.stringify(req),{timeoutMs:1240000,maxBytes:1048576});}
// Node resolves ESM symlinks in import.meta.url; the installed wrapper uses current/.
// Compare canonical paths so the immutable dispatcher cannot silently skip main.
if(process.argv[1]&&await realpath(resolve(process.argv[1])).catch(()=>null)===fileURLToPath(import.meta.url)){try{process.stdout.write(JSON.stringify(await main())+'\n');}catch{process.stderr.write('Immutable remote dispatcher refused or uncertain.\n');process.exitCode=1;}}
