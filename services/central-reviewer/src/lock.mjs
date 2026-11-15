import{spawn}from'node:child_process';
/** Stable inode flock: child inherits SAME open-file-description on fd3. Never unlink. */
export async function acquireWorkerLock(handle){
 if(process.platform!=='linux')throw Error('Linux worker flock required');
 await new Promise((resolve,reject)=>{const child=spawn('/usr/bin/flock',['-n','3'],{stdio:['ignore','ignore','ignore',handle.fd]});const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('worker lock timeout'));},5000);child.once('error',()=>{clearTimeout(timer);reject(Error('worker flock unavailable'));});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('store locked'));});});
}
