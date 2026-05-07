import { createHash, createHmac } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const R2_REGION = "auto";
const R2_SERVICE = "s3";
const REQUIRED_OBJECT_PREFIX = "app/latest/assets/mstySkills/";
const PROTECTED_OBJECT_KEYS = new Set([
  "app/latest/ollama-models.json",
  "app/latest/assets/mstySkills.json",
]);

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

async function main() {
  const envPath = args.envFile || process.env.UPLOAD_ENV_FILE || ".env";
  const envResult = await loadEnvFile(envPath);
  if (envResult.loaded) {
    console.log(`[config] Loaded ${envPath} (${envResult.appliedCount} vars applied)`);
  } else {
    console.log(`[config] No ${envPath} file found; using current process environment`);
  }

  const sourceDir = path.resolve(args.sourceDir || process.env.UPLOAD_SOURCE_DIR || await findLatestOutputRun());
  const files = await collectFiles(sourceDir);
  if (files.length === 0) {
    throw new Error(`No files found under ${sourceDir}`);
  }

  const plans = files.map((filePath) => {
    const relativePath = normalizePath(path.relative(sourceDir, filePath));
    return {
      filePath,
      objectKey: relativePath,
      contentType: contentTypeFor(filePath),
      contentEncoding: filePath.endsWith(".gz") ? "gzip" : null,
      cacheControl: cacheControlFor(relativePath),
    };
  });
  assertSafeObjectKeys(plans);

  console.log(`[plan] Source: ${sourceDir}`);
  console.log(`[plan] Files: ${plans.length}`);
  for (const plan of plans) {
    const size = (await stat(plan.filePath)).size;
    plan.sizeBytes = size;
    console.log(
      `[plan] ${plan.objectKey} (${formatBytes(size)}, ${plan.contentType}${plan.contentEncoding ? `, ${plan.contentEncoding}` : ""}, ${plan.cacheControl})`,
    );
  }

  if (!args.apply) {
    console.log("[dry-run] Upload skipped. Re-run with --apply or `npm run upload` to write to R2.");
    return;
  }

  const config = loadUploadConfigFromEnv();
  console.log(`[upload] Bucket: ${config.r2Bucket}`);
  console.log(`[upload] Objects: ${plans.length}`);
  for (const plan of plans) {
    await uploadToR2(plan, config);
    console.log(`[upload] ${plan.objectKey}`);
  }

  const purgeUrls = getPurgeUrls();
  if (purgeUrls.length > 0) {
    await purgeCache(purgeUrls, config);
    console.log(`[purge] ${purgeUrls.length} URL(s) purged`);
  } else {
    console.log("[purge] Skipped; CF_API_TOKEN, CF_ZONE_ID, or CF_PURGE_URLS not configured");
  }
}

function parseArgs(argv) {
  const parsed = {
    apply: false,
    sourceDir: null,
    envFile: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      parsed.apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      parsed.apply = false;
      continue;
    }
    if (arg === "--source") {
      parsed.sourceDir = argv[++index];
      continue;
    }
    if (arg === "--env-file") {
      parsed.envFile = argv[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

async function loadEnvFile(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return { loaded: false, appliedCount: 0 };
  }

  let appliedCount = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] != null) continue;
    process.env[key] = unquoteEnvValue(rawValue.trim());
    appliedCount += 1;
  }

  return { loaded: true, appliedCount };
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function findLatestOutputRun() {
  const outDir = path.resolve("out");
  const entries = await readdir(outDir, { withFileTypes: true });
  const runDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const runDir of runDirs) {
    const candidate = path.join(outDir, runDir);
    const manifestPath = path.join(candidate, REQUIRED_OBJECT_PREFIX, "manifest.json");
    try {
      const manifestStat = await stat(manifestPath);
      if (manifestStat.isFile()) {
        return candidate;
      }
    } catch {
      // Skip incomplete or failed output runs.
    }
  }

  throw new Error("No completed output runs found. Run `npm run scrape:dry` first or pass --source <dir>.");
}

async function collectFiles(rootDir) {
  const output = [];
  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        output.push(fullPath);
      }
    }
  }
  await walk(rootDir);
  return output.sort();
}

