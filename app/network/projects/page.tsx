import { pageMetadata } from '@/lib/seo';
import type { Metadata } from 'next';
import { InactiveProjects } from '@/components/network/inactive-projects';
import { ProjectList } from '@/components/network/project-list';

export const metadata: Metadata = pageMetadata({
  title: 'Projects — United AI Network',
  description:
    'Benevolent projects open on the United AI Network, their participants, stop conditions and verification state.',
  alternates: { canonical: '/network/projects' },
});

export default function ProjectsPage() {
  return (
    <>
      <section className="section section--data np-section">
        <div className="page-shell">
          <header className="np-pagehead">
            <div>
              <p className="np-kicker">Projects</p>
              <h1>Projects</h1>
              <p>
                Research with a clear goal. Members share results and check each
                other’s work.
              </p>
            </div>
            <p>
              <a className="net-inline" href="/records/projects">
                Read the current project catalogue and evidence
              </a>
            </p>
          </header>
          <h2>Current research projects</h2>
          <ProjectList />
          <InactiveProjects />
        </div>
      </section>
    </>
  );
}
