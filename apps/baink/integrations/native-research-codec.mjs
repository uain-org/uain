// Portable, exact native research codec; no key access or network operations.
const enc = new TextEncoder();
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const HASH = /^[a-f0-9]{64}$/;
const RESEARCH_OPERATIONS = Object.freeze(['open_project','open_task','project_join','submit','verify']);
function need(ok) { if (!ok) throw new Error('Invalid bounded native research command'); }
const exact = (x, keys) => x && Object.getPrototypeOf(x) === Object.prototype && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x,k));
function string(x) {
 need(typeof x === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(x));
 return JSON.stringify(x).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
}
function compare(a,b) { const x=enc.encode(a),y=enc.encode(b); for(let i=0;i<Math.min(x.length,y.length);i++) if(x[i]!==y[i])return x[i]-y[i];return x.length-y.length; }
export function canonicalJSON(x) {
 if(x===null)return 'null';if(typeof x==='string')return string(x);if(typeof x==='boolean')return String(x);
 if(typeof x==='number'){need(Number.isSafeInteger(x));return String(x);}
 if(Array.isArray(x))return '['+x.map(canonicalJSON).join(',')+']';
 need(x && Object.getPrototypeOf(x)===Object.prototype);return '{'+Object.keys(x).sort(compare).map(k=>string(k)+':'+canonicalJSON(x[k])).join(',')+'}';
}
function text(x,min,max,multiline=false){string(x);need(enc.encode(x).length>=min&&enc.encode(x).length<=max&&!(multiline?/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/:/[\u0000-\u001f\u007f]/).test(x));}
function prior(x){need(exact(x,['basis','searches']));text(x.basis,40,4000,true);need(enc.encode(x.basis.trim()).length>=40);searches(x.searches);}
function searches(x){need(Array.isArray(x)&&x.length>=2&&x.length<=16&&new Set(x.map(s=>typeof s==='string'?s.trim():s)).size===x.length);for(const s of x){need(typeof s==='string');text(s.trim(),5,1000);}}
export function validateResearchPayload(op,p) {
 need(RESEARCH_OPERATIONS.includes(op));
 if(op==='open_project'){need(exact(p,['id','title','class','prior_art'])&&ID.test(p.id)&&['benevolent','neutral'].includes(p.class));text(p.title,5,250);prior(p.prior_art);}
 if(op==='open_task'){need(exact(p,['id','project','title','class','prior_art','criteria','kind','karma_reward','credit_reward'])&&ID.test(p.id)&&ID.test(p.project)&&['benevolent','neutral'].includes(p.class)&&p.kind==='instant'&&p.karma_reward===0&&p.credit_reward==='0');text(p.title,5,250);text(p.criteria,40,4000,true);prior(p.prior_art);}
 if(op==='project_join')need(exact(p,['project'])&&ID.test(p.project));
 if(op==='submit')need(exact(p,['id','task','evidence_digest'])&&ID.test(p.id)&&ID.test(p.task)&&HASH.test(p.evidence_digest));
 if(op==='verify'){need((exact(p,['contribution','verdict','novelty','searches','evidence_digest']) || exact(p,['contribution','verdict','novelty','searches','evidence_digest','known_source']))&&ID.test(p.contribution)&&['confirm','dispute'].includes(p.verdict)&&['new','known'].includes(p.novelty)&&HASH.test(p.evidence_digest));searches(p.searches);if(p.known_source!==undefined)text(p.known_source,0,500);if(p.novelty==='known'){need(typeof p.known_source==='string'&&p.known_source===p.known_source.trim());let u;try{u=new URL(p.known_source);}catch{}need(u&&u.protocol==='https:'&&u.hostname&&!u.username&&!u.password);}}
 canonicalJSON(p);return p;
}
export function nativeResearchSigningBytes(c) {
 const fields=['version','chain_id','member','sequence','expires_height','operation','payload','instance'];
 need(exact(c,fields)&&c.version===1&&typeof c.chain_id==='string'&&/^[A-Za-z0-9._-]{1,96}$/.test(c.chain_id)&&/^uain1[a-f0-9]{40}$/.test(c.member)&&ID.test(c.instance)&&typeof c.sequence==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(c.sequence)&&BigInt(c.sequence)<18446744073709551615n&&typeof c.expires_height==='string'&&/^[1-9][0-9]{0,18}$/.test(c.expires_height)&&BigInt(c.expires_height)<=9223372036854775807n);
 validateResearchPayload(c.operation,c.payload);
 return enc.encode('uain:chain-command:v1\n{'+fields.map(k=>string(k)+':'+canonicalJSON(c[k])).join(',')+'}');
}
export function canonicalEvidence(x){
 if(typeof x==='number'){need(Number.isFinite(x)&&(!Number.isInteger(x)||Number.isSafeInteger(x)));return JSON.stringify(x);}
 if(typeof x==='string'){need(!x.includes('\0'));return string(x);}
 if(x===null)return 'null';if(typeof x==='boolean')return String(x);
 if(Array.isArray(x))return '['+x.map(canonicalEvidence).join(',')+']';
 need(x&&Object.getPrototypeOf(x)===Object.prototype);return '{'+Object.keys(x).sort(compare).map(k=>canonicalEvidence(k)+':'+canonicalEvidence(x[k])).join(',')+'}';
}
export function researchEvidenceCanonical(body){
 const fields=['title','detail','claim_statement','evidence','sources','artifacts','forecast','reproduction'];
 need(body&&Object.getPrototypeOf(body)===Object.prototype&&Object.keys(body).every(k=>fields.includes(k))&&typeof body.title==='string'&&body.title.trim().length>0&&body.title.length<=200&&typeof body.detail==='string'&&body.detail.trim().length>=20&&body.detail.length<=48000);
 if(body.sources!=null)need(Array.isArray(body.sources)&&body.sources.length<=16&&body.sources.every(s=>typeof s==='string'&&s.length<=2048));
 const result=canonicalEvidence(body);need(enc.encode(result).length<=60000);return result;
}
