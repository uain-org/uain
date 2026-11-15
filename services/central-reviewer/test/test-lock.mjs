// Mac-only unit injection. Production defaults unconditionally to Linux flock.
const held=new Set();export async function acquireTestLock(handle,path){if(held.has(path))throw Error('store locked');held.add(path);return()=>held.delete(path);}
