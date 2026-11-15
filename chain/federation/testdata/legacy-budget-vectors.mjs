import { writeFileSync } from 'node:fs';
const output = process.argv[2];
if (!output) throw new Error('Pass the disposable output JSON path');
const budgets = new Set([0, 1, 999, 1000, 1001, 10000000, Number.MAX_SAFE_INTEGER]);
for (let n = 0; n <= 1000; n++) budgets.add(n);
let seed = 912367n;
const mask = (1n << 53n) - 1n;
for (let i = 0; i < 10000; i++) {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) & mask;
  budgets.add(Number(seed));
}
const shares = [0.0001, 0.001, 0.02, 1];
const rows = [...budgets].flatMap(budget => shares.map((share, stage) => ({
  budget, stage, expected: Math.min(budget, Math.max(1000, Math.ceil(budget * share))),
})));
writeFileSync(output, JSON.stringify(rows));
console.log(`Wrote ${rows.length} independent source JavaScript budget vectors`);
