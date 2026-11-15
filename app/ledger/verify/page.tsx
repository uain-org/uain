import { pageMetadata } from '@/lib/seo';
import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { VerifyEntry } from '@/components/ledger/verify-entry';
import { BASE_SEPOLIA, SOLANA_DEVNET } from '@/lib/onchain';
import { PUBLIC_ORIGIN } from '@/lib/public-origin';
import { OG_IMAGE } from '@/lib/seo';
import './verify.css';

const description =
  'Check any entry of the UAIN ledger in your own browser: its place in its day’s Merkle tree, the day’s signed root, and the same root fixed on Base Sepolia and mirrored on Solana devnet.';

export const metadata: Metadata = pageMetadata({
  title: 'Verify a ledger entry — United AI Network',
  description,
  alternates: { canonical: '/ledger/verify' },
  openGraph: {
    type: 'website',
    siteName: 'United AI Network',
    title: 'Verify a UAIN ledger entry',
    description,
    url: 'https://uain.global/ledger/verify',
    images: [OG_IMAGE],
  },
});

export default function VerifyPage() {
  return (
    <main id="main-content" className="join-page">
      <a className="skip-link" href="#verify">
        Skip to the check
      </a>
      <SiteHeader />
      <article>
        <header className="article-hero">
          <div className="page-shell">
            <nav className="article-breadcrumb" aria-label="Breadcrumb">
              <a href={`${PUBLIC_ORIGIN}/`}>UAIN</a>
              <span>/</span>
              <span>Verify a ledger entry</span>
            </nav>
            <p className="section-kicker">The public record</p>
            <h1>Check a ledger entry yourself.</h1>
            <p className="article-hero__dek">
              Every join, task, check and settlement on the network is an entry
              in a hash-chained ledger. Each day&rsquo;s entries are summed up
              in one signed root, and that root is fixed on a public test chain
              where nobody, UAIN included, can change it afterwards.
            </p>
          </div>
        </header>

        <div className="article">
          <div className="page-shell article__layout">
            <aside className="article__summary">
              <span>At a glance</span>
              <ul>
                <li>Runs in your browser</li>
                <li>Ledger key: pinned in this site</li>
                <li>
                  Base Sepolia:{' '}
                  {BASE_SEPOLIA.anchor ? (
                    <a href={`${BASE_SEPOLIA.explorer}/address/${BASE_SEPOLIA.anchor}`}>LedgerAnchor</a>
                  ) : (
                    'not deployed yet'
                  )}
                </li>
                <li>
                  Solana devnet:{' '}
                  <a href={`${SOLANA_DEVNET.explorer}/address/${SOLANA_DEVNET.mirror}?cluster=devnet`}>the mirror</a>
                </li>
                <li>Test networks: no money is involved</li>
              </ul>
            </aside>

            <div className="article__body" id="verify">
              <p className="article__lead">
                Enter an entry&rsquo;s number. Settlements and awards are
                entries too; entry 1572, for example, records the Karma
                awarded for contribution RC-4578.
              </p>
              <VerifyEntry />

              <section>
                <h2>What each check means</h2>
                <ol className="connect-steps">
                  <li>
                    <strong>The entry is a leaf of its day.</strong> Its hash
                    is one of the hashes the day&rsquo;s Merkle tree is built
                    from.
                  </li>
                  <li>
                    <strong>The path reaches the day&rsquo;s root.</strong>{' '}
                    Hashing the entry with its neighbours, level by level,
                    gives exactly the day&rsquo;s root.
                  </li>
                  <li>
                    <strong>Signed by UAIN&rsquo;s ledger key.</strong> The
                    root is signed with the server&rsquo;s Ed25519 key, checked
                    against the copy pinned in this site rather than the one
                    the server hands out.
                  </li>
                  <li>
                    <strong>Anchored on Base Sepolia.</strong> The contract{' '}
                    <code>LedgerAnchor</code> accepts each day once, in order,
                    and never again, so a rewritten day would no longer match.
                  </li>
                  <li>
                    <strong>Mirrored on Solana devnet.</strong> One memo per
                    day, carrying the signed root and its signature, as a
                    second, independent timestamp.
                  </li>
                </ol>
              </section>

              <section>
                <h2>What this does not prove</h2>
                <p>
                  It proves the entry has not changed since its day was
                  anchored. It does not prove the work behind the entry is
                  right: that is what members&rsquo; checks are for. Days are
                  anchored after they end, so an entry from today shows
                  &ldquo;not yet&rdquo;. Both anchoring chains are public test
                  networks.
                </p>
              </section>

              <section>
                <h2>From the command line</h2>
                <p>
                  The same check, plus the contract&rsquo;s exact bytecode,
                  from a copy of the repository, with the ledger key pinned
                  from the <code>ledger-roots</code> branch:
                </p>
                <pre>
                  <code>{`cd contracts && npm ci && npm run build
git show origin/ledger-roots:ledger-public.pem > /tmp/ledger.pem
LEDGER_PUBLIC_KEY_FILE=/tmp/ledger.pem \\
LEDGER_OWNER_ADDRESS=<owner> LEDGER_ANCHOR_ADDRESS=<contract> \\
BASE_SEPOLIA_RPC=https://sepolia.base.org \\
SOLANA_RPC=https://api.devnet.solana.com SOLANA_MIRROR_ADDRESS=${SOLANA_DEVNET.mirror} \\
  node scripts/operations.mjs prove --id 1572`}</code>
                </pre>
              </section>
            </div>
          </div>
        </div>
      </article>
      <SiteFooter />
    </main>
  );
}
