/** Exact cumulative reward allowances in native micro-AI$; never wallet balances. */
const allowances=Object.freeze(['10000000000','110000000000','1110000000000','11110000000000','111110000000000','1000000000000000']);
export function centralUnlockedUnits(round){return Number.isInteger(round)&&round>=1&&round<=6?allowances[round-1]:null;}
