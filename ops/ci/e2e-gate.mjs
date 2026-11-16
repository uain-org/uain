/**
 * Gate for tests that need a real chain, pinned release artifacts or a
 * throwaway root filesystem. Routine CI cannot provide those, so the test is
 * skipped with a stated reason, and CI lists every skip
 * (ops/ci/container-suite.sh, `report_skips`).
 *
 * A job that is meant to run them sets UAIN_REQUIRE_E2E=1. A missing
 * configuration is then a failure at module load, never a quiet skip.
 *
 *   test('name', {skip: e2eSkip(enabled, 'UAIN_FINANCIAL_E2E=1 and pinned /tools')}, ...)
 */
export function e2eSkip(enabled, requirement) {
  if (enabled) return false;
  if (process.env.UAIN_REQUIRE_E2E === '1')
    throw new Error(`UAIN_REQUIRE_E2E=1, but this real-chain test is not configured: needs ${requirement}`);
  return `real-chain e2e not configured (needs ${requirement}); runs where UAIN_REQUIRE_E2E=1`;
}
