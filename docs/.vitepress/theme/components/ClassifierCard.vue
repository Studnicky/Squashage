<script setup lang="ts">
/**
 * ClassifierCard — uniform per-classifier summary block.
 *
 * Props match the columns of the cascade table so the cascade page renders
 * the ten classifiers via repeated <ClassifierCard ... /> instead of a fragile
 * markdown table.
 */
defineProps<{
  /** Registered node name (e.g. `classify:url-pattern`). */
  name: string;
  /** Config slot under `targets[].classification.<slot>`. */
  slot: string;
  /** Where in the DAG: 'parallel' or 'sequential'. */
  placement: 'parallel' | 'sequential';
  /** Default proposal priority. */
  priority: number;
  /** Outputs the node declares (`'proposed' | 'no-match'`, etc.). */
  outputs: readonly string[];
  /** One-sentence summary of the engine. */
  engine: string;
  /** Link to the detail page (relative). */
  href?: string;
}>();
</script>

<template>
  <article class="classifier-card">
    <header class="classifier-card__head">
      <code class="classifier-card__name">{{ name }}</code>
      <span class="classifier-card__placement" :data-kind="placement">{{ placement }}</span>
    </header>
    <p class="classifier-card__engine">{{ engine }}</p>
    <dl class="classifier-card__meta">
      <div><dt>slot</dt> <dd><code>classification.{{ slot }}</code></dd></div>
      <div><dt>priority</dt> <dd>{{ priority }}</dd></div>
      <div><dt>outputs</dt> <dd>{{ outputs.join(' | ') }}</dd></div>
    </dl>
    <p v-if="href" class="classifier-card__more"><a :href="href">configuration →</a></p>
  </article>
</template>

<style scoped>
.classifier-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 1rem 1.25rem;
  margin: 0.5rem 0;
  background: var(--vp-c-bg-soft);
}
.classifier-card__head {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.25rem;
}
.classifier-card__name {
  font-weight: 600;
  font-size: 1rem;
  color: var(--vp-c-brand-1);
}
.classifier-card__placement {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-2);
}
.classifier-card__placement[data-kind='parallel'] {
  background: rgba(139, 95, 191, 0.18);
  color: var(--vp-c-brand-1);
}
.classifier-card__placement[data-kind='sequential'] {
  background: rgba(255, 165, 0, 0.18);
  color: #d97706;
}
.classifier-card__engine {
  margin: 0.25rem 0 0.6rem;
  color: var(--vp-c-text-1);
}
.classifier-card__meta {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.25rem 1rem;
  font-size: 0.875rem;
}
.classifier-card__meta div { display: flex; gap: 0.5rem; }
.classifier-card__meta dt { color: var(--vp-c-text-2); font-weight: 500; }
.classifier-card__meta dd { margin: 0; color: var(--vp-c-text-1); }
.classifier-card__meta code { font-size: 0.8125rem; }
.classifier-card__more { margin: 0.5rem 0 0; font-size: 0.875rem; }
</style>
