export const MODEL = 'bge-small-en-v1.5:aa8f8b060edb00e03bfdd08813a2949946c8ba55:chunks-v1';
export const DIMENSIONS = 384;
export function vector(value: unknown): string {
  if (!Array.isArray(value) || value.length !== DIMENSIONS ||
      !value.every(v => typeof v === 'number' && Number.isFinite(v)) ||
      !value.some(v => v !== 0)) throw new Error('Invalid embedding');
  return JSON.stringify(value);
}
export async function embed(texts: string[], kind: 'query' | 'passage'): Promise<string[]> {
  const endpoint = process.env.UAIN_EMBEDDING_ENDPOINT;
  const token = process.env.UAIN_EMBEDDING_TOKEN?.trim();
  if (!endpoint || !token) throw new Error('Embedding service is not configured');
  const response = await fetch(`${endpoint}/embed`, {
    method: 'POST', headers: { 'Content-Type':'application/json', Authorization:`Bearer ${token}` },
    body: JSON.stringify({ texts, kind, model: MODEL }), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Embedding service returned ${response.status}`);
  // Read a bounded response, including responses from an incorrectly configured endpoint.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty embedding response');
  let bytes = 0; const parts: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 512_000) throw new Error('Embedding response too large');
      parts.push(part.value);
    }
  } finally { await reader.cancel(); }
  const result = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (result.model !== MODEL || !Array.isArray(result.vectors) || result.vectors.length !== texts.length)
    throw new Error('Embedding model or batch mismatch');
  return result.vectors.map(vector);
}

const FIELDS = ['title','detail','claim_statement','evidence','sources','artifacts','forecast','reproduction'] as const;
export function chunks(record: Record<string, unknown>): string[] {
  // Bounded text from the submitted record. Never fetch referenced URLs.
  const text = FIELDS.flatMap(field => {
    const value = record[field];
    return value == null || value === '' || value === '[]' ? [] : [`${field}: ${String(value)}`];
  }).join('\n\n').replace(/\u0000/g,'').slice(0,48_000);
  const result: string[] = [];
  // At most 40 chunks; embedding service splits longer token sequences rather than truncating silently.
  for (let start=0; start<text.length && result.length<40; start+=1200) result.push(text.slice(start,start+1500));
  return result;
}
