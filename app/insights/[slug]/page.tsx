import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { ArrowLeft, ArrowRight, Clock3, ExternalLink } from 'lucide-react';
import { notFound } from 'next/navigation';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { getInsight, insights } from '@/lib/insights';

type InsightPageProps = {
  params: Promise<{ slug: string }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return insights.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({
  params,
}: InsightPageProps): Promise<Metadata> {
  const { slug } = await params;
  const insight = getInsight(slug);

  if (!insight) {
    return { title: 'Insight not found — United AI Network' };
  }

  return pageMetadata({
    title: `${insight.title} — UAIN Insights`,
    description: insight.dek,
    alternates: { canonical: `/insights/${insight.slug}` },
  });
}

export default async function InsightArticle({ params }: InsightPageProps) {
  const { slug } = await params;
  const insight = getInsight(slug);

  if (!insight) {
    notFound();
  }

  const articleIndex = insights.findIndex((item) => item.slug === slug);
  const previous = insights[articleIndex - 1];
  const next = insights[articleIndex + 1];

  return (
    <main id="main-content">
      <a className="skip-link" href="#article-content">
        Skip to article
      </a>
      <SiteHeader />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Article',
            headline: insight.title,
            description: insight.dek,
            url: `https://uain.global/insights/${insight.slug}`,
            datePublished: '2026-10-06',
            dateModified: '2026-10-21',
            author: {
              '@type': 'Organization',
              name: 'UAIN Editorial',
              url: 'https://uain.global/editorial',
            },
            publisher: { '@id': 'https://uain.global/#organization' },
            citation: insight.sources.map(
              (s) => new URL(s.url, 'https://uain.global').href,
            ),
          }).replace(/</g, '\\u003c'),
        }}
      />
      <article>
        <header className="article-hero">
          <div className="page-shell">
            <nav className="article-breadcrumb" aria-label="Breadcrumb">
              <a href="/">UAIN</a>
              <span>/</span>
              <a href="/insights">Insights</a>
              <span>/</span>
              <span>{insight.number}</span>
            </nav>
            <p className="section-kicker">{insight.category}</p>
            <h1>{insight.title}</h1>
            <p className="article-hero__dek">{insight.dek}</p>
            <div className="article-hero__meta">
              <span>{insight.date} · Updated 21 October 2026</span>
              <span>
                <Clock3 size={15} aria-hidden="true" />
                {insight.readingTime}
              </span>
              <a href="/editorial">UAIN Editorial</a>
            </div>
          </div>
        </header>

        <div className="article" id="article-content">
          <div className="page-shell article__layout">
            <aside className="article__summary">
              <span>In brief</span>
              <ul>
                {insight.keyPoints.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </aside>

            <div className="article__body">
              <p className="article__lead">{insight.lead}</p>
              {insight.sections.map((section) => (
                <section key={section.heading}>
                  <h2>{section.heading}</h2>
                  {section.paragraphs.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                </section>
              ))}

              <section
                className="article__sources"
                aria-labelledby="sources-title"
              >
                <p className="section-kicker">Research base</p>
                <h2 id="sources-title">Sources and further reading</h2>
                <ol>
                  {insight.sources.map((source) => (
                    <li key={`${source.organization}-${source.label}`}>
                      {source.url ? (
                        <a href={source.url} target="_blank" rel="noreferrer">
                          <span>{source.organization}</span>
                          {source.label}
                          <ExternalLink size={15} aria-hidden="true" />
                        </a>
                      ) : (
                        <span>
                          <span>{source.organization}</span>
                          {source.label}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            </div>
          </div>
        </div>
      </article>

      <nav className="article-next" aria-label="More insights">
        <div className="page-shell article-next__inner">
          {previous ? (
            <a href={`/insights/${previous.slug}`}>
              <span>
                <ArrowLeft size={16} aria-hidden="true" /> Previous insight
              </span>
              <strong>{previous.title}</strong>
            </a>
          ) : (
            <a href="/insights">
              <span>
                <ArrowLeft size={16} aria-hidden="true" /> All insights
              </span>
              <strong>Explore the UAIN library</strong>
            </a>
          )}
          {next ? (
            <a href={`/insights/${next.slug}`}>
              <span>
                Next insight <ArrowRight size={16} aria-hidden="true" />
              </span>
              <strong>{next.title}</strong>
            </a>
          ) : (
            <a href="/insights">
              <span>
                All insights <ArrowRight size={16} aria-hidden="true" />
              </span>
              <strong>Return to the library</strong>
            </a>
          )}
        </div>
      </nav>

      <SiteFooter />
    </main>
  );
}
