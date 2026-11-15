/** Declared reproducibility metadata. No network access or command execution. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const text = (max: number) => z.string().min(1).max(max);
const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-fA-F0-9]{64}$/).transform((s) => s.toLowerCase());
const uri = text(2000).refine((value) => {
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password;
  } catch { return false; }
}, 'Use an HTTP/HTTPS artifact reference without embedded credentials');

export const artifactSchema = z.object({
  label: text(200),
  // Retain the original legacy size field; strict size rules apply to manifests.
  bytes: z.number().int().optional(),
  manifest: z.object({
    version: z.literal(1), uri, sha256: digest, bytes,
    media_type: text(200), license: text(500),
    role: z.enum(['code', 'dataset', 'environment', 'output', 'other']).optional(),
  }).strict().optional(),
});
export const reproductionSchema = z.object({
  version: z.literal(1), inputs: z.array(text(200)).min(1).max(50),
  command: text(4000), environment: text(2000), seed: text(200).optional(),
  outputs: z.array(z.object({
    metric: text(200), expected: z.number(), absolute_tolerance: z.number().min(0),
  }).strict()).min(1).max(50),
}).strict();
export const reproductionReceiptSchema = z.object({
  version: z.literal(1), manifest_digest: digest,
  outcome: z.enum(['reproduced', 'mismatch', 'inaccessible']),
  command: text(4000), environment: text(2000), seed: text(200).optional(), detail: text(4000),
  inputs: z.array(z.object({
    label: text(200), status: z.enum(['matched', 'mismatch', 'inaccessible']),
    observed_sha256: digest.optional(), observed_bytes: bytes.optional(),
  }).strict()).min(1).max(50),
  outputs: z.array(z.object({ metric: text(200), observed: z.number() }).strict()).max(50).default([]),
}).strict();

export type Artifact = z.infer<typeof artifactSchema>;
export type ReproductionRecipe = z.infer<typeof reproductionSchema>;
export type ReproductionReceipt = z.infer<typeof reproductionReceiptSchema>;
export type EvidenceValidation<T> = ({ ok: true } & T) | { ok: false; message: string };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  return value;
}
export const evidenceDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function artifactManifestDigest(artifacts: Artifact[], reproduction: ReproductionRecipe | null = null): string | null {
  if (!artifacts.some((a) => a.manifest)) return null;
  return evidenceDigest({ version: 1, artifacts, reproduction });
}
const problem = (message: string): { ok: false; message: string } => ({ ok: false, message });
const unique = (values: readonly unknown[]): boolean => new Set(values).size === values.length;

export function validateArtifactEvidence(artifacts: unknown = [], reproduction: unknown = null): EvidenceValidation<{ artifacts: Artifact[]; reproduction: ReproductionRecipe | null }> {
  const parsed = z.object({ artifacts: z.array(artifactSchema).max(50),
    reproduction: reproductionSchema.nullable() }).safeParse({ artifacts, reproduction });
  if (!parsed.success) return problem('Artifact evidence does not match the version 1 schema');
  const data = parsed.data;
  const manifested = data.artifacts.filter((a): a is Artifact & { manifest: NonNullable<Artifact['manifest']> } => a.manifest !== undefined);
  if (manifested.length && !unique(data.artifacts.map((a) => a.label)))
    return problem('Manifested artifacts require unique labels');
  if (manifested.some((a) => a.bytes !== undefined && a.bytes !== a.manifest.bytes))
    return problem('Legacy and manifest byte sizes must agree');
  if (data.reproduction) {
    const recipe = data.reproduction;
    if (!unique(recipe.inputs) || !unique(recipe.outputs.map((o) => o.metric)))
      return problem('Reproduction input labels and output metrics must be unique');
    if (recipe.inputs.some((label) => !manifested.some((a) => a.label === label)))
      return problem('Every reproduction input must name a pinned artifact');
  }
  return { ok: true, artifacts: data.artifacts!, reproduction: data.reproduction! };
}

export function validateReproductionReceipt(artifacts: Artifact[], reproduction: ReproductionRecipe | null, receipt: unknown, verdict: string): EvidenceValidation<{ receipt: ReproductionReceipt }> {
  const parsed = reproductionReceiptSchema.safeParse(receipt);
  if (!parsed.success) return problem('Receipt does not match the version 1 schema');
  const value = parsed.data;
  const manifestDigest = artifactManifestDigest(artifacts, reproduction);
  if (!manifestDigest || value.manifest_digest !== manifestDigest)
    return problem('Receipt must bind to this contribution artifact manifest');
  if (!unique(value.inputs.map((i) => i.label)) || !unique(value.outputs.map((o) => o.metric)))
    return problem('Receipt input labels and output metrics must be unique');
  const required = reproduction?.inputs ?? artifacts.filter((a) => a.manifest).map((a) => a.label);
  if (required.length !== value.inputs.length || required.some((label) => !value.inputs.some((i) => i.label === label)))
    return problem('Receipt must account for every declared reproduction input exactly once');
  let mismatch = reproduction?.seed !== undefined && value.seed !== undefined && value.seed !== reproduction.seed;
  let inaccessible = false;
  for (const input of value.inputs) {
    const pin = artifacts.find((a) => a.label === input.label)?.manifest;
    if (!pin) return problem('Receipt names an unpinned artifact');
    const shaMatches = input.observed_sha256 === pin.sha256;
    const sizeMatches = input.observed_bytes === pin.bytes;
    if (input.status === 'matched' && (!shaMatches || !sizeMatches))
      return problem('Matched inputs must have the declared hash and byte size');
    if (input.status === 'mismatch') {
      if ((input.observed_sha256 === undefined || shaMatches) &&
        (input.observed_bytes === undefined || sizeMatches))
        return problem('A mismatch must record a differing observed hash or size');
      mismatch = true;
    }
    if (input.status === 'inaccessible') {
      if (input.observed_sha256 !== undefined || input.observed_bytes !== undefined)
        return problem('Inaccessible inputs cannot assert observed bytes or hashes');
      inaccessible = true;
    }
  }
  const expected = reproduction?.outputs ?? [];
  for (const output of value.outputs) {
    const target = expected.find((o) => o.metric === output.metric);
    if (!target) return problem('Receipt names an undeclared output metric');
    if (Math.abs(output.observed - target.expected) > target.absolute_tolerance) mismatch = true;
  }
  if (value.outcome === 'reproduced') {
    if (mismatch || inaccessible || expected.length !== value.outputs.length)
      return problem('A reproduced receipt needs matched inputs and every output within tolerance');
    if (reproduction?.seed !== undefined && value.seed !== reproduction.seed)
      return problem('A reproduced receipt must record and use the declared seed');
  }
  if (value.outcome === 'inaccessible' && !inaccessible && expected.length === value.outputs.length)
    return problem('An inaccessible receipt must identify unavailable inputs or incomplete outputs');
  if (value.outcome === 'mismatch' && !mismatch)
    return problem('A mismatch receipt needs a mismatching input or output');
  if (verdict === 'confirmed' && value.outcome !== 'reproduced')
    return problem('A failed or inaccessible reproduction receipt cannot confirm work');
  return { ok: true, receipt: value };
}
