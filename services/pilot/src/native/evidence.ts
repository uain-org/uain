import { createHash } from 'node:crypto';
const FIELDS = ['title','detail','claim_statement','evidence','sources','artifacts','forecast','reproduction'];
export function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if(value.includes('\0'))throw Error('invalid NUL evidence');
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw Error('invalid Unicode evidence');
    return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
  }
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const v=value as Record<string,unknown>;
    return '{'+Object.keys(v).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(k=>canonical(k)+':'+canonical(v[k])).join(',')+'}';
  }
  throw Error('unsupported evidence value');
}
export function evidenceDocument(body: Record<string,unknown>) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k=>!FIELDS.includes(k))) throw Error('public research evidence fields required');
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length>200 || typeof body.detail !== 'string' || body.detail.trim().length<20 || body.detail.length>48000) throw Error('research title/detail bound exceeded');
  if (body.sources!=null && (!Array.isArray(body.sources)||body.sources.length>16||body.sources.some(s=>typeof s!=='string'||s.length>2048))) throw Error('research sources bound exceeded');
  const encoded=canonical(body);if(Buffer.byteLength(encoded)>60000)throw Error('research publication byte bound exceeded');
  return {body:JSON.parse(encoded),canonical:encoded,digest:createHash('sha256').update('uain:research-evidence:v1\n'+encoded).digest('hex')};
}
