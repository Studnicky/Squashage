import { defineConfig } from 'vitepress';
import { themeConfig } from './theme.config.js';

const sidebar = [
  {
    text: 'Introduction',
    items: [
      { link: '/getting-started', text: 'Getting Started' },
      { link: '/walk-through',    text: 'Walk-through' },
    ]
  },
  {
    text: 'Usage',
    items: [
      { link: '/usage/configuration',      text: 'Configuration' },
      { link: '/usage/pipeline',           text: 'Pipeline' },
      { link: '/usage/classifier-cascade', text: 'Classifier cascade' },
      { link: '/usage/output',             text: 'Output' },
      { link: '/usage/viz',                text: 'Viz' },
      { link: '/usage/plugins',            text: 'Plugins' },
    ]
  },
  {
    text: 'Reference',
    items: [
      { link: '/architecture',           text: 'Architecture' },
      { link: '/classification-engines', text: 'Classifier engines (deep dive)' },
    ]
  },
  {
    text: 'Demo',
    items: [
      { link: '/examples/aonprd', text: 'Pathfinder/AONPRD graph' }
    ]
  },
];

export default defineConfig({
  appearance: themeConfig.appearance,
  base: '/Squashage/',
  description: 'Graph reconstitution pipeline; squashes JSON records into deterministic RDF graphs. Consumes output from Ripperoni or other JSON sources.',
  srcDir: '.',
  srcExclude: ['plans/**', 'plans/*.md'],
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/Squashage/squashage.png' }],
  ],
  themeConfig: {
    ...themeConfig,
    logo: '/squashage.png',
    siteTitle: 'Squashage',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Walk-through', link: '/walk-through' },
      { text: 'Demo', link: '/examples/aonprd' },
      { text: 'GitHub', link: 'https://github.com/Studnicky/Squashage' }
    ],
    sidebar,
    socialLinks: [{ icon: 'github', link: 'https://github.com/Studnicky/Squashage' }]
  },
  title: 'Squashage'
});
