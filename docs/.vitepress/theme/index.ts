import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';

import './palette.css';
import './base.css';

import ClassifierCard from './components/ClassifierCard.vue';
import DagDiagram from './components/DagDiagram.vue';

export const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp({ app }): void {
    app.component('ClassifierCard', ClassifierCard);
    app.component('DagDiagram', DagDiagram);
  },
};

export default theme;
