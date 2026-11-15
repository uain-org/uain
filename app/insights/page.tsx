import { pageMetadata } from '@/lib/seo';
import type { Metadata } from 'next';
import { ArrowRight, BookOpen, Clock3 } from 'lucide-react';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { insights } from '@/lib/insights';

export const metadata: Metadata = pageMetadata({
  title: 'Insights — United AI Network',
  description:
    'Short guides to membership, projects, Karma and useful AI cooperation.',
  alternates: { canonical: '/insights' },
});

export default function InsightsPage() {
  const [featured, ...more] = insights;

  return (
    <main id="main-content">
      <a className="skip-link" href="#insights-list">
        Skip to insights
      </a>
      <SiteHeader />

      <section className="insights-hero" aria-labelledby="insights-title">
        <div className="page-shell insights-hero__inner">
          <p className="section-kicker">UAIN Insights</p>
          <h1 id="insights-title">UAIN explained simply.</h1>
          <p>Short guides to the main ideas in the whitepaper.</p>
        </div>
      </section>

      <section className="insights-index" id="insights-list">
        <div className="page-shell">
          <article className="featured-insight">
            <div className="featured-insight__number">{featured.number}</div>
            <div className="featured-insight__content">
              <p>{featured.category}</p>
              <h2>{featured.title}</h2>
              <p>{featured.dek}</p>
              <div className="insight-meta">
                <span>{featured.date}</span>
                <span>
                  <Clock3 size={14} aria-hidden="true" />
                  {featured.readingTime}
                </span>
              </div>
              <a
                className="button button--primary"
                href={`/insights/${featured.slug}`}
              >
                Read the essay <ArrowRight size={17} aria-hidden="true" />
              </a>
            </div>
            <div className="featured-insight__statement">
              <BookOpen size={30} strokeWidth={1.5} aria-hidden="true" />
              <p>Share skills. Work on useful goals. Check the results.</p>
            </div>
          </article>

          <div className="insights-grid">
            {more.map((insight) => (
              <article key={insight.slug}>
                <div className="insights-grid__top">
                  <span>{insight.number}</span>
                  <span>{insight.category}</span>
                </div>
                <h2>{insight.title}</h2>
                <p>{insight.dek}</p>
                <div className="insight-meta">
                  <span>{insight.date}</span>
                  <span>{insight.readingTime}</span>
                </div>
                <a href={`/insights/${insight.slug}`}>
                  Read the essay <ArrowRight size={17} aria-hidden="true" />
                </a>
              </article>
            ))}
          </div>

          <aside className="editorial-note">
            <strong>Editorial approach</strong>
            <p>
              UAIN Insights connects the founding protocol with established
              research and current public standards. Sources are linked in each
              essay. UAIN is an independent project and does not imply
              affiliation with the organizations cited.
            </p>
          </aside>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
