import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import path from "node:path";
import process from "node:process";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const SKILLS_ORIGIN = "https://skills.sh";
const ROBOTS_URL = `${SKILLS_ORIGIN}/robots.txt`;
const SITEMAP_URL = `${SKILLS_ORIGIN}/sitemap.xml`;
const DEFAULT_USER_AGENT =
  "MstySkillsIndexer/0.1 (+https://github.com/mstystudio/msty-skills-indexer)";
const REQUIRED_OBJECT_PREFIX = "app/latest/assets/mstySkills/";
const PROTECTED_OBJECT_KEYS = new Set([
  "app/latest/ollama-models.json",
  "app/latest/assets/mstySkills.json",
]);

const config = {
  dryRun: readBool("DRY_RUN", false),
  fullRecrawl: readBool("FULL_RECRAWL", false),
  maxDetailPages: readInt("MAX_DETAIL_PAGES", 1000),
  detailConcurrency: readInt("DETAIL_CONCURRENCY", 2),
  detailDelayMs: readInt("DETAIL_DELAY_MS", 250),
  detailRefreshHours: readInt("DETAIL_REFRESH_HOURS", 168),
  popularRefreshHours: readInt("POPULAR_REFRESH_HOURS", 6),
  popularInstallThreshold: readInt("POPULAR_INSTALL_THRESHOLD", 10_000),
  userAgent: process.env.USER_AGENT || DEFAULT_USER_AGENT,
  r2AccountId: process.env.R2_ACCOUNT_ID,
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID,
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  r2Bucket: process.env.R2_BUCKET,
  r2Prefix: trimSlashes(process.env.R2_PREFIX || "app/latest/assets/mstySkills"),
  publicBaseUrl: trimTrailingSlash(process.env.PUBLIC_BASE_URL || ""),
};

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outputRoot = path.resolve(process.cwd(), "out", runId);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  validateConfig();
  await mkdir(outputRoot, { recursive: true });

  console.log(`Starting Skills.sh index run ${runId}`);
  console.log(`Dry run: ${config.dryRun ? "yes" : "no"}`);

  const r2 = createR2Client();
  const previousState = await loadPreviousState(r2);
  const robots = await fetchRobots();
  const sitemap = await fetchSitemapTree(SITEMAP_URL);
  const sitemapHash = sha256(
    sitemap.documents.map((document) => `${document.url}\n${document.hash}`).join("\n"),
  );
  const sitemapEntries = sitemap.entries;
  const skillUrls = sitemapEntries
    .map((entry) => ({ ...entry, ref: parseSkillUrl(entry.url) }))
    .filter((entry) => entry.ref)
    .map((entry) => ({
      ...entry,
      blockedByRobots: isBlockedByRobots(new URL(entry.url).pathname, robots),
    }));

  const crawlableSkillUrls = skillUrls.filter((entry) => !entry.blockedByRobots);
  const blockedCount = skillUrls.length - crawlableSkillUrls.length;
  if (crawlableSkillUrls.length === 0) {
    throw new Error("Refusing to publish an empty skills index; no crawlable skill URLs were parsed from the sitemap.");
  }
  const previousByUrl = new Map(
    (previousState.skills || []).map((skill) => [skill.url, skill]),
  );

  const detailQueue = buildDetailQueue(crawlableSkillUrls, previousByUrl);
  const selectedQueue = detailQueue.slice(0, config.maxDetailPages);
  const skippedQueue = detailQueue.slice(config.maxDetailPages);

  console.log(`Sitemap URLs: ${sitemapEntries.length}`);
  console.log(`Skill URLs: ${skillUrls.length}`);
  console.log(`Blocked by robots.txt: ${blockedCount}`);
  console.log(`Queued detail refreshes: ${detailQueue.length}`);
  console.log(`Selected detail refreshes: ${selectedQueue.length}`);

  const refreshed = await crawlDetails(selectedQueue, previousByUrl);
  const refreshedByUrl = new Map(refreshed.map((skill) => [skill.url, skill]));
  const mergedSkills = mergeSkills(crawlableSkillUrls, previousByUrl, refreshedByUrl);
  const searchRecords = mergedSkills.map(toSearchRecord);
  const summary = buildSummary({
    sitemapEntries,
    skillUrls,
    crawlableSkillUrls,
    blockedCount,
    refreshed,
    skippedQueue,
    mergedSkills,
    sitemapHash,
    sitemapDocumentCount: sitemap.documents.length,
  });
  const state = {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    sitemapHash,
    skills: mergedSkills,
  };

  const artifactKeys = await writeArtifacts({
    r2,
    summary,
    skills: mergedSkills,
    searchRecords,
    state,
  });

  console.log("Index complete");
  console.log(JSON.stringify({ summary, artifacts: artifactKeys }, null, 2));
}

