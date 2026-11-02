// Labels, order and grouping live here, independently of content filenames/titles.
export const sidebar = [
  { label: 'Home', link: '/' },
  {
    label: 'Watch together',
    items: [
      { slug: 'product', label: 'All guides' },
      { slug: 'product/first-watch-party', label: 'Your first watch party' },
      { slug: 'product/user-guide', label: 'Room controls' },
      'product/features',
      'product/overview',
      'product/faq',
    ],
  },
  {
    label: 'Install and maintain',
    collapsed: true,
    items: [
      { slug: 'operations', label: 'Installation guides' },
      { slug: 'operations/owpctl', label: 'Guided setup' },
      'operations/installation',
      'operations/compatibility',
      'operations/configuration',
      'operations/deployment',
      'operations/security',
      'operations/troubleshooting',
      'operations/monitoring',
      'operations/plugin-updates',
    ],
  },
  {
    label: 'Developers',
    collapsed: true,
    items: [
      { slug: 'developers', label: 'Developer hub' },
      {
        label: 'Technical reference',
        collapsed: true,
        items: [
          { slug: 'technical', label: 'Reference overview' },
          'technical/architecture',
          'technical/protocol',
          'technical/server',
          'technical/client',
          'technical/client-state',
          'technical/plugin',
          'technical/sync',
          'technical/api',
          'technical/jellyfin-syncplay-reference',
          'technical/glossary',
        ],
      },
      {
        label: 'Contribute',
        collapsed: true,
        items: [
          { slug: 'development', label: 'Contribution overview' },
          'development/setup',
          'development/testing',
          'development/contributing',
          'development/ci',
          'development/release',
          'development/file-transformation-integration',
        ],
      },
    ],
  },
];

export const fontHead = [
  { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
  { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' } },
  { tag: 'link', attrs: { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&family=Manrope:wght@500;600;700;800&display=swap' } },
];
