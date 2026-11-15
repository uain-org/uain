/**
 * A throwaway database to try the dashboard on: the waitlist table and the
 * test fixtures (fake rows, hostile ones included). Prints its URL.
 *
 *   node test/dev-db.mjs
 *
 * Uses UAIN_TEST_PG, like the tests. Drop it afterwards with
 * DROP DATABASE <name> WITH (FORCE).
 */
import { createTempDb } from './helpers.mjs';

const db = await createTempDb();
console.log(db.url);
