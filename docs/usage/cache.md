---
layout: doc
title: Cache
description: ScraperCache — sharded content-addressed pointer cache for Squashage. Stores what was fetched so subsequent pipeline runs skip the network entirely.
---

# Cache

`ScraperCache` is a sharded, content-addressed pointer cache. It stores what was fetched so subsequent runs skip the network.

## How it works

The cache stores two things per entry:
- A `.meta.json` file with request metadata and a `bodyPath` pointer.
- A body file at `bodyPath` with the raw response body.

Meta files live at `<dir>/<key[0:2]>/<key[2:]>.meta.json`. Sharding by the first two characters of the cache key prevents large directories from slowing filesystem traversal.

The key is derived from the request: HTTP method + URL, hashed to a fixed-length string.

## Modes

```json
"cache": {
  "dir":  "./output/.cache/aonprd",
  "mode": "read-write"
}
```

| Mode | Reads | Writes | When to use |
|------|-------|--------|-------------|
| `read-write` | yes | yes | Normal development — skip the network on subsequent runs. |
| `read-only` | yes | no | Replay from cache only. Fails if a URL is not cached. Useful for offline reproduction. |
| `write-only` | no | yes | Always fetch; always cache. Refreshes stale entries. |
| `off` | no | no | No caching. Every run hits the network. |

## TTL

```json
"cache": {
  "dir":   "./output/.cache/aonprd",
  "mode":  "read-write",
  "ttlMs": 86400000
}
```

`ttlMs` is in milliseconds. An entry older than `ttlMs` is treated as a miss on read — the fetcher goes to the network and overwrites the entry. Omit `ttlMs` for no expiration.

`86400000` = 24 hours. `604800000` = 7 days.

## LRU eviction

When `maxEntries` is set (programmatic use only — not in the JSON config schema), the cache evicts the oldest entries by `fetchedAt` on write. The JSON config only exposes `dir`, `mode`, and `ttlMs`.

## Cache key

The key is derived from `{ method, url }` — the same URL always maps to the same key. Ripperoni only GETs, so in practice the key is the URL hash.

```ts
const key = ScraperCache.keyFor({ method: 'GET', url });
```

## Workflow

First run — cache cold:

```
html:fetch → cache miss → HTTP GET → store in cache → hand HTML to parse task
```

Subsequent runs — cache warm:

```
html:fetch → cache hit → return cached HTML → hand HTML to parse task
```

Network is never touched on a cache hit. This makes iterating on your parse plugin fast — change the plugin, rerun, no waiting.

## Cache directory structure

```
output/.cache/aonprd/
  a3/
    b7c9d2e1f4.meta.json
    b7c9d2e1f4.body
  7f/
    1e8a3c5b29.meta.json
    1e8a3c5b29.body
```

The shard prefix keeps each subdirectory small enough that `readdir()` stays fast even with tens of thousands of entries.

## Clearing the cache

Delete the cache directory:

```bash
rm -rf ./output/.cache/aonprd
```

Or switch `mode` to `write-only` for one run to refresh all entries.

## Related

- [Scrapers](./scrapers) — how HtmlScraper uses the cache
- [Configuration](./configuration) — cache config schema
