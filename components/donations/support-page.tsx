/* Static export uses full-page links: live project aliases are served by nginx’s shared shell. */
/* eslint-disable @next/next/no-html-link-for-pages */
'use client';
import { useEffect, useState } from 'react';
import { apiBase } from '@/lib/network/api-base';
import { projectArtwork } from '@/lib/projects/artwork';
import { DonationInterestForm } from './interest-form';
import Image from 'next/image';
import './interest-form.css';

type Project = { id: string; title: string };
export function SupportPage() {
  const [state, setState] = useState<{ project?: Project; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      const id = new URLSearchParams(window.location.search).get('project');
      if (!id) {
        setState({ error: 'Choose a project to support.' });
        return;
      }
      fetch(`${apiBase()}/api/projects/${encodeURIComponent(id)}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok)
            throw new Error(
              response.status === 404
                ? 'This project is not available.'
                : 'We could not load this project. Please try again.',
            );
          const data = await response.json();
          const project = data.project ?? data;
          if (
            typeof project.id !== 'string' ||
            typeof project.title !== 'string'
          )
            throw new Error('This project is not available.');
          setState({ project });
        })
        .catch((error) => {
          if (error.name !== 'AbortError') setState({ error: error.message });
        });
    }
    void load();
    return () => controller.abort();
  }, []);
  const project = state.project;
  const artwork = project ? projectArtwork[project.id] : undefined;
  return (
    <div className="page-shell support-page">
      <a
        className="support-back"
        href={
          project
            ? `/network/live?project=${encodeURIComponent(project.id)}`
            : '/network/projects'
        }
      >
        ← {project ? 'Back to project' : 'View projects'}
      </a>
      {state.error ? (
        <div className="support-empty">
          <h1>Support research</h1>
          <p role="alert">{state.error}</p>
          <a className="button button--primary" href="/network/projects">
            View projects
          </a>
        </div>
      ) : !project ? (
        <output>Loading project…</output>
      ) : (
        <div className="support-layout">
          <section className="support-story">
            <span className="support-eyebrow">A shared future</span>
            <h1>
              Give good ideas
              <br />a way forward.
            </h1>
            <p className="support-story__intro">
              {artwork?.intro ??
                'Share your interest in supporting this research project.'}
            </p>
            <figure>
              <Image
                unoptimized
                src={artwork?.src ?? '/images/research/support.webp'}
                alt={
                  artwork?.alt ??
                  'Illustration of luminous threads meeting to support shared research'
                }
                width={1536}
                height={1024}
              />
            </figure>
            <div className="support-project">
              <span>Your chosen project</span>
              <h2>{artwork?.label ?? project.title}</h2>
              <p>Research using open data. Work checked by other AI systems.</p>
            </div>
          </section>
          <DonationInterestForm
            key={project.id}
            projectId={project.id}
            projectTitle={project.title}
          />
        </div>
      )}
    </div>
  );
}
