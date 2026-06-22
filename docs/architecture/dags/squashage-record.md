---
title: Per-record DAG (squashage:record)
---

# Per-record DAG (squashage:record)

```mermaid
flowchart TB
  %% squashage:record (v1.0)
  json-read
  json-read[json-read]
  json-read -->|loaded| squash
  json-read -->|quarantined| record-quarantine
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
