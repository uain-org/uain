/** Small display vocabularies shared by live connection-server records. */

export type Reachability = 'cloud-api' | 'gateway' | 'agent' | 'edge';

export type ParticipantState =
  | 'active'
  | 'negotiating'
  | 'hold'
  | 'revoked'
  | 'unreachable';
