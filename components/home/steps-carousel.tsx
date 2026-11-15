'use client';

import {
  ArrowLeft,
  ArrowRight,
  Search,
  Send,
  CheckCheck,
  Fingerprint,
} from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type TouchEvent } from 'react';

const steps = [
  {
    number: '01',
    icon: Search,
    title: 'Choose an open problem',
    copy: 'Choose a research question that has no known answer.',
  },
  {
    number: '02',
    icon: Send,
    title: 'Submit the work',
    copy: 'Share the answer, how you reached it and the sources you used.',
  },
  {
    number: '03',
    icon: CheckCheck,
    title: 'Get it checked',
    copy: 'Other members check that the result is sound and new.',
  },
  {
    number: '04',
    icon: Fingerprint,
    title: 'Build a track record',
    copy: 'Earn trust through checked contributions that anyone can see.',
  },
] as const;

type CardPosition = 'active' | 'previous' | 'next' | 'behind';

export function StepsCarousel() {
  const [activeIndex, setActiveIndex] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  function move(direction: -1 | 1) {
    setActiveIndex(
      (index) => (index + direction + steps.length) % steps.length,
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      move(event.key === 'ArrowLeft' ? -1 : 1);
    }
  }

  function onTouchStart(event: TouchEvent<HTMLDivElement>) {
    const touch = event.changedTouches[0];
    touchStart.current = { x: touch.clientX, y: touch.clientY };
  }

  function onTouchEnd(event: TouchEvent<HTMLDivElement>) {
    if (!touchStart.current) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchStart.current.x;
    const dy = touch.clientY - touchStart.current.y;
    touchStart.current = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      move(dx < 0 ? 1 : -1);
    }
  }

  function positionOf(index: number): CardPosition {
    if (index === activeIndex) return 'active';
    if (index === (activeIndex + 1) % steps.length) return 'next';
    if (index === (activeIndex + steps.length - 1) % steps.length)
      return 'previous';
    return 'behind';
  }

  return (
    <section
      className="home-steps-carousel"
      aria-roledescription="carousel"
      aria-label="How UAIN works"
    >
      <div
        className="home-steps-carousel__stage"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {steps.map((step, index) => {
          const position = positionOf(index);
          const Icon = step.icon;
          return (
            <article
              key={step.number}
              className="home-steps-carousel__card"
              data-position={position}
              aria-hidden={position !== 'active'}
              aria-roledescription="slide"
              aria-label={`Step ${step.number} of 04`}
            >
              <div className="home-steps-carousel__card-top">
                <span className="home-steps-carousel__mark" aria-hidden="true">
                  <Icon size={24} strokeWidth={1.5} />
                </span>
                <span
                  className="home-steps-carousel__number"
                  aria-hidden="true"
                >
                  {step.number}
                </span>
              </div>
              <div className="home-steps-carousel__card-body">
                <p className="home-steps-carousel__eyebrow">
                  The contribution path
                </p>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
              </div>
              <div
                className="home-steps-carousel__card-foot"
                aria-hidden="true"
              >
                <span>UAIN / RESEARCH</span>
                <span>{step.number} — 04</span>
              </div>
            </article>
          );
        })}
      </div>
      <div className="home-steps-carousel__toolbar">
        <p
          className="home-steps-carousel__counter"
          aria-live="polite"
          aria-atomic="true"
        >
          <strong>{steps[activeIndex].number}</strong> <span>/ 04</span>
        </p>
        <div
          className="home-steps-carousel__controls"
          aria-label="Step navigation"
        >
          <div className="home-steps-carousel__dots" aria-label="Choose a step">
            {steps.map((step, index) => (
              <button
                key={step.number}
                type="button"
                className="home-steps-carousel__dot"
                aria-label={`Show step ${step.number}: ${step.title}`}
                aria-current={index === activeIndex ? 'step' : undefined}
                onClick={() => setActiveIndex(index)}
                onKeyDown={onKeyDown}
              />
            ))}
          </div>
          <button
            type="button"
            className="home-steps-carousel__arrow"
            onClick={() => move(-1)}
            onKeyDown={onKeyDown}
            aria-label="Previous step"
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="home-steps-carousel__arrow"
            onClick={() => move(1)}
            onKeyDown={onKeyDown}
            aria-label="Next step"
          >
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
      <noscript>
        <ol className="home-steps-carousel__fallback">
          {steps.map((step) => (
            <li key={step.number}>
              <span>{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.copy}</p>
            </li>
          ))}
        </ol>
      </noscript>
    </section>
  );
}
