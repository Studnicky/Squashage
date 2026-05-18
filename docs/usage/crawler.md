---
layout: doc
title: Crawler
description: LinkLister — Squashage's recursive link crawler. Follows links from starting URLs, filters by three configurable regexes, and returns the matching URL set for a scraper to process.
---

# Crawler

`LinkLister` recursively follows links from one or more starting URLs and returns the set of URLs that match your target pattern. It doesn't scrape content — it builds a URL list. You hand that list to a scraper.

## Three regexes

```json
{
  "crawlers": {
    "aonprd-feats": {
      "startUrls": ["https://2e.aonprd.com/Feats.aspx"],
      "domain":    "2e\\.aonprd\\.com",
      "delimiter": "Feats\\.aspx",
      "target":    "Feats\\.aspx\\?ID=\\d+",
      "maxPages":  500
    }
  }
}
```

| Regex | Role | Effect |
|-------|------|--------|
| `domain` | Scope filter | Links must match to be considered at all. Prevents the crawler from following links off-domain. |
| `delimiter` | Traversal filter | Links matching `domain` AND `delimiter` are followed (added to the frontier). Others are ignored. |
| `target` | Collection filter | Links matching `domain` AND `delimiter` AND `target` are collected as results. |

In the example above:
- Any link to a different domain is ignored.
- Links to `Feats.aspx` (without query string) are traversed — they're list pages.
- Links to `Feats.aspx?ID=\d+` are collected — they're detail pages.
- The starting URL itself is traversed first.

## Visited and collected sets

Two internal sets track state:
- `#visited` — URLs already traversed (prevents loops).
- `#collected` — URLs matched as results.

A URL can be traversed without being collected. The crawler follows list pages but only hands back detail pages.

## Concurrency

All traversals at a given depth level run concurrently via `Promise.all`. Depth-first is not guaranteed — the crawler processes all frontier URLs in parallel before moving to the next level.

`rateLimitMs` and `jitterMs` apply per request, same as scrapers.

## maxPages

```json
"maxPages": 500
```

Hard ceiling on collected results. The crawl stops when this many URLs have been matched as results, even if there are more frontier URLs to follow.

## Deduplication and sorting

Results are deduplicated automatically — the same URL appearing at multiple traversal depths is collected once.

Sorting uses a numeric-aware collator: `Item-10` sorts after `Item-9`, not between `Item-1` and `Item-2`. Consistent ordering makes the output list diff-able.

## Inline crawler vs top-level crawler

Two ways to configure a crawler:

**Top-level** (`crawlers` block) — runs as a standalone job, produces a URL list:

```json
{
  "crawlers": {
    "aonprd-feats": {
      "startUrls": ["https://2e.aonprd.com/Feats.aspx"],
      "domain":    "2e\\.aonprd\\.com",
      "delimiter": "Feats\\.aspx",
      "target":    "Feats\\.aspx\\?ID=\\d+",
      "maxPages":  500
    }
  }
}
```

**Inline** (`targets[].crawler`) — the scrape target crawls before it fetches:

```json
{
  "targets": {
    "aonprd": {
      "baseUrl":  "https://2e.aonprd.com",
      "pipeline": ["html:fetch", "aonprd:parse", "json:write"],
      "crawler": {
        "startUrls": ["https://2e.aonprd.com/Feats.aspx"],
        "domain":    "2e\\.aonprd\\.com",
        "delimiter": "Feats\\.aspx",
        "target":    "Feats\\.aspx\\?ID=\\d+",
        "maxPages":  500
      }
    }
  }
}
```

In the inline case, the orchestrator runs the crawler first, then scrapes each collected URL through the target pipeline.

## Related

- [Configuration](./configuration) — crawler config schema
- [Scrapers](./scrapers) — what happens after the crawler hands back URLs
- [Cache](./cache) — crawler requests go through the rate limiter but not the cache
