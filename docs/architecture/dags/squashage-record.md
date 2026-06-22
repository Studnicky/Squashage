---
title: Per-record DAG (squashage:record)
---

# Per-record DAG (squashage:record)

```mermaid
flowchart TB
  %% squashage:record (v1.0)
  record-init
  record-init[record-init]
  record-init -->|done| json-read
  json-read[json-read]
  json-read -->|loaded| classify_discriminator
  json-read -->|quarantined| record-quarantine
  classify_discriminator[classify:discriminator]
  classify_discriminator -->|proposed| classify_source
  classify_discriminator -->|no-match| classify_source
  classify_source[classify:source]
  classify_source -->|proposed| classify_url-pattern
  classify_source -->|no-match| classify_url-pattern
  classify_url-pattern[classify:url-pattern]
  classify_url-pattern -->|proposed| classify_structural
  classify_url-pattern -->|no-match| classify_structural
  classify_structural[classify:structural]
  classify_structural -->|proposed| classify_rules
  classify_structural -->|no-match| classify_rules
  classify_rules[classify:rules]
  classify_rules -->|proposed| classify_schema
  classify_rules -->|no-match| classify_schema
  classify_schema[classify:schema]
  classify_schema -->|proposed| classify_shacl-shape
  classify_schema -->|no-match| classify_shacl-shape
  classify_shacl-shape[classify:shacl-shape]
  classify_shacl-shape -->|proposed| classify_property-fingerprint
  classify_shacl-shape -->|no-match| classify_property-fingerprint
  classify_property-fingerprint[classify:property-fingerprint]
  classify_property-fingerprint -->|proposed| classify_winknlp-entities
  classify_property-fingerprint -->|no-match| classify_winknlp-entities
  classify_winknlp-entities[classify:winknlp-entities]
  classify_winknlp-entities -->|proposed| classify_ontology
  classify_winknlp-entities -->|no-match| classify_ontology
  classify_ontology[classify:ontology]
  classify_ontology -->|validated| classify_taxonomic-narrowing
  classify_ontology -->|no-match| classify_taxonomic-narrowing
  classify_taxonomic-narrowing[classify:taxonomic-narrowing]
  classify_taxonomic-narrowing -->|narrowed| record-health-gate
  classify_taxonomic-narrowing -->|no-op| record-health-gate
  record-health-gate[record-health-gate]
  record-health-gate -->|has-proposals| classify-conflict
  record-health-gate -->|generic-fallback| squash
  record-health-gate -->|errors| record-quarantine
  classify-conflict[classify-conflict]
  classify-conflict -->|resolved| squash
  classify-conflict -->|tie| record-quarantine
  classify-conflict -->|unknown| record-quarantine
  squash[squash]
  squash -->|squashed| output-provenance
  squash -->|quarantined| record-quarantine
  output-provenance[output-provenance]
  output-provenance -->|written| end
  output-provenance -->|skipped| end
  record-quarantine[record-quarantine]
  record-quarantine -->|recorded| end
  end(((end)))
```
