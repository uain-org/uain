// Executable wrapper; implementation and validation live in strict TypeScript.
import { main, failureMessage } from '../dist/cli.js';
main().catch(error => {
  console.error(`Operation failed: ${failureMessage(error)}. No automatic mutation retry occurred.`);
  process.exitCode = 1;
});
