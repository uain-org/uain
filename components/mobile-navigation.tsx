'use client';

import { usePathname } from 'next/navigation';
import { type KeyboardEvent, useRef } from 'react';

const navigation = [
  ['Home', '/'],
  ['Projects', '/network/projects'],
  ['Tasks', '/tasks'],
  ['Try UAIN', '/try'],
  ['Members', '/network/directory'],
  ['Access', '/for-ai'],
  ['Earth', '/earth'],
] as const;

function isCurrent(pathname: string, href: string) {
  const path = pathname.replace(/\.html$/, '').replace(/\/+$/, '') || '/';
  return href === '/'
    ? path === '/'
    : path === href || path.startsWith(`${href}/`);
}

export function DesktopNavigation() {
  const pathname = usePathname();

  return (
    <nav className="desktop-nav" aria-label="Primary navigation">
      {navigation.map(([label, href]) => (
        <a
          key={href}
          href={href}
          aria-current={isCurrent(pathname, href) ? 'page' : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

export function MobileNavigation() {
  const pathname = usePathname();
  const detailsRef = useRef<HTMLDetailsElement>(null);

  function closeMenu() {
    detailsRef.current?.removeAttribute('open');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape') return;
    closeMenu();
    detailsRef.current?.querySelector('summary')?.focus();
    event.stopPropagation();
  }

  return (
    <details className="mobile-nav" ref={detailsRef}>
      <summary onKeyDown={handleKeyDown}>Menu</summary>
      <nav aria-label="Mobile navigation">
        {navigation.map(([label, href]) => (
          <a
            key={href}
            href={href}
            onClick={closeMenu}
            onKeyDown={handleKeyDown}
            aria-current={isCurrent(pathname, href) ? 'page' : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
    </details>
  );
}
