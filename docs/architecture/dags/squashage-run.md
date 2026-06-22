---
title: Run-scope DAG (squashage:run)
---

# Run-scope DAG (squashage:run)

```mermaid
flowchart TB
  %% squashage:run (v1.0)
  walk-input
  walk-input[walk-input]
  walk-input -->|walked| process-all-records
  walk-input -->|empty| rdfjs-finalize
  process-all-records[/process-all-records/]
  process-all-records -->|all-success| enrich-entity-link
  process-all-records -->|partial| enrich-entity-link
  process-all-records -->|all-error| rdfjs-finalize
  process-all-records -->|empty| rdfjs-finalize
  enrich-entity-link[enrich-entity-link]
  enrich-entity-link -->|enriched| ontology-emit
  enrich-entity-link -->|skipped| ontology-emit
  ontology-emit[ontology-emit]
  ontology-emit -->|emitted| rdfjs-finalize
  ontology-emit -->|skipped| rdfjs-finalize
  ontology-emit -->|error| rdfjs-finalize
  rdfjs-finalize[rdfjs-finalize]
  rdfjs-finalize -->|written| catalog-emit
  rdfjs-finalize -->|empty| run-end
  catalog-emit[catalog-emit]
  catalog-emit -->|emitted| run-end
  catalog-emit -->|skipped| run-end
  run-end(((run-end)))
```
