/**
 * Audit E-7 (15 November 2026). With UAIN_AUTHORITY unset the server runs
 * pilot mode, with the whole anonymous enrol and write surface. The
 * production image sets NODE_ENV=production (services/pilot/Dockerfile), so
 * there an unset authority stops the server instead of defaulting; every
 * manifest that runs the image names one (production through
 * uain-native-config, staging and the compose files as pilot). Local
 * development and the tests set no NODE_ENV and keep the pilot default.
 * The same image must also pin UAIN_PUBLIC_ORIGIN (audit P2-7).
 *
 * server.ts imports this module first: importing the store connects to the
 * database, so the check has to run before any other import is evaluated.
 * It acts only when server.js is the program being run, so scripts and
 * workers that share the image are unaffected.
 */
import { pathToFileURL } from 'node:url';

/** Why the server must not start, or null. */
export function authorityStartupRefusal(env: Record<string, string | undefined> = process.env): string | null {
  if (env.NODE_ENV === 'production' && !env.UAIN_AUTHORITY)
    return 'Refusing to start: this production image needs UAIN_AUTHORITY set to native or pilot.';
  // Without it the origin sign-in proofs must name falls back to the
  // request's Host header (audit P2-7, 15 November 2026).
  if (env.NODE_ENV === 'production' && !env.UAIN_PUBLIC_ORIGIN)
    return 'Refusing to start: this production image needs UAIN_PUBLIC_ORIGIN, the origin sign-in proofs must name.';
  return null;
}

if (pathToFileURL(process.argv[1] ?? '').href === new URL('./server.js', import.meta.url).href) {
  const refusal = authorityStartupRefusal();
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
}
