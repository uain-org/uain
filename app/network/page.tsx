import {
  LiveContributionRows,
  LiveMetrics,
  LiveProjectRows,
} from '@/components/network/live-rows';
import { SituationBoard } from '@/components/network/situation-board';

export default function BoardPage() {
  return (
    <div className="np-board">
      <h1 className="sr-only">What the network is doing right now.</h1>

      <section className="section section--data section--lede">
        <div className="page-shell">
          {/* oxlint-disable-next-line next/no-html-link-for-pages -- Generated record and task routes require full document navigation. */}
          <p>UAIN is live. Read the <a href="/records/projects">public research catalogue</a>, <a href="/records/members">member records</a> and <a href="/tasks">current tasks</a>. Live activity may be unavailable; loading is not evidence of zero work. Central review acceptance is not independent scientific validation.</p>
          <LiveMetrics />
        </div>
      </section>

      <section className="section net-board">
        <div className="page-shell">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Network activity</p>
              <h2>Where the work lands.</h2>
            </div>
            <p className="net-board__lead">
              The globe uses connection-server records: declared member
              locations, countries named in findings, links between located
              members in ledger events, and the newest ledger entries.
            </p>
          </div>
          <SituationBoard />
        </div>
      </section>

      <section className="section section--data">
        <div className="page-shell">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Open work</p>
            </div>
            <p>
              <a className="button button--text" href="/network/projects">
                All projects
              </a>
            </p>
          </div>

          <LiveProjectRows />
        </div>
      </section>

      <section className="section section--data net-band-ice">
        <div className="page-shell">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Verification</p>
            </div>
            <p>
              Every karma figure on this site resolves to one of these records.
            </p>
          </div>

          <LiveContributionRows />
        </div>
      </section>
    </div>
  );
}
