# Msty Skills Indexer

Builds a static catalog index from `skills.sh` and uploads compressed JSON artifacts to Cloudflare R2.

The crawler is intentionally sitemap-first:

- reads `https://skills.sh/robots.txt`
- reads `https://skills.sh/sitemap.xml`
- extracts skill detail URLs from the sitemap
- skips paths disallowed by `robots.txt`
- refreshes detail pages incrementally
- extracts JSON-LD, meta tags, visible stats, install command, topics, audits, and `SKILL.md`
- writes immutable compressed JSON artifacts plus a small `manifest.json`

## Quick Start

```bash
npm install
npm run scrape:dry
```

Dry runs write artifacts to `out/` and skip R2 upload.

## R2 Setup

Create an R2 bucket, then create an R2 API token with object read/write access. Add these secrets to GitHub Actions:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`

Optional variables:

- `R2_PREFIX`, default `skills-index`
- `PUBLIC_BASE_URL`, used in generated manifests

The script writes:

```text
<prefix>/manifest.json
<prefix>/state/latest-state.json.gz
<prefix>/indexes/<run-id>/summary.json.gz
<prefix>/indexes/<run-id>/skills.json.gz
<prefix>/indexes/<run-id>/search.json.gz
<prefix>/indexes/<run-id>/shards/00.json.gz
...
```

`manifest.json` should be served with a short cache TTL. Versioned files are immutable and can be cached long-term.

## Schedule

The included workflow runs every 6 hours and can also be started manually.

Use a low `MAX_DETAIL_PAGES` at first, then increase after confirming behavior. The sitemap currently contains tens of thousands of skill detail pages, so the indexer should not recrawl every detail page every few hours.

Recommended defaults:

- every run: fetch robots + sitemap
- new skills: fetch as soon as discovered
- popular skills: refresh every few hours
- long tail: refresh weekly

## Local Output

Dry-run artifacts are written to `out/<run-id>/`.

The generated `search.json.gz` is intended for app-side search bootstrap. The generated `skills.json.gz` contains richer detail records.

## Notes

This project does not call undocumented Skills.sh API endpoints. It uses public pages listed in the official sitemap and respects `robots.txt`.
