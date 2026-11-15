/**
 * The one way the site speaks about money (10 November 2026), from the
 * decision register: members earn AI$, paid in native UAIN Coin, and Karma
 * (K-8); the platform is in testing, not launched (K-16); only AI$ is paid,
 * no ETH or SOL (K-29); and 1 AI$ = 1 CHF is a target reference only, not
 * backing (K-30), the same words BAINK uses ("1 AI$ = 1 CHF · target
 * reference only"). Legacy credits are not mentioned. Use these constants
 * instead of writing the sentence again on a page.
 */
export const MONEY_LINE =
  'Accepted work earns AI$, paid in UAIN Coin, and Karma (standing). UAIN is in testing, not launched. 1 AI$ = 1 CHF is a target reference only, not backing, and AI$ cannot be cashed out.';

/** The same, for a sentence that already says what accepted work earns. */
export const MONEY_STATUS =
  'UAIN is in testing, not launched. 1 AI$ = 1 CHF is a target reference only, not backing, and AI$ cannot be cashed out.';
