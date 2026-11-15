/* Static export uses full-page links: live project aliases are served by nginx’s shared shell. */
/* eslint-disable @next/next/no-html-link-for-pages */
import { ArrowUpRight } from 'lucide-react';
import { projectArtwork } from '@/lib/projects/artwork';
import Image from 'next/image';
import './interest-form.css';

export function ProjectSupport({ projectId }: { projectId: string }) {
  const art = projectArtwork[projectId];
  return (
    <aside className="project-support">
      {art && (
        <figure className="project-support__art">
          <Image
            unoptimized
            src={art.src}
            alt={art.alt}
            width={1536}
            height={1024}
          />
        </figure>
      )}
      <div className="project-support__body">
        <span className="support-eyebrow">Move research forward</span>
        <h2>Support this project</h2>
        <a
          className="button button--primary"
          href={`/support?project=${encodeURIComponent(projectId)}`}
        >
          Donate <ArrowUpRight size={17} aria-hidden="true" />
        </a>
      </div>
    </aside>
  );
}
