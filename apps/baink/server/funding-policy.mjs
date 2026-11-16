/** Proposal validation only. This module cannot adopt a policy, submit an
 * application, authorize an evaluator, reserve assets or issue/spend Coin. */
import { createHash } from "node:crypto";
import { nativeUnitsFromDecimal, assetMetadata } from "./native-asset.mjs";
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const only = (value, fields) =>
  plain(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((key) => Object.hasOwn(value, key));
const invalid = () => {
  throw Error(
    "A funding schedule must contain exactly six ordered rounds and exact positive decimal text amounts.",
  );
};
export function validateFundingSchedule(input) {
  if (
    !only(input, ["rounds", "statedTotal"]) ||
    !Array.isArray(input.rounds) ||
    input.rounds.length !== 6
  )
    invalid();
  let total, rounds;
  try {
    total = BigInt(nativeUnitsFromDecimal(input.statedTotal));
    rounds = Array.from(input.rounds, (row, index) => {
      if (!only(row, ["round", "amount"]) || row.round !== index + 1) invalid();
      return BigInt(nativeUnitsFromDecimal(row.amount));
    });
  } catch {
    invalid();
  }
  const calculated = rounds.reduce((sum, value) => sum + value, 0n);
  const blockers = [];
  if (rounds.some((value, index) => index > 0 && value <= rounds[index - 1]))
    blockers.push("round_amount_not_increasing");
  if (calculated !== total) blockers.push("stated_total_mismatch");
  if (calculated > BigInt(assetMetadata().supplyCapUnits))
    blockers.push("aggregate_exceeds_native_supply_cap");
  return {
    arithmeticValid: blockers.length === 0,
    blockers,
    calculatedTotalUnits: String(calculated),
    statedTotalUnits: String(total),
    authorizesFunding: false,
  };
}
// Internal normalized planning evidence. Raw source and candidate correction are
// deliberately absent from the public DTO; preserve source receipts privately.
const literal = {
  rounds: [
    "10000",
    "100000",
    "1000000",
    "10000000",
    "100000000",
    "888890000",
  ].map((amount, index) => ({ round: index + 1, amount })),
  statedTotal: "1000000000",
};
const assessment = validateFundingSchedule(literal);
const readiness = {
  schema: "baink/project-funding-readiness/v1",
  status: assessment.arithmeticValid ? "draft-unadopted" : "draft-inconsistent",
  assetId: "uain-native-coin",
  currency: "AI$",
  scope: "proposed-project-funding-not-a-balance",
  proposedRoundCount: 6,
  amountsPublished: false,
  scheduleConfirmed: true,
  scheduleBasis:
    "Confirmed operator decisions on 2026-11-05; native activation remains separately qualified",
  policyAdopted: false,
  directManagerGrant: false,
  applicationRequired: true,
  firstRoundApplicationRequired: false,
  taskReviewAuthority: "UAIN-centralized",
  spendingScope: ["solver-rewards", "reviewer-rewards"],
  unspentAllowanceCarriesForward: true,
  monthlyIssuanceLimit: null,
  advancementReviewRequired: true,
  progressModel: {
    earlierRounds: "five-sub-kpis-toward-main-kpi",
    subKpiCount: 5,
    definedBy: "UAIN Fund Manager",
    finalRoundGoal: "main-kpi-achieved-before-final-release",
    nextReleaseGate: "prior-round-kpi-accepted",
    amendments: "versioned-justification-and-fund-approval",
    milestoneThresholds: null,
    criteriaStatus: "not-qualified",
  },
  reviewer: {
    model: "UAIN-centralized-fund-manager",
    configured: false,
    authority: "not-established",
  },
  blockers: [
    ...assessment.blockers,
    "milestone_evidence_and_appeal_workflow_not_qualified",
    "fund_policy_not_adopted",
    "review_workflow_not_configured",
    "native_funding_authority_not_qualified",
  ],
  submissionAvailable: false,
  allocationAvailable: false,
  settlementAvailable: false,
  funds: {
    issued: null,
    reserved: null,
    spendable: null,
    status: "not-established",
  },
  notice:
    "Staged project funding is a product proposal. The planning schedule is selected; no direct manager grant, native policy adoption, reviewer authority, funding application or spendable funds are established by this record. A later round requires a qualified application and progress review. Correct arithmetic alone does not authorize funds.",
};
const revision = createHash("sha256")
  .update(JSON.stringify({ proposal: literal, readiness }))
  .digest("hex");
export function projectFundingReadiness() {
  return { ...structuredClone(readiness), revision };
}
