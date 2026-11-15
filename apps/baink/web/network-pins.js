/** Network pins for signing in the browser (moved out of the retired holder
 * wallet view, 9 Nov 2026). */
const HASH = /^[a-f0-9]{64}$/;

/** Chain and genesis come from the deployment's enrolment pins, checked
 * against every current native proof. Unsigned companion JSON never sets them. */
export function networkPins(config, account) {
  const e = config?.nativeRegistration?.enrol;
  if (
    typeof e?.chainId !== "string" ||
    !e.chainId ||
    !HASH.test(e.genesisSha256 ?? "")
  )
    return null;
  const proofs = [config?.native?.proof, account?.native?.proof].filter(
    Boolean,
  );
  if (!proofs.length) return null;
  for (const p of proofs) {
    if (p.chainId !== e.chainId || p.epoch !== e.genesisSha256) return null;
    if (p.genesisSha256 !== undefined && p.genesisSha256 !== e.genesisSha256)
      return null;
  }
  return { chainId: e.chainId, genesisSha256: e.genesisSha256 };
}
