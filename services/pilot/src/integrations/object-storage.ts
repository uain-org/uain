/**
 * File storage in an S3-compatible bucket: DigitalOcean Spaces in production
 * (bucket `uain`, nyc3). Set up ahead of need; nothing in the server stores
 * files here yet. `scripts/storage-check.mjs` proves the settings work.
 *
 * Settings: UAIN_STORAGE_ENDPOINT (https://nyc3.digitaloceanspaces.com),
 * UAIN_STORAGE_BUCKET, UAIN_STORAGE_ACCESS_KEY_ID,
 * UAIN_STORAGE_SECRET_ACCESS_KEY, and UAIN_STORAGE_REGION (default
 * us-east-1, which Spaces accepts whatever the datacentre).
 *
 * Requests are signed here (AWS Signature Version 4) rather than through the
 * AWS SDK, which would be the largest dependency of the server for three calls.
 */
import { createHash, createHmac } from 'node:crypto';

export interface StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

/** The configuration from the environment, or null when it is not set. */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): StorageConfig | null {
  const { UAIN_STORAGE_ENDPOINT: endpoint, UAIN_STORAGE_BUCKET: bucket } = env;
  const { UAIN_STORAGE_ACCESS_KEY_ID: accessKeyId, UAIN_STORAGE_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey, region: env.UAIN_STORAGE_REGION || 'us-east-1' };
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
// S3 wants every character but A-Z a-z 0-9 - _ . ~ encoded, and / kept.
const encodeKey = (key: string) =>
  key.split('/').map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

export function objectStorage(config: StorageConfig, fetchImpl: typeof fetch = fetch) {
  const base = new URL(config.endpoint);
  // Virtual-hosted style (bucket.nyc3.digitaloceanspaces.com), which Spaces requires.
  const host = `${config.bucket}.${base.host}`;
  const region = config.region ?? 'us-east-1';

  async function request(method: 'GET' | 'PUT' | 'DELETE', key: string, body?: Uint8Array, contentType?: string) {
    if (!key || key.startsWith('/')) throw new Error('An object key is a non-empty path without a leading slash');
    const path = `/${encodeKey(key)}`;
    const payload = body ?? new Uint8Array();
    const payloadHash = sha256(payload);
    const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const headers: Record<string, string> = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    if (contentType) headers['content-type'] = contentType;
    const names = Object.keys(headers).sort();
    const canonical = [method, path, '', ...names.map((n) => `${n}:${headers[n]}`), '', names.join(';'), payloadHash].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, day), region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    delete headers.host;
    return fetchImpl(`${base.protocol}//${host}${path}`, {
      method,
      headers,
      body: body ? Buffer.from(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  }

  const fail = async (what: string, response: Response) => {
    const detail = (await response.text()).match(/<Code>([^<]+)<\/Code>/)?.[1] ?? '';
    return new Error(`storage ${what} answered ${response.status}${detail ? ` ${detail}` : ''}`);
  };

  return {
    /** Stores the bytes under the key, private (the bucket's default). */
    async put(key: string, body: Uint8Array | string, contentType = 'application/octet-stream') {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      const r = await request('PUT', key, bytes, contentType);
      if (!r.ok) throw await fail(`put ${key}`, r);
      await r.body?.cancel();
    },
    /** The object's bytes, or null when there is no such key. */
    async get(key: string): Promise<Uint8Array | null> {
      const r = await request('GET', key);
      if (r.status === 404) { await r.body?.cancel(); return null; }
      if (!r.ok) throw await fail(`get ${key}`, r);
      return new Uint8Array(await r.arrayBuffer());
    },
    async remove(key: string) {
      const r = await request('DELETE', key);
      if (!r.ok && r.status !== 404) throw await fail(`delete ${key}`, r);
      await r.body?.cancel();
    },
  };
}
