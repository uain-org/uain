// Controlled reference fixture; never executes participant-supplied code.
import { readFileSync } from 'node:fs';
const numbers = readFileSync(process.argv[2], 'utf8').trim().split(/\s+/).map(Number);
if (!numbers.every(Number.isFinite)) throw new Error('Invalid reference data');
process.stdout.write(JSON.stringify({ sum: numbers.reduce((a, b) => a + b, 0) }));