function validateConfig() {
  if (config.detailConcurrency < 1 || config.detailConcurrency > 10) {
    throw new Error("DETAIL_CONCURRENCY must be between 1 and 10.");
  }
  if (config.maxDetailPages < 0) {
    throw new Error("MAX_DETAIL_PAGES must be 0 or greater.");
  }
  if (!config.dryRun) {
    const missing = [
      ["R2_ACCOUNT_ID", config.r2AccountId],
      ["R2_ACCESS_KEY_ID", config.r2AccessKeyId],
      ["R2_SECRET_ACCESS_KEY", config.r2SecretAccessKey],
      ["R2_BUCKET", config.r2Bucket],
    ].filter(([, value]) => !value);
    if (missing.length > 0) {
      throw new Error(
        `Missing required R2 settings: ${missing.map(([name]) => name).join(", ")}`,
      );
    }
  }
}

function createR2Client() {
  if (config.dryRun) {
    return null;
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
  });
}

async function fetchRobots() {
  const text = await fetchText(ROBOTS_URL);
  const disallow = [];
  let applies = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      applies = value === "*";
      continue;
    }
    if (applies && key === "disallow" && value) {
      disallow.push(value);
    }
  }
  return { raw: text, disallow };
}

function isBlockedByRobots(pathname, robots) {
  return robots.disallow.some((rule) => {
    if (!rule || rule === "/") return rule === "/";
    return pathname === rule || pathname.startsWith(rule);
  });
}

async function fetchSitemapTree(url, seen = new Set()) {
  if (seen.has(url)) {
    return { documents: [], entries: [] };
  }
  seen.add(url);

  const xml = await fetchText(url);
  const document = { url, hash: sha256(xml) };
  const childUrls = parseSitemapIndex(xml);
  if (childUrls.length === 0) {
    return {
      documents: [document],
      entries: parseSitemap(xml),
    };
  }

  const children = [];
  for (const childUrl of childUrls) {
    children.push(await fetchSitemapTree(childUrl, seen));
  }

  return {
    documents: [document, ...children.flatMap((child) => child.documents)],
    entries: children.flatMap((child) => child.entries),
  };
}

async function fetchText(url, extraHeaders = {}) {
  const response = await fetch(url, {
    headers: {
      "user-agent": config.userAgent,
      accept: "text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
      ...extraHeaders,
    },
  });
  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }
  return await response.text();
}

function parseSitemapIndex(xml) {
  const urls = [];
  const sitemapBlocks = xml.matchAll(/<sitemap>\s*([\s\S]*?)\s*<\/sitemap>/g);
  for (const block of sitemapBlocks) {
    const url = extractXmlValue(block[1], "loc");
    if (!url) continue;
    const parsed = new URL(url);
    if (parsed.origin !== SKILLS_ORIGIN) continue;
    urls.push(parsed.href);
  }
  return urls;
}

function parseSitemap(xml) {
  const entries = [];
  const urlBlocks = xml.matchAll(/<url>\s*([\s\S]*?)\s*<\/url>/g);
  for (const block of urlBlocks) {
    const body = block[1];
    const url = extractXmlValue(body, "loc");
    if (!url || !url.startsWith(`${SKILLS_ORIGIN}/`)) continue;
    entries.push({
      url,
      lastmod: extractXmlValue(body, "lastmod"),
      changefreq: extractXmlValue(body, "changefreq"),
      priority: extractXmlValue(body, "priority"),
    });
  }
  return entries;
}

