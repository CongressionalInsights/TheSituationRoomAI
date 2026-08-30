import fs from "node:fs";
import path from "node:path";
import { isCredentialFieldName } from "../analysis/monitor/lib/public_payload_safety.mjs";

const root = path.resolve(process.cwd());
const publicDir = path.join(root, "public");
const requiredFiles = [
  "index.html",
  "styles.css",
  "app.js",
  "app.bundle.js",
  "assets/manifest.json"
];

const errors = [];

function findCredentialFields(value, currentPath = [], matches = []) {
  if (!value || typeof value !== "object") return matches;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findCredentialFields(entry, [...currentPath, index], matches));
    return matches;
  }
  Object.entries(value).forEach(([key, entry]) => {
    const nextPath = [...currentPath, key];
    if (isCredentialFieldName(key)) matches.push(nextPath.join("."));
    findCredentialFields(entry, nextPath, matches);
  });
  return matches;
}

for (const file of requiredFiles) {
  const filePath = path.join(publicDir, file);
  if (!fs.existsSync(filePath)) {
    errors.push(`Missing required file: public/${file}`);
  }
}

const indexPath = path.join(publicDir, "index.html");
if (fs.existsSync(indexPath)) {
  const indexHtml = fs.readFileSync(indexPath, "utf8");
  if (!indexHtml.includes("id=\"aboutSources\"")) {
    errors.push("About sources list container not found in public/index.html");
  }
  if (!indexHtml.includes("id=\"attributionOverlay\"")) {
    errors.push("Attribution overlay not found in public/index.html");
  }
}

const appPaths = [
  path.join(publicDir, "app.js"),
  path.join(publicDir, "app.bundle.js")
];

const secretPatterns = [
  /api[_-]?key=/i,
  /apikey=/i,
  /key=[A-Za-z0-9_-]{16,}/,
];

for (const appPath of appPaths) {
  if (!fs.existsSync(appPath)) continue;
  const content = fs.readFileSync(appPath, "utf8");
  for (const pattern of secretPatterns) {
    if (pattern.test(content)) {
      errors.push(`Potential API key leak pattern (${pattern}) in ${path.basename(appPath)}`);
      break;
    }
  }
}

for (const feedId of ["energy-eia", "energy-eia-brent", "energy-eia-ng"]) {
  const feedPath = path.join(publicDir, "data", "feeds", `${feedId}.json`);
  if (!fs.existsSync(feedPath)) continue;
  try {
    const payload = JSON.parse(fs.readFileSync(feedPath, "utf8"));
    const wrapperMatches = findCredentialFields(payload);
    let bodyMatches = [];
    if (typeof payload.body === "string") {
      if (/([?&]\s*api[_-]?key=)[^&\s"'<>]+/i.test(payload.body)) {
        errors.push(`Credential query value found in public EIA snapshot: ${feedId}`);
      }
      try {
        bodyMatches = findCredentialFields(JSON.parse(payload.body));
      } catch {}
    }
    if (wrapperMatches.length || bodyMatches.length) {
      errors.push(`Credential fields found in public EIA snapshot: ${feedId}`);
    }
  } catch (error) {
    errors.push(`Unable to verify public EIA snapshot ${feedId}: ${error.message}`);
  }
}

const manifestFile = path.join(publicDir, "assets", "manifest.json");
if (fs.existsSync(manifestFile)) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    Object.values(manifest).forEach((assetPath) => {
      const resolved = path.join(publicDir, assetPath);
      if (!fs.existsSync(resolved)) {
        errors.push(`Manifest reference missing: ${assetPath}`);
      }
    });
  } catch (error) {
    errors.push(`Unable to parse assets/manifest.json: ${error.message}`);
  }
}

if (errors.length) {
  console.error("Public bundle verification failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Public bundle verification passed.");
