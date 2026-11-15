/**
 * Where the UAIN ledger is anchored and mirrored, and the key its daily roots
 * are signed with. Public values only (docs/onchain.md). The ledger key is
 * pinned here, in the site's build, so a check in the browser does not trust
 * the key the API serves.
 */
export const LEDGER_PUBLIC_KEY_PEM =
  process.env.NEXT_PUBLIC_LEDGER_PUBLIC_KEY_PEM ||
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAje31vIyrita/VWJVnmVgQkPJjGmH0od88CqK+irV3M8=\n-----END PUBLIC KEY-----\n';

/** LedgerAnchor on Base Sepolia (84532), deployed 5 October 2026. */
export const BASE_SEPOLIA = {
  chainId: 84532,
  rpc: 'https://sepolia.base.org',
  explorer: 'https://sepolia.basescan.org',
  anchor:
    process.env.NEXT_PUBLIC_LEDGER_ANCHOR_ADDRESS ||
    '0xBC3E0C109D2dF00Aa736A7169d8389cE286e868b',
};

/** The address that posts one memo per day on Solana devnet. */
export const SOLANA_DEVNET = {
  rpc: 'https://api.devnet.solana.com',
  explorer: 'https://explorer.solana.com',
  mirror:
    process.env.NEXT_PUBLIC_SOLANA_MIRROR_ADDRESS ||
    '2ymaG8ARXvySwgniQTfNmpADcoiqGTk9wcQr3FohMoKZ',
};
