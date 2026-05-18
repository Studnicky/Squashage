---
layout: doc
title: Roadmap
description: Squashage shipped features (v2.x) and planned work. A ground-up TypeScript rewrite of the 2019 PathRipper with a typed Pipeline, structured logger, and RDF graph output.
---

# Roadmap

v2.0.0 is a ground-up rewrite of the 2019 PathRipper. The core pipeline, HTML scraper, MediaWiki scraper, and link crawler are live.

## Shipped (v2.x)

| Feature | Status | Details |
|---------|--------|---------|
| TypeScript rewrite | live | Full strict TypeScript from scratch. `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, flat ESLint config. |
| Pipeline (Transformer modernized) | live | PathRipper's callback-based `Transformer` becomes a typed `Pipeline<TState>`. Same middleware pattern, fully typed generic state. |
| HTML scraper | live | JSDOM replaced with native `fetch` + `cheerio`. Configurable base URL, headers, rate limit. Returns live `CheerioAPI` handle. |
| MediaWiki scraper | live | Native `fetch()` to the MediaWiki JSON API. Category listing with full pagination, 50-page batch wikitext fetches, `wtf_wikipedia` infobox parsing. |
| LinkLister crawler | live | PathRipper's recursive crawler rewritten. cheerio replaces JSDOM for link extraction. Concurrent traversals with `Promise.all`. Numeric-aware sort. `Set`-based deduplication. |
| HTTP machinery | live | `ErrorClassifier` + `RetryExecutor` ported from TORUS. `RateLimiter` wrapping `bottleneck`. `Retry-After` header respected. Seven error categories. Exponential + jitter backoff. |
| Structured logger | live | Ported from Torreya's `@torreya/logger`. `Logger.forComponent(name)`, JSON lines, `LOG_LEVEL` gate, component + operation attribution on every entry. |
| JSON config | live | All targets, URLs, rate limits, and output paths live in `ripperoni.config.json`. Nothing hardcoded. `RipperConfig.load(path)` validates and returns a typed interface. |
| Concurrent pipeline | live | `ConcurrentPipeline.create(pipeline, concurrency)` fans N pages through the same pipeline simultaneously with a semaphore cap. |
| Task registry | live | `TaskRegistry.register(name, fn)` + dynamic plugin loading via `pipeline: ["my-target:parse"]` in config. Plugins are `.js` files loaded at runtime. |
| Checkpoint + resume | live | Already-written slugs are detected at run start and skipped. Failed pages are written to `failures.json`; pass `--resume-failures` to retry only those. |
| Config schema validation | live | AJV validates the config at load time. `RipperConfig.load(path)` throws with the exact field path on any violation — malformed configs fail fast and loudly. |

## Planned

| Feature | Details |
|---------|---------|
| JSDOM fallback mode | Some pages require JavaScript execution to render their content. A configurable `jsdom` mode in `HtmlScraper` would handle these without needing a full headless browser. |
| HTML → Markdown conversion | Output mode that converts scraped HTML to clean Markdown. Useful for feeding scraped content into LLM pipelines without sending raw HTML. Likely via `turndown` or similar. |
