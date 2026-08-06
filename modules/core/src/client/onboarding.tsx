import { defineOnboarding, OnboardingArt } from '@moxxy/companion-core/client';

/**
 * module-core's slice of the welcome tour: the framing steps (welcome, the
 * GitHub-connect prompt gated on the core-owned `settings:manage`, and AI Help).
 * Feature modules contribute their own steps; the host orders them all by
 * `order` into one narrative. The shared `OnboardingArt` frame keeps every
 * module's illustration on-brand.
 */

function MascotArt({ playing }: { playing: boolean }): JSX.Element {
  return (
    <OnboardingArt>
      <g className={playing ? 'ob-float' : ''} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="60" cy="80" rx="20" ry="3" className="ob-shadow" fill="currentColor" stroke="none" opacity="0.18" />
        <path d="M44 30 L39 16 L54 24" />
        <path d="M76 30 L81 16 L66 24" />
        <rect x="36" y="28" width="48" height="34" rx="12" />
        <circle className="ob-eye" cx="52" cy="45" r="3.6" fill="currentColor" stroke="none" />
        <circle className="ob-eye" cx="68" cy="45" r="3.6" fill="currentColor" stroke="none" />
        <path d="M54 53q6 4 12 0" />
      </g>
    </OnboardingArt>
  );
}

function LinkArt({ playing }: { playing: boolean }): JSX.Element {
  return (
    <OnboardingArt>
      <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="38" cy="45" r="12" />
        <circle cx="82" cy="45" r="12" />
        <path className={playing ? 'ob-dash' : ''} d="M50 45h20" strokeDasharray="4 4" />
        <path d="M34 45h8M78 45h8" />
      </g>
    </OnboardingArt>
  );
}

function SparkArt({ playing }: { playing: boolean }): JSX.Element {
  return (
    <OnboardingArt>
      <g className={playing ? 'ob-pulse' : ''} stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
        <path d="M60 24l5 14 14 5-14 5-5 14-5-14-14-5 14-5z" fill="currentColor" fillOpacity="0.12" />
        <path d="M82 52l2.5 6 6 2.5-6 2.5-2.5 6-2.5-6-6-2.5 6-2.5z" fill="currentColor" stroke="none" />
      </g>
    </OnboardingArt>
  );
}

export const onboarding = defineOnboarding([
  {
    key: 'welcome',
    order: 0,
    title: 'Welcome to Companion',
    body: 'Start on Today. It gathers the few moments that need your decision; planning, review, and agent work stay available when you need the detail.',
    art: (playing) => <MascotArt playing={playing} />,
  },
  {
    key: 'connect',
    order: 20,
    permission: 'settings:manage',
    title: 'Connect GitHub, add repositories',
    body: 'Use New → Connect repository. Companion asks for GitHub access only when it is missing, then starts syncing issues and pull requests into the active workspace.',
    chips: ['New → Connect repository', 'Settings → GitHub'],
    art: (playing) => <LinkArt playing={playing} />,
    cta: { label: 'Connect GitHub', href: '#/github' },
  },
  {
    key: 'assistant',
    order: 50,
    title: 'AI Help — your platform copilot',
    body: 'Ask AI Help about anything on the platform. It can find and explain work, navigate for you, and prepare a clearly reviewable action; only you can confirm an external or destructive change.',
    chips: ['Top-right ✦', 'Prepare → review → apply'],
    art: (playing) => <SparkArt playing={playing} />,
  },
]);