function loadUploadConfigFromEnv() {
  return {
    r2AccountId: getRequiredEnv("R2_ACCOUNT_ID"),
    r2AccessKeyId: getRequiredEnv("R2_ACCESS_KEY_ID"),
    r2SecretAccessKey: getRequiredEnv("R2_SECRET_ACCESS_KEY"),
    r2Bucket: getRequiredEnv("R2_BUCKET"),
    cfApiToken: process.env.CF_API_TOKEN?.trim() || "",
    cfZoneId: process.env.CF_ZONE_ID?.trim() || "",
  };
}

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function assertSafeObjectKeys(plans) {
  const seen = new Set();
  for (const plan of plans) {
    if (
      plan.objectKey.startsWith("/")
      || plan.objectKey.includes("../")
      || plan.objectKey.includes("..\\")
    ) {
      throw new Error(`Unsafe object key generated: ${plan.objectKey}`);
    }

    if (!plan.objectKey.startsWith(REQUIRED_OBJECT_PREFIX)) {
      throw new Error(
        `Refusing upload because object key is outside ${REQUIRED_OBJECT_PREFIX}: ${plan.objectKey}. `
          + "Use the run root, e.g. --source out/<run-id>, not the nested mstySkills folder.",
      );
    }

    if (PROTECTED_OBJECT_KEYS.has(plan.objectKey)) {
      throw new Error(`Refusing upload to protected object key: ${plan.objectKey}`);
    }

    if (seen.has(plan.objectKey)) {
      throw new Error(`Duplicate object key generated: ${plan.objectKey}`);
    }
    seen.add(plan.objectKey);
  }
}

async function uploadToR2(plan, config) {
  const payload = await readFile(plan.filePath);
  const payloadHash = sha256Hex(payload);
  const { amzDate, dateStamp } = toAmzDate(new Date());
  const host = `${config.r2AccountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${uriEncodePath(`${config.r2Bucket}/${plan.objectKey}`)}`;

  const headersForSigning = {
    "cache-control": plan.cacheControl,
    "content-type": plan.contentType,
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (plan.contentEncoding) {
    headersForSigning["content-encoding"] = plan.contentEncoding;
  }

  const signedHeaderEntries = Object.entries(headersForSigning).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const canonicalHeaders = signedHeaderEntries
    .map(([key, value]) => `${key}:${value}\n`)
    .join("");
  const signedHeaders = signedHeaderEntries.map(([key]) => key).join(";");
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = buildSigningKey(config.r2SecretAccessKey, dateStamp);
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${config.r2AccessKeyId}/${credentialScope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`https://${host}${canonicalUri}`, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "Cache-Control": plan.cacheControl,
      "Content-Type": plan.contentType,
      ...(plan.contentEncoding ? { "Content-Encoding": plan.contentEncoding } : {}),
      Host: host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
    body: payload,
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`R2 upload failed for ${plan.objectKey} (${response.status}): ${bodyText}`);
  }
}

async function purgeCache(urls, config) {
  if (!config.cfApiToken || !config.cfZoneId) {
    return;
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${config.cfZoneId}/purge_cache`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.cfApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ files: urls }),
    },
  );
  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(`Cloudflare purge failed (${response.status}): ${bodyText}`);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`Cloudflare purge returned non-JSON response: ${bodyText}`);
  }
  if (!parsed?.success) {
    throw new Error(`Cloudflare purge failed: ${bodyText}`);
  }
}

function getPurgeUrls() {
  const raw = process.env.CF_PURGE_URLS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

function toAmzDate(date) {
  const iso = date.toISOString();
  const dateStamp = iso.slice(0, 10).replace(/-/g, "");
  const timeStamp = iso.slice(11, 19).replace(/:/g, "");
  return {
    amzDate: `${dateStamp}T${timeStamp}Z`,
    dateStamp,
  };
}

function buildSigningKey(secretAccessKey, dateStamp) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, R2_REGION);
  const kService = hmac(kRegion, R2_SERVICE);
  return hmac(kService, "aws4_request");
}

function uriEncodePath(value) {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".json") || filePath.endsWith(".json.gz")) {
    return "application/json";
  }
  return "application/octet-stream";
}

function cacheControlFor(objectKey) {
  if (objectKey.includes("/state/")) {
    return "private, max-age=0, no-store";
  }
  if (objectKey.includes("/indexes/")) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=300";
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