function parseSkillUrl(url) {
  const parsed = new URL(url);
  if (parsed.origin !== SKILLS_ORIGIN) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 3) return null;
  const [owner, repo, skill] = segments;
  if (isReservedTopLevel(owner)) return null;
  return {
    owner,
    repo,
    skill,
    source: `${owner}/${repo}`,
    packageRef: `${owner}/${repo}@${skill}`,
  };
}

function isReservedTopLevel(segment) {
  return new Set([
    "agent",
    "audits",
    "contact",
    "docs",
    "hot",
    "internal",
    "official",
    "package",
    "picks",
    "privacy",
    "search",
    "terms",
    "topic",
    "trending",
  ]).has(segment);
}

function buildDetailQueue(entries, previousByUrl) {
  const now = Date.now();
  const refreshMs = config.detailRefreshHours * 60 * 60 * 1000;
  const popularRefreshMs = config.popularRefreshHours * 60 * 60 * 1000;

  const queue = entries
    .map((entry) => {
      const previous = previousByUrl.get(entry.url);
      const ageMs = previous?.fetchedAt ? now - Date.parse(previous.fetchedAt) : Infinity;
      const installs = previous?.installs || 0;
      const popular = installs >= config.popularInstallThreshold;
      const stale = config.fullRecrawl
        || !previous
        || ageMs >= refreshMs
        || (popular && ageMs >= popularRefreshMs)
        || (entry.lastmod && previous?.sitemapLastmod && entry.lastmod !== previous.sitemapLastmod);
      return {
        ...entry,
        previous,
        stale,
        ageMs,
        installs,
        popular,
      };
    })
    .filter((entry) => entry.stale);

  queue.sort((left, right) => {
    if (!left.previous && right.previous) return -1;
    if (left.previous && !right.previous) return 1;
    if (left.popular !== right.popular) return left.popular ? -1 : 1;
    return right.installs - left.installs;
  });

  return queue;
}

async function crawlDetails(queue, previousByUrl) {
  const limit = pLimit(config.detailConcurrency);
  let completed = 0;
  const startedAt = Date.now();

  const results = await Promise.all(
    queue.map((entry, index) =>
      limit(async () => {
        await sleep(index * config.detailDelayMs);
        const previous = previousByUrl.get(entry.url);
        try {
          const skill = await fetchSkillDetail(entry, previous);
          completed += 1;
          if (completed % 25 === 0 || completed === queue.length) {
            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            console.log(`Fetched ${completed}/${queue.length} detail pages in ${elapsed}s`);
          }
          return skill;
        } catch (error) {
          console.warn(`Failed detail fetch for ${entry.url}: ${error.message}`);
          if (previous) {
            return {
              ...previous,
              lastError: error.message,
              failedFetches: (previous.failedFetches || 0) + 1,
            };
          }
          return null;
        }
      }),
    ),
  );

  return results.filter(Boolean);
}

