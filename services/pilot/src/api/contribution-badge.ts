/** Read-only badge. Refuse unavailable proofs rather than displaying zero. */
export function verifiedContributionCount(profile:any):number {
 if(profile.authority!=='native'||!Array.isArray(profile.work?.contributed))throw Error('verified public record required');
 const ids=new Set<string>();
 for(const c of profile.work.contributed){
  if(typeof c.id!=='string'||c.contributor!==profile.id)throw Error('contribution identity differs');
  if(c.state==='settled'&&c.evidence_available===true)ids.add(c.id);
 }
 return ids.size;
}
export function contributionBadge(value:number|string):string {
 const label='UAIN verified contributions',text=String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
 return `<svg xmlns="http://www.w3.org/2000/svg" width="290" height="24" role="img" aria-label="${label}: ${text}"><title>${label}: ${text}</title><rect width="200" height="24" fill="#26354a"/><rect x="200" width="90" height="24" fill="#176849"/><g fill="white" font-family="Verdana,sans-serif" font-size="11" text-anchor="middle"><text x="100" y="16">${label}</text><text x="245" y="16">${text}</text></g></svg>`;
}
export async function handleContributionBadge(req:any,res:any,url:URL,read:(url:URL)=>Promise<any>,audit:(status:number,detail:string)=>void){
 const match=url.pathname.match(/^\/api\/badges\/([A-Za-z0-9][A-Za-z0-9._:-]{0,255})\.svg$/);
 if(!match||!['GET','HEAD'].includes(req.method))return false;
 let status=200,value:number|string='unavailable';
 try{const result=await read(new URL('/api/directory/'+encodeURIComponent(match[1]),'https://uain.invalid'));if(result.status===404){status=404;value='unknown'}else if(result.status!==200)throw Error('public record unavailable');else value=verifiedContributionCount(result.body)}catch{status=503}
 res.statusCode=status;res.setHeader('content-type','image/svg+xml; charset=utf-8');res.setHeader('x-content-type-options','nosniff');res.setHeader('content-security-policy',"default-src 'none'; style-src 'unsafe-inline'; sandbox");res.setHeader('cache-control',status===200?'public, max-age=60, s-maxage=60':'no-store');res.end(req.method==='HEAD'?undefined:contributionBadge(value));audit(status,'public contribution badge');return true;
}
