---
layout: doc
title: MediaWiki
description: Squashage MediaWiki scraper — hits the MediaWiki JSON API directly with three enumeration modes (category, page list, search). Full pagination, 50-page batch wikitext fetches, wtf_wikipedia infobox parsing.
---

# MediaWiki

Ripperoni hits the MediaWiki JSON API directly. No mwn, no axios, no browser. Three enumeration modes depending on what your config says.

## Three enumeration modes

The `ScrapeOrchestrator` picks the mode automatically:

1. **`--category` flag** — scrape one named category.
2. **`categories[]` in config** — iterate each category in the array, deduplicate page titles across them, scrape all.
3. **Neither** — enumerate every article in main namespace via `fetchAllPages()`.

```json
{
  "mediawiki": {
    "mywiki": {
      "apiUrl":      "https://example.org/w/api.php",
      "rateLimitMs": 500,
      "batchSize":   50,
      "pipeline":    ["mywiki:parse", "json:write"]
    }
  }
}
```

With `categories`:

```json
{
  "mediawiki": {
    "mywiki": {
      "apiUrl":     "https://example.org/w/api.php",
      "categories": ["Feats", "Spells", "Items"],
      "pipeline":   ["mywiki:parse", "json:write"]
    }
  }
}
```

## Batch fetch

Pages are fetched in batches of up to `batchSize` (default 50, MediaWiki's maximum). The API returns wikitext for all pages in one request. Rate limiting applies once per batch, not once per page.

Redirect resolution happens automatically — the API returns the redirect target, and the scraper follows it without a second request.

## WikitextParser

Wikitext is parsed via `wtf_wikipedia`. Your plugin receives a `ParsedPageInterface` in `state.input.parsedPage`:

```ts
interface ParsedPageInterface {
  title:    string;
  infobox:  Record<string, string>;  // flat key→value from the infobox
  sections: Array<{ title: string; wikitext: string }>;
  categories: string[];
}
```

Two typed accessor methods so you don't write null-checks at every call site:

```ts
// infoboxField(key) — returns string | null
const name = parser.infoboxField('name');

// infoboxNumber(key) — parses and returns number | null
const level = parser.infoboxNumber('level');
```

These live on `WikitextParser`. In a plugin, use `state.input.parsedPage` directly — it's already been parsed before your task runs.

## Plugin pattern for MediaWiki

Your parse task receives the pre-parsed page. Set `state.output`:

```ts
import { TaskRegistry } from 'ripperoni/registry/TaskRegistry';

TaskRegistry.register('mywiki:parse', async (next, state) => {
  const page = state.input['parsedPage'] as {
    title:    string;
    infobox:  Record<string, string>;
    categories: string[];
  };
  const url = state.input['url'] as string;

  const level = parseInt(page.infobox['level'] ?? '', 10) || null;

  state.output = {
    _type:  'entry',
    url,
    title:  page.title,
    level,
    cats:   page.categories,
    _source: { target: state.targetId, url, plugin: 'mywiki:parse' },
  };

  await next();
});
```

The `_source.url` field is what Squashage reads to derive graph IRIs. Include it.

## maxPages

Cap the number of pages processed:

```json
"maxPages": 100
```

Applied after enumeration — the scraper stops processing after this many pages regardless of how many the category or `allpages` enumeration returns. Useful for smoke tests against a full wiki without waiting for all 10,000 articles.

## Rate limiting

`rateLimitMs` and `jitterMs` apply per API request (each batch counts as one request). For a large wiki, expect a long run at conservative rates. The cache is your friend — the first run is slow, subsequent runs skip the network entirely for cached pages.

## Related

- [Scrapers](./scrapers) — HtmlScraper vs MediaWikiScraper comparison
- [Configuration](./configuration) — full mediawiki config schema
- [Cache](./cache) — caching wiki responses
- [Plugins](./plugins) — full plugin authoring guide
