/**
 * Where the fixed SSH transports connect, from the service's private environment
 * (/etc/baink.env), so that no server address is written in the code.
 *
 * BAINK_REVIEW_SSH_TARGET  user@host for the review and native-state transports.
 *
 * The value is checked strictly and never guessed. A missing or malformed value fails the one
 * call that needs it (not the service). The host key stays pinned by the transports' own
 * UserKnownHostsFile with StrictHostKeyChecking, so a changed value cannot reach an unknown host.
 */
const USER_AT_HOST = /^[a-z_][a-z0-9_-]{0,31}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
export const HOST_ALIAS = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

export function reviewSshTarget(value = process.env.BAINK_REVIEW_SSH_TARGET) {
  if (typeof value !== 'string' || !USER_AT_HOST.test(value)) throw Error('baink_review_ssh_target_not_configured');
  return value;
}
