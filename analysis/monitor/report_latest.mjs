import fs from 'node:fs';
import path from 'node:path';
import {
  MONITOR_PUBLICATION_SCHEMA_VERSION,
  monitorPublicationHeadPath,
  monitorPublicationLockPath,
  recoverMonitorPublications,
  withMonitorPublicationLock
} from './lib/baseline.mjs';
import { buildMarkdownReport } from './lib/reporting.mjs';
import { hashContent, parseCliArgs, writeJson, writeText } from './lib/client.mjs';

function readOptionalText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function restoreText(filePath, snapshot) {
  if (snapshot === null) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return;
  }
  writeText(filePath, snapshot);
}

const options = parseCliArgs(process.argv.slice(2));
const latestPath = path.join(options.outputDir, 'latest.json');
const latestMarkdownPath = path.join(options.outputDir, 'latest.md');
const publicationPath = path.join(options.outputDir, 'latest-commit.json');
const publicationHeadPath = monitorPublicationHeadPath(options.baselineDir);
const publicationLockPath = monitorPublicationLockPath(options.baselineDir);

fs.mkdirSync(options.baselineDir, { recursive: true });
recoverMonitorPublications({ baselineDir: options.baselineDir });

const result = withMonitorPublicationLock(publicationLockPath, () => {
  const latestRaw = readOptionalText(latestPath);
  if (latestRaw === null) {
    throw new Error(`No report found at ${latestPath}`);
  }
  const report = JSON.parse(latestRaw);
  const markdown = buildMarkdownReport(report);
  const publicationRaw = readOptionalText(publicationPath);
  const publicationHeadRaw = readOptionalText(publicationHeadPath);
  const previousMarkdown = readOptionalText(latestMarkdownPath);

  let publication = null;
  if (report?.publicationSchemaVersion !== undefined && publicationRaw === null) {
    throw new Error(`Modern report at ${latestPath} has no publication marker; refusing to regenerate Markdown`);
  }
  if (publicationRaw !== null) {
    publication = JSON.parse(publicationRaw);
    const publicationHead = publicationHeadRaw === null
      ? null
      : JSON.parse(publicationHeadRaw);
    const expectedBaselineName = `${publication?.mode}.${publication?.scopeId}.json`;
    const baselineName = publication?.artifacts?.baseline?.path;
    const baselinePath = baselineName && path.basename(baselineName) === baselineName
      ? path.join(options.baselineDir, baselineName)
      : null;
    const baselineRaw = baselinePath ? readOptionalText(baselinePath) : null;
    if (
      publication?.schemaVersion !== MONITOR_PUBLICATION_SCHEMA_VERSION
      || publication?.commitState !== 'complete'
      || report?.publicationSchemaVersion !== MONITOR_PUBLICATION_SCHEMA_VERSION
      || publication?.mode !== report?.mode
      || publication?.runStartedAt !== report?.runStartedAt
      || publication?.generatedAt !== report?.generatedAt
      || publication?.artifacts?.latestJson?.sha256 !== hashContent(latestRaw)
      || !publication?.artifacts?.latestMarkdown
      || baselineName !== expectedBaselineName
      || baselineRaw === null
      || publication?.artifacts?.baseline?.sha256 !== hashContent(baselineRaw)
      || (publicationHead && (
        publicationHead?.schemaVersion !== MONITOR_PUBLICATION_SCHEMA_VERSION
        || publicationHead?.commitState !== 'complete'
        || publicationHead?.mode !== publication.mode
        || publicationHead?.scopeId !== publication.scopeId
        || publicationHead?.runStartedAt !== publication.runStartedAt
        || publicationHead?.generatedAt !== publication.generatedAt
      ))
    ) {
      throw new Error(
        `Publication marker or durable baseline does not match ${latestPath}; refusing to regenerate Markdown`
      );
    }
  }

  try {
    writeText(latestMarkdownPath, markdown);
    if (publication) {
      const updatedPublication = {
        ...publication,
        artifacts: {
          ...publication.artifacts,
          latestMarkdown: {
            ...publication.artifacts.latestMarkdown,
            path: path.relative(options.outputDir, latestMarkdownPath),
            sha256: hashContent(markdown)
          }
        }
      };
      writeJson(publicationPath, updatedPublication);
      writeJson(publicationHeadPath, updatedPublication);
    }
  } catch (error) {
    try {
      restoreText(latestMarkdownPath, previousMarkdown);
      if (publicationRaw !== null) restoreText(publicationPath, publicationRaw);
      restoreText(publicationHeadPath, publicationHeadRaw);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Markdown regeneration failed and rollback also failed at ${latestMarkdownPath}`
      );
    }
    throw error;
  }

  return { publicationUpdated: Boolean(publication) };
});

console.log(JSON.stringify({
  latestPath,
  latestMarkdownPath,
  publicationPath: result.publicationUpdated ? publicationPath : null
}, null, 2));
