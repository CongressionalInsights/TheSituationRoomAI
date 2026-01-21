import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const publicDir = path.join(root, "public");
const requiredFiles = [
  "index.html",
  "styles.css",
  "app.js",
  "app.20260116a.js",
];

const errors = [];

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
  path.join(publicDir, "app.20260116a.js"),
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

if (errors.length) {
  console.error("Public bundle verification failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Public bundle verification passed.");
