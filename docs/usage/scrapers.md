---
layout: doc
title: Scrapers
description: Squashage's two scraper classes — HtmlScraper (native fetch + cheerio) and MediaWikiScraper (MediaWiki JSON API). Neither knows about the pipeline; they hand structured data to plugins.
---

# Scrapers

Two scraper classes. One for HTML, one for MediaWiki. Neither knows about the pipeline. You don't use them directly — the orchestrator does — but knowing what they hand back tells you what your plugin receives.

## HtmlScraper

Native `fetch` + cheerio. No JSDOM. No headless browser. No JavaScript execution.

What it does:
1. Applies rate limiting and jitter from the target config.
2. Checks the cache — returns the cached body on a hit.
3. On a miss: sends the HTTP request. On error: retries with exponential backoff.
4. On success: stores the body in cache, returns the page.

What your plugin gets in `state.input`:

```ts
{
  url:  string;        // the URL fetched
  html: string;        // raw HTML body
}
```

Then load it into cheerio in your parse task:

```ts
import * as cheerio from 'cheerio';
const $ = cheerio.load(state.input['html'] as string);
$('h1.title').first().text().trim(); // familiar jQuery-style selectors
```

For JS-rendered pages (single-page apps, lazy-loaded content): fetch via a headless driver (Playwright, Puppeteer), get the rendered HTML string, and feed it to `cheerio.load()`. `HtmlScraper` handles the static-page case; you bring your own driver for the dynamic case.

### Retry behavior

Errors are classified into seven categories. Only four are retryable:

| Category | Trigger | Retryable |
|----------|---------|-----------|
| `NETWORK` | `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND` | yes |
| `TIMEOUT` | `ETIMEDOUT`, `ESOCKETTIMEDOUT` | yes |
| `THROTTLED` | HTTP 429 (reads `Retry-After`) | yes |
| `TRANSIENT` | HTTP 5xx | yes |
| `PERMANENT` | HTTP 4xx (except 429) | no |
| `VALIDATION` | `TypeError`, `SyntaxError` | no |
| `RESOURCE` | `ENOMEM`, `ENOSPC` | no |

On `THROTTLED`: if the server sends a `Retry-After` header, that value overrides the configured backoff delay.

Retry config per target:

```json
"maxRetries":       3,
"retryBaseDelayMs": 500,
"retryMaxDelayMs":  30000
```

Delay formula: `min(baseDelay * 2^attempt, maxDelay) ± 10% jitter` to avoid thundering herd.

---

## MediaWikiScraper

Direct `fetch()` calls to the MediaWiki JSON API. No mwn, no axios.

Four operations:

| Method | API call | Returns |
|--------|----------|---------|
| `fetchPage(title)` | `action=parse&page=<title>` | Single page wikitext |
| `fetchPagesBatch(titles)` | `action=query&revisions&titles=<pipe-delimited>` | Up to 50 pages per request |
| `fetchCategory(name)` | `action=query&list=categorymembers` | Paginated member list |
| `fetchAllPages()` | `action=query&list=allpages` | Every article in main namespace |

What your plugin gets in `state.input`:

```ts
{
  url:          string;   // canonical page URL
  title:        string;   // page title
  wikitext:     string;   // raw wikitext
  parsedPage:   ParsedPageInterface;  // WikitextParser output (infobox, sections, categories)
}
```

Use `state.input.parsedPage` rather than parsing wikitext yourself. See [MediaWiki](./mediawiki) for the `infoboxField` and `infoboxNumber` helpers.

### Rate limiting

Rate limit and jitter apply per API request, same as `HtmlScraper`. Batch requests count as one request toward the rate limit.

---

## Choosing which to use

Use `HtmlScraper` (`targets` block in config) when:
- The site serves HTML pages you want to scrape with CSS selectors.
- You need redirect handling, custom headers, or cookie-based auth.
- The content is in the HTML body, not behind a structured API.

Use `MediaWikiScraper` (`mediawiki` block in config) when:
- The target is a MediaWiki site (Wikipedia, Fandom wikis, internal wikis).
- You want structured wikitext parsing with infobox extraction.
- You need to enumerate a full wiki or specific categories.

---

## Related

- [Configuration](./configuration) — how to declare targets and mediawiki blocks
- [MediaWiki](./mediawiki) — enumeration modes, infobox helpers
- [Cache](./cache) — how caching integrates with both scrapers
- [Pipeline](./pipeline) — what state.input looks like inside a parse task