async function fetchSkillDetail(entry, previous) {
  const headers = {};
  if (previous?.etag) headers["if-none-match"] = previous.etag;
  if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;

  const response = await fetch(entry.url, {
    headers: {
      "user-agent": config.userAgent,
      accept: "text/html,application/xhtml+xml",
      ...headers,
    },
  });

  const fetchedAt = new Date().toISOString();
  if (response.status === 304 && previous) {
    return {
      ...previous,
      fetchedAt,
      sitemapLastmod: entry.lastmod || previous.sitemapLastmod || null,
      unchanged: true,
    };
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const htmlHash = sha256(html);
  const parsed = extractSkillPage(html, entry);
  return {
    schemaVersion: 1,
    ...entry.ref,
    url: entry.url,
    detailUrl: entry.url,
    sitemapLastmod: entry.lastmod || null,
    fetchedAt,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    htmlHash,
    ...parsed,
    failedFetches: 0,
    lastError: null,
  };
}

function extractSkillPage(html, entry) {
  const $ = cheerio.load(html);
  const jsonLd = $("script[type='application/ld+json']")
    .map((_, element) => safeJsonParse($(element).text()))
    .get()
    .filter(Boolean);
  const software = jsonLd.find((item) => item["@type"] === "SoftwareApplication") || null;
  const breadcrumbs = jsonLd.find((item) => item["@type"] === "BreadcrumbList") || null;
  const title = $("meta[property='og:title']").attr("content") || $("title").text() || "";
  const description =
    software?.description
    || $("meta[name='description']").attr("content")
    || $("meta[property='og:description']").attr("content")
    || "";
  const installCommand = $("code")
    .map((_, element) => $(element).text().replace(/\s+/g, " ").trim())
    .get()
    .find((text) => text.includes("npx skills add"))
    || null;
  const topicLinks = $("main h1")
    .first()
    .nextAll("div")
    .first()
    .find("a[href^='/topic/']")
    .map((_, element) => ({
      slug: ($(element).attr("href") || "").replace(/^\/topic\//, ""),
      label: $(element).text().trim(),
    }))
    .get()
    .filter((topic) => topic.slug && topic.label);

  const stats = extractVisibleStats($);
  const audits = extractAudits($);
  const related = extractRelatedSkills($);
  const skillMarkdown = extractSkillMarkdownFromFlight(html) || extractSkillMarkdownFromDom($);
  const summaryHtml = extractSummaryHtml($);

  return {
    name: software?.name || entry.ref.skill,
    title: cleanTitle(title),
    description: normalizeWhitespace(description),
    installCommand,
    installs: extractInstallCount(software) ?? stats.installs ?? null,
    repository: stats.repository || `https://github.com/${entry.ref.source}`,
    githubStars: stats.githubStars ?? null,
    firstSeen: stats.firstSeen ?? null,
    topics: uniqueBy(topicLinks, (topic) => topic.slug),
    audits,
    related,
    summaryHtml,
    skillMarkdown,
    skillMarkdownHash: skillMarkdown ? sha256(skillMarkdown) : null,
    jsonLd,
    breadcrumbs,
  };
}

function extractVisibleStats($) {
  const stats = {};
  const pageText = $("body").text();

  const installMatch = pageText.match(/Installs\s*([\d.,]+)\s*([KMB])?/i);
  if (installMatch) {
    stats.installs = parseCompactNumber(`${installMatch[1]}${installMatch[2] || ""}`);
  }

  const starsMatch = pageText.match(/GitHub Stars\s*([\d.,]+)\s*([KMB])?/i);
  if (starsMatch) {
    stats.githubStars = parseCompactNumber(`${starsMatch[1]}${starsMatch[2] || ""}`);
  }

  const firstSeenMatch = pageText.match(/First Seen\s*([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/);
  if (firstSeenMatch) {
    stats.firstSeen = firstSeenMatch[1];
  }

  const repositoryLink = $("a[href^='https://github.com/']")
    .map((_, element) => $(element).attr("href"))
    .get()
    .find(Boolean);
  if (repositoryLink) {
    stats.repository = repositoryLink;
  }

  return stats;
}

function extractInstallCount(software) {
  const count = software?.interactionStatistic?.userInteractionCount;
  return typeof count === "number" ? count : null;
}

function extractAudits($) {
  const audits = [];
  $("a[href*='/security/']").each((_, element) => {
    const $element = $(element);
    const href = $element.attr("href");
    const text = normalizeWhitespace($element.text());
    if (!href || !text) return;
    const statusMatch = text.match(/(Pass|Warn|Fail|Error)$/i);
    audits.push({
      href,
      name: normalizeWhitespace(text.replace(/(Pass|Warn|Fail|Error)$/i, "")),
      status: statusMatch?.[1] || null,
    });
  });
  return uniqueBy(audits, (audit) => audit.href);
}

function extractRelatedSkills($) {
  return $("section a[href^='/']")
    .map((_, element) => {
      const href = $(element).attr("href") || "";
      const ref = parseSkillUrl(`${SKILLS_ORIGIN}${href}`);
      if (!ref) return null;
      return {
        ...ref,
        url: `${SKILLS_ORIGIN}${href}`,
        name: $(element).find("h3").first().text().trim() || ref.skill,
        description: $(element).find("p").first().text().trim(),
      };
    })
    .get()
    .filter(Boolean)
    .slice(0, 20);
}

function extractSummaryHtml($) {
  const summaryHeading = $("div")
    .filter((_, element) => normalizeWhitespace($(element).text()) === "Summary")
    .first();
  const summaryBlock = summaryHeading.next();
  return summaryBlock.length ? summaryBlock.html() : null;
}

function extractSkillMarkdownFromDom($) {
  const heading = $("span")
    .filter((_, element) => normalizeWhitespace($(element).text()) === "SKILL.md")
    .first();
  const markdownRoot = heading.closest("div").next();
  return markdownRoot.length ? normalizeMarkdownishText(markdownRoot.text()) : null;
}

function extractSkillMarkdownFromFlight(html) {
  const match = html.match(/self\.__next_f\.push\(\[1,"2f:T[0-9a-f]+,"\]\)<\/script><script>self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/);
  if (!match) return null;
  const encoded = match[1]
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/\\u003c/g, "<")
    .replace(/\\u003e/g, ">")
    .replace(/\\u0026/g, "&");
  const $ = cheerio.load(encoded);
  return normalizeMarkdownishText($.text());
}

function normalizeMarkdownishText(value) {
  return normalizeWhitespace(value)
    .replace(/\s*(#{1,6}\s+)/g, "\n\n$1")
    .replace(/\s*(-\s+)/g, "\n$1")
    .trim();
}

function mergeSkills(crawlableEntries, previousByUrl, refreshedByUrl) {
  const merged = [];
  for (const entry of crawlableEntries) {
    const refreshed = refreshedByUrl.get(entry.url);
    const previous = previousByUrl.get(entry.url);
    if (refreshed) {
      merged.push(refreshed);
      continue;
    }
    if (previous) {
      merged.push({
        ...previous,
        sitemapLastmod: entry.lastmod || previous.sitemapLastmod || null,
      });
      continue;
    }
    merged.push({
      schemaVersion: 1,
      ...entry.ref,
      url: entry.url,
      detailUrl: entry.url,
      sitemapLastmod: entry.lastmod || null,
      fetchedAt: null,
      name: entry.ref.skill,
      title: entry.ref.skill,
      description: "",
      installCommand: null,
      installs: null,
      repository: `https://github.com/${entry.ref.source}`,
      githubStars: null,
      firstSeen: null,
      topics: [],
      audits: [],
      related: [],
      summaryHtml: null,
      skillMarkdown: null,
      skillMarkdownHash: null,
      jsonLd: [],
      breadcrumbs: null,
      failedFetches: 0,
      lastError: null,
      sitemapOnly: true,
    });
  }

  merged.sort((left, right) => {
    const installsDiff = (right.installs || 0) - (left.installs || 0);
    if (installsDiff !== 0) return installsDiff;
    return left.packageRef.localeCompare(right.packageRef);
  });
  return merged;
}

function toSearchRecord(skill) {
  return {
    id: `${skill.source}/${skill.skill}`,
    name: skill.name || skill.skill,
    description: skill.description || "",
    source: skill.source,
    owner: skill.owner,
    repo: skill.repo,
    skill: skill.skill,
    packageRef: skill.packageRef,
    url: skill.url,
    installs: skill.installs,
    githubStars: skill.githubStars,
    firstSeen: skill.firstSeen,
    topics: (skill.topics || []).map((topic) => topic.slug),
    auditStatus: summarizeAuditStatus(skill.audits || []),
    fetchedAt: skill.fetchedAt,
  };
}

function buildSummary(params) {
  const auditCounts = countBy(
    params.mergedSkills.map((skill) => summarizeAuditStatus(skill.audits || [])),
  );
  return {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    source: SKILLS_ORIGIN,
    sitemapUrl: SITEMAP_URL,
    sitemapHash: params.sitemapHash,
    sitemapDocumentCount: params.sitemapDocumentCount,
    sitemapUrlCount: params.sitemapEntries.length,
    skillUrlCount: params.skillUrls.length,
    crawlableSkillUrlCount: params.crawlableSkillUrls.length,
    blockedByRobotsCount: params.blockedCount,
    refreshedSkillCount: params.refreshed.length,
    skippedRefreshCount: params.skippedQueue.length,
    indexedSkillCount: params.mergedSkills.length,
    fetchedDetailCount: params.mergedSkills.filter((skill) => skill.fetchedAt).length,
    sitemapOnlyCount: params.mergedSkills.filter((skill) => !skill.fetchedAt).length,
    auditCounts,
  };
}

async function writeArtifacts({ r2, summary, skills, searchRecords, state }) {
  const skillsShards = shardArray(skills, 1000);
  const artifacts = [
    {
      key: `indexes/${runId}/summary.json`,
      body: summary,
      gzip: true,
      contentType: "application/json",
      cacheControl: "public, max-age=31536000, immutable",
    },
    {
      key: `indexes/${runId}/skills.json`,
      body: skills,
      gzip: true,
      contentType: "application/json",
      cacheControl: "public, max-age=31536000, immutable",
    },
    {
      key: `indexes/${runId}/search.json`,
      body: searchRecords,
      gzip: true,
      contentType: "application/json",
      cacheControl: "public, max-age=31536000, immutable",
    },
    {
      key: "state/latest-state.json",
      body: state,
      gzip: true,
      contentType: "application/json",
      cacheControl: "private, max-age=0, no-store",
    },
    ...skillsShards.map((shard, index) => ({
      key: `indexes/${runId}/shards/${String(index).padStart(2, "0")}.json`,
      body: shard,
      gzip: true,
      contentType: "application/json",
      cacheControl: "public, max-age=31536000, immutable",
    })),
  ];

  const manifest = {
    schemaVersion: 1,
    runId,
    generatedAt: summary.generatedAt,
    source: SKILLS_ORIGIN,
    summary,
    files: {
      latestSummary: publicArtifactUrl("summary.json.gz"),
      latestSearch: publicArtifactUrl("search.json.gz"),
      latestSkills: publicArtifactUrl("skills.json.gz"),
      summary: publicArtifactUrl(`indexes/${runId}/summary.json.gz`),
      skills: publicArtifactUrl(`indexes/${runId}/skills.json.gz`),
      search: publicArtifactUrl(`indexes/${runId}/search.json.gz`),
      shards: skillsShards.map((_, index) =>
        publicArtifactUrl(`indexes/${runId}/shards/${String(index).padStart(2, "0")}.json.gz`),
      ),
    },
  };

  artifacts.push({
    key: "manifest.json",
    body: manifest,
    gzip: false,
    contentType: "application/json",
    cacheControl: "public, max-age=300",
  });
  artifacts.push({
    key: "summary.json",
    body: summary,
    gzip: true,
    contentType: "application/json",
    cacheControl: "public, max-age=300",
  });
  artifacts.push({
    key: "search.json",
    body: searchRecords,
    gzip: true,
    contentType: "application/json",
    cacheControl: "public, max-age=300",
  });
  artifacts.push({
    key: "skills.json",
    body: skills,
    gzip: true,
    contentType: "application/json",
    cacheControl: "public, max-age=300",
  });

  const written = [];
  for (const artifact of artifacts) {
    const serialized = JSON.stringify(artifact.body);
    const body = artifact.gzip ? gzipSync(serialized) : Buffer.from(serialized);
    const key = artifact.gzip ? `${artifact.key}.gz` : artifact.key;
    const objectKey = r2Key(key);
    assertSafeObjectKey(objectKey);
    await writeLocalArtifact(objectKey, body, key);
    if (r2) {
      await putR2Object(r2, objectKey, body, artifact);
    }
    written.push(publicObjectUrl(objectKey));
  }
  return written;
}

async function writeLocalArtifact(outputKey, body, logicalKey) {
  const outputPath = path.join(outputRoot, outputKey);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, body);
  if (logicalKey === "state/latest-state.json.gz") {
    await writeFile(path.resolve(process.cwd(), "out", "latest-state.json.gz"), body);
  }
}

async function putR2Object(r2, objectKey, body, artifact) {
  assertSafeObjectKey(objectKey);
  await r2.send(
    new PutObjectCommand({
      Bucket: config.r2Bucket,
      Key: objectKey,
      Body: body,
      ContentType: artifact.contentType,
      ContentEncoding: artifact.gzip ? "gzip" : undefined,
      CacheControl: artifact.cacheControl,
    }),
  );
}

function assertSafeObjectKey(objectKey) {
  if (
    objectKey.startsWith("/")
    || objectKey.includes("../")
    || objectKey.includes("..\\")
  ) {
    throw new Error(`Unsafe object key generated: ${objectKey}`);
  }

  if (!objectKey.startsWith(REQUIRED_OBJECT_PREFIX)) {
    throw new Error(
      `Refusing upload because object key is outside ${REQUIRED_OBJECT_PREFIX}: ${objectKey}. `
        + "Set R2_PREFIX=app/latest/assets/mstySkills.",
    );
  }

  if (PROTECTED_OBJECT_KEYS.has(objectKey)) {
    throw new Error(`Refusing upload to protected object key: ${objectKey}`);
  }
}

async function loadPreviousState(r2) {
  if (!r2) {
    return loadLocalPreviousState();
  }
  try {
    const result = await r2.send(
      new GetObjectCommand({
        Bucket: config.r2Bucket,
        Key: r2Key("state/latest-state.json.gz"),
      }),
    );
    const buffer = Buffer.from(await result.Body.transformToByteArray());
    return JSON.parse(gunzipSync(buffer).toString("utf8"));
  } catch (error) {
    console.warn(`No previous R2 state loaded: ${error.name || error.message}`);
    return { skills: [] };
  }
}

async function loadLocalPreviousState() {
  const latestPath = path.resolve(process.cwd(), "out", "latest-state.json.gz");
  try {
    const buffer = await readFile(latestPath);
    return JSON.parse(gunzipSync(buffer).toString("utf8"));
  } catch {
    return { skills: [] };
  }
}

function r2Key(key) {
  return config.r2Prefix ? `${config.r2Prefix}/${key}` : key;
}

function publicArtifactUrl(key) {
  return publicObjectUrl(r2Key(key));
}

function publicObjectUrl(objectKey) {
  if (!config.publicBaseUrl) {
    return objectKey;
  }
  if (objectKey.startsWith(`${config.r2Prefix}/`)) {
    return `${config.publicBaseUrl}/${objectKey.slice(config.r2Prefix.length + 1)}`;
  }
  return `${objectKey}`;
}

function summarizeAuditStatus(audits) {
  if (!audits.length) return "unknown";
  if (audits.some((audit) => /fail|error/i.test(audit.status || ""))) return "fail";
  if (audits.some((audit) => /warn/i.test(audit.status || ""))) return "warn";
  if (audits.every((audit) => /pass/i.test(audit.status || ""))) return "pass";
  return "unknown";
}

function extractXmlValue(body, tag) {
  const match = body.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? decodeXml(match[1].trim()) : null;
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseCompactNumber(value) {
  const match = String(value).trim().match(/^([\d,.]+)\s*([KMB])?$/i);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const suffix = (match[2] || "").toUpperCase();
  const multiplier = suffix === "B" ? 1_000_000_000 : suffix === "M" ? 1_000_000 : suffix === "K" ? 1_000 : 1;
  return Math.round(amount * multiplier);
}

function cleanTitle(title) {
  return normalizeWhitespace(title.replace(/\s+—\s+.*$/, ""));
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function countBy(items) {
  const counts = {};
  for (const item of items) {
    counts[item] = (counts[item] || 0) + 1;
  }
  return counts;
}

function shardArray(items, size) {
  const shards = [];
  for (let index = 0; index < items.length; index += size) {
    shards.push(items.slice(index, index + size));
  }
  return shards;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function readBool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes)$/i.test(value);
}

function trimSlashes(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/g, "");
}
