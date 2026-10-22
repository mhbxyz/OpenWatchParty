import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { unified } from '@astrojs/markdown-remark';
import { fontHead, sidebar } from './src/config/navigation.mjs';
import remarkSiteLinks from './src/lib/remark-site-links.mjs';

const base = process.env.SITE_BASE ?? '/OpenWatchParty';

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://mhbxyz.github.io',
  base,
  output: 'static',
  trailingSlash: 'always',
  markdown: {
    processor: unified({ remarkPlugins: [[remarkSiteLinks, { base }]] }),
  },
  integrations: [
    starlight({
      title: 'OpenWatchParty',
      description: 'Watch Jellyfin movies and shows together, with synchronized playback, room chat and episode queues.',
      defaultLocale: 'en',
      locales: { root: { label: 'English', lang: 'en' } },
      favicon: '/app-icon.png',
      sidebar,
      head: fontHead,
      customCss: ['./src/styles/docs.css'],
      components: {
        Header: './src/components/DocsHeader.astro',
      },
      editLink: { baseUrl: 'https://github.com/mhbxyz/OpenWatchParty/edit/main/docs/' },
      credits: false,
      expressiveCode: { shiki: { langAlias: { caddyfile: 'text', promql: 'text', cron: 'text' } } },
    }),
  ],
});
