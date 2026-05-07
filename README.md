# Msty Skills Indexer

Builds a static catalog index from `skills.sh` and uploads compressed JSON artifacts to Cloudflare R2.

The crawler is intentionally sitemap-first:

- reads `https://skills.sh/robots.txt`
- reads `https://skills.sh/sitemap.xml`
- extracts skill detail URLs from the sitemap
- skips paths disallowed by `robots.txt`
- refreshes detail pages incrementally
- extracts JSON-LD, meta tags, visible stats, install command, topics, audits, and `SKILL.md`
- writes immutable compressed JSON artifacts plus a stable folder manifest at `app/latest/assets/mstySkills/manifest.json`

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

- `R2_PREFIX`, default `app/latest/assets/mstySkills`
- `PUBLIC_BASE_URL`, used in generated manifests

The script writes:

```text
app/latest/assets/mstySkills/manifest.json
app/latest/assets/mstySkills/summary.json.gz
app/latest/assets/mstySkills/search.json.gz
app/latest/assets/mstySkills/skills.json.gz
app/latest/assets/mstySkills/state/latest-state.json.gz
app/latest/assets/mstySkills/indexes/<run-id>/summary.json.gz
app/latest/assets/mstySkills/indexes/<run-id>/skills.json.gz
app/latest/assets/mstySkills/indexes/<run-id>/search.json.gz
app/latest/assets/mstySkills/indexes/<run-id>/shards/00.json.gz
...
```

When the bucket is exposed at `<PUBLIC_ASSET_HOST>`, the app bootstrap file is:

```text
<PUBLIC_BASE_URL>/manifest.json
```

`manifest.json` includes the run metadata, summary counts, and links to the current gzipped data files. It should be served with a short cache TTL. Versioned files are immutable and can be cached long-term.

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

## Manual Upload

The repository includes a direct R2 uploader that mirrors the signing approach used by the Ollama models scraper. It does not use the AWS SDK.

Preview the upload plan without writing anything:

```bash
npm run upload:dry
```

Upload the latest local run:

```bash
npm run upload
```

By default, the uploader looks for the latest `out/<run-id>` directory and uploads every file under it using the same object keys as the local folder layout, for example:

```text
app/latest/assets/mstySkills/manifest.json
app/latest/assets/mstySkills/search.json.gz
app/latest/assets/mstySkills/indexes/<run-id>/search.json.gz
```

The uploader refuses to write any object outside `app/latest/assets/mstySkills/`. Pass the run root as `--source out/<run-id>`, not the nested `app/latest/assets/mstySkills` folder.

Useful overrides:

```bash
node scripts/upload-r2.mjs --source out/<run-id> --env-file ../msty-ollama-api/.env
node scripts/upload-r2.mjs --source out/<run-id> --env-file ../msty-ollama-api/.env --apply
```

`--apply` is required before any R2 writes happen.

## Notes

This project does not call undocumented Skills.sh API endpoints. It uses public pages listed in the official sitemap and respects `robots.txt`.
