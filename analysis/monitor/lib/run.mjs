import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildMonitorBaselineScope,
  loadMonitorBaseline,
  MONITOR_PENDING_PUBLICATION_SCHEMA_VERSION,
  MONITOR_PUBLICATION_SCHEMA_VERSION,
  monitorPublicationHeadPath,
  monitorPublicationJournalPath,
  monitorPublicationLockPath,
  recoverMonitorPublicationJournalUnderLock,
  recoverMonitorPublications,
  writeMonitorBaselineAtomic
} from './baseline.mjs';
import { loadMonitoringCatalog } from './catalog.mjs';
import { parseCliArgs, writeJson, writeText, ensureDir } from './client.mjs';
import { classifyDocChange, watchDocumentation } from './doc_watch.mjs';
import { runFeedAudit } from './audit.mjs';
import {
  applyKnownUpstreamQuirks,
  buildMarkdownReport,
  createAlert,
  dedupeAlerts,
  diffAlerts,
  summarizeAlerts
} from './reporting.mjs';

function toHistoryStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const file = fs.openSync(filePath, 'r');
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(file, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(file);
  }
  return hash.digest('hex');
}

function sha256Buffer(value) {
  if (value === null) return null;
  return crypto.createHash('sha256').update(value).digest('hex');
}

function snapshotFile(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function serializePreviousSnapshot(snapshot) {
  return {
    previousBase64: snapshot === null ? null : snapshot.toString('base64'),
    previousSha256: sha256Buffer(snapshot)
  };
}

function createFileBackedSnapshot(targetPath, rollbackPath) {
  try {
    try {
      fs.linkSync(targetPath, rollbackPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (!['EACCES', 'EMLINK', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(error?.code)) {
        throw error;
      }
      fs.copyFileSync(targetPath, rollbackPath, fs.constants.COPYFILE_EXCL);
    }
    return {
      path: rollbackPath,
      sha256: sha256File(rollbackPath)
    };
  } catch (error) {
    unlinkIfExists(rollbackPath);
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function createArtifactStage(targetPath) {
  const stagedPath = stagePathFor(targetPath);
  const rollbackPath = `${stagedPath}.rollback`;
  return {
    targetPath,
    stagedPath,
    previous: createFileBackedSnapshot(targetPath, rollbackPath)
  };
}

function serializeFileBackedSnapshot(snapshot, outputDir) {
  return {
    rollback: snapshot ? path.relative(outputDir, snapshot.path) : null,
    previousSha256: snapshot?.sha256 ?? null
  };
}

function stagePathFor(filePath) {
  return `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.stage`;
}

function unlinkIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function buildDocAlerts(docResults = [], entriesById = new Map()) {
  return docResults
    .filter((result) => result.classification)
    .map((result) => {
      const feedId = result.representativeFeedId || 'docs';
      const entry = entriesById.get(feedId);
      return applyKnownUpstreamQuirks(createAlert({
        feedId,
        regressionClass: result.classification.regressionClass,
        severity: result.classification.severity,
        message: `${result.classification.message} ${result.url}`,
        docsHash: result.hash || null,
        metadata: {
          identity: result.key,
          url: result.url,
          surfaceKey: result.key,
          surfaceType: result.surfaceType,
          affectedFeedIds: result.feedIds
        }
      }), entry?.knownUpstreamQuirks || []);
    });
}

function reclassifyDocResults(docResults, previousReport, entriesById) {
  const previousDocs = new Map(
    (previousReport?.docResults || []).map((result) => [result.key, result])
  );
  return docResults.map((result) => {
    const coreSurface = (result.feedIds || []).some(
      (feedId) => entriesById.get(feedId)?.tier === 'core'
    );
    let classification = null;
    if (!result.ok) {
      classification = {
        regressionClass: 'docs-fetch-failed',
        severity: coreSurface ? 'warning' : 'info',
        message: result.error || `HTTP ${result.status}`
      };
    } else if (!result.acceptedBaseline) {
      classification = classifyDocChange({
        previous: previousDocs.get(result.key) || null,
        current: result,
        surfaceType: result.surfaceType,
        tier: coreSurface ? 'core' : 'standard',
        acceptedHashRequired: result.acceptedHashRequired
      });
    }
    return {
      ...result,
      changed: Boolean(classification),
      classification
    };
  });
}

function supersessionMetadata(source, reason) {
  return {
    mode: source?.mode || null,
    scopeId: source?.scope?.id || source?.scopeId || null,
    runStartedAt: source?.runStartedAt || null,
    generatedAt: source?.generatedAt || null,
    reason: reason || null
  };
}

export function applyMonitorWriteDisposition(report, baselineWrite) {
  if (baselineWrite?.written) return baselineWrite.report;

  if (baselineWrite?.semanticSupersededBy) {
    const semanticSupersededBy = supersessionMetadata(
      baselineWrite.semanticSupersededBy,
      baselineWrite.semanticSupersededReason
    );
    return {
      ...report,
      notify: false,
      superseded: true,
      supersededBy: semanticSupersededBy,
      semanticSuperseded: true,
      semanticSupersededBy,
      publicationSuperseded: true,
      publicationSupersededBy: semanticSupersededBy,
      deltas: { newAlerts: [], resolvedAlerts: [], ongoingAlerts: [] }
    };
  }

  if (baselineWrite?.publicationSupersededBy) {
    return {
      ...(baselineWrite.report || report),
      superseded: false,
      semanticSuperseded: false,
      publicationSuperseded: true,
      publicationSupersededBy: supersessionMetadata(
        baselineWrite.publicationSupersededBy,
        baselineWrite.publicationSupersededReason
      )
    };
  }

  throw new Error('Monitor baseline write was skipped without a supersession disposition');
}

export function shouldFailMonitorRun(report, { allowAlerts = false } = {}) {
  const semanticSuperseded = report?.semanticSuperseded ?? report?.superseded;
  return !allowAlerts
    && !semanticSuperseded
    && Number(report?.summary?.critical || 0) > 0;
}

export async function runMonitor(mode, argv = []) {
  const runStartedAt = new Date().toISOString();
  const cli = parseCliArgs(argv);
  const catalog = loadMonitoringCatalog();
  const auditableEntries = catalog.entries.filter((entry) => entry.auditEnabled !== false);
  const entries = mode === 'core'
    ? auditableEntries.filter((entry) => entry.tier === 'core')
    : auditableEntries;

  const latestPath = path.join(cli.outputDir, 'latest.json');
  const latestMarkdownPath = path.join(cli.outputDir, 'latest.md');
  const publicationPath = path.join(cli.outputDir, 'latest-commit.json');
  const historyDir = path.join(cli.outputDir, 'history');
  const baselineScope = buildMonitorBaselineScope(cli);
  const publicationJournalPath = monitorPublicationJournalPath(
    mode,
    cli.baselineDir,
    baselineScope.id
  );
  const publicationLockPath = monitorPublicationLockPath(cli.baselineDir);
  const publicationHeadPath = monitorPublicationHeadPath(cli.baselineDir);
  recoverMonitorPublications({ baselineDir: cli.baselineDir });

  ensureDir(cli.outputDir);
  ensureDir(historyDir);
  const baseline = loadMonitorBaseline(mode, {
    baselineDir: cli.baselineDir,
    legacyLatestPath: latestPath,
    allowLegacyMigration: cli.allowLegacyBaseline,
    scope: baselineScope
  });
  const previousReport = baseline.report;
  const previousDocs = Object.fromEntries((previousReport?.docResults || []).map((result) => [result.key, result]));

  const feedResults = await runFeedAudit(entries, cli);
  const docResults = cli.includeDocs
    ? await watchDocumentation({ entries, previousDocs, timeoutMs: cli.timeoutMs })
    : [];
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));

  const feedAlerts = feedResults.flatMap((result) => result.alerts);
  const generatedAt = new Date().toISOString();
  const buildReport = (comparisonReport, comparisonSource) => {
    const comparedDocResults = reclassifyDocResults(
      docResults,
      comparisonReport,
      entriesById
    );
    const docAlerts = buildDocAlerts(comparedDocResults, entriesById);
    const alerts = dedupeAlerts([...feedAlerts, ...docAlerts]);
    const deltas = diffAlerts(alerts, comparisonReport?.alerts || []);
    const summary = summarizeAlerts(alerts);
    return {
      publicationSchemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
      mode,
      runStartedAt,
      generatedAt,
      base: baselineScope.base,
      mcp: baselineScope.mcp,
      staticBase: baselineScope.staticBase,
      comparisonBaseline: {
        source: comparisonSource,
        scopeId: baselineScope.id,
        previousRunStartedAt: comparisonReport?.runStartedAt || null,
        previousGeneratedAt: comparisonReport?.generatedAt || null
      },
      notify: deltas.newAlerts.length > 0 || deltas.resolvedAlerts.length > 0,
      summary: {
        ...summary,
        totalFeeds: auditableEntries.length,
        checkedFeeds: entries.length,
        checkedDocSurfaces: comparedDocResults.length
      },
      deltas,
      alerts,
      feedResults,
      docResults: comparedDocResults
    };
  };
  let report = buildReport(previousReport, baseline.source);

  if (cli.writeLatest) {
    const historyPath = path.join(
      historyDir,
      `${toHistoryStamp(new Date(generatedAt))}.${mode}.json`
    );
    let stageArtifacts = null;
    let pendingPublication = null;
    const baselineWrite = writeMonitorBaselineAtomic(report, {
      baselineDir: cli.baselineDir,
      previousReport,
      previousSource: baseline.source,
      scope: baselineScope,
      publicationLockPath,
      publicationMarkerPath: publicationPath,
      publicationHeadPath,
      publicationJournalPath,
      prepareReport: (comparisonReport, { source }) => (
        buildReport(comparisonReport, source)
      ),
      beforeCommit: (committedReport) => {
        stageArtifacts = {};
        stageArtifacts.history = createArtifactStage(historyPath);
        stageArtifacts.latestMarkdown = createArtifactStage(latestMarkdownPath);
        stageArtifacts.latestJson = createArtifactStage(latestPath);
        writeJson(stageArtifacts.history.stagedPath, committedReport);
        writeText(
          stageArtifacts.latestMarkdown.stagedPath,
          buildMarkdownReport(committedReport)
        );
        writeJson(stageArtifacts.latestJson.stagedPath, committedReport);
      },
      beforeBaselineCommit: (
        committedReport,
        { filePath, stagedBaselinePath, previousBaselineSnapshot }
      ) => {
        if (!stageArtifacts) {
          throw new Error('Monitor publication artifacts were not staged');
        }
        pendingPublication = {
          schemaVersion: MONITOR_PUBLICATION_SCHEMA_VERSION,
          commitState: 'complete',
          mode,
          runStartedAt: committedReport.runStartedAt,
          generatedAt: committedReport.generatedAt,
          scopeId: baselineScope.id,
          artifacts: {
            latestJson: {
              path: path.relative(cli.outputDir, latestPath),
              sha256: sha256File(stageArtifacts.latestJson.stagedPath)
            },
            latestMarkdown: {
              path: path.relative(cli.outputDir, latestMarkdownPath),
              sha256: sha256File(stageArtifacts.latestMarkdown.stagedPath)
            },
            history: {
              path: path.relative(cli.outputDir, historyPath),
              sha256: sha256File(stageArtifacts.history.stagedPath)
            },
            baseline: {
              path: path.basename(filePath),
              sha256: sha256File(stagedBaselinePath)
            }
          }
        };
        const publicationRaw = Buffer.from(JSON.stringify(pendingPublication, null, 2));
        const stages = Object.fromEntries(
          Object.entries(stageArtifacts).map(([key, artifact]) => [key, {
            target: path.relative(cli.outputDir, artifact.targetPath),
            staged: path.relative(cli.outputDir, artifact.stagedPath),
            sha256: sha256File(artifact.stagedPath),
            ...serializeFileBackedSnapshot(artifact.previous, cli.outputDir)
          }])
        );
        const stagedBaseline = fs.readFileSync(stagedBaselinePath);
        writeJson(publicationJournalPath, {
          schemaVersion: MONITOR_PENDING_PUBLICATION_SCHEMA_VERSION,
          state: 'pending',
          mode,
          scopeId: baselineScope.id,
          outputDir: cli.outputDir,
          publication: pendingPublication,
          baseline: {
            path: path.basename(filePath),
            sha256: sha256Buffer(stagedBaseline),
            newBase64: stagedBaseline.toString('base64'),
            ...serializePreviousSnapshot(previousBaselineSnapshot)
          },
          stages,
          marker: {
            target: path.relative(cli.outputDir, publicationPath),
            sha256: sha256Buffer(publicationRaw),
            ...serializePreviousSnapshot(snapshotFile(publicationPath))
          },
          head: {
            path: path.basename(publicationHeadPath),
            sha256: sha256Buffer(publicationRaw),
            ...serializePreviousSnapshot(snapshotFile(publicationHeadPath))
          }
        });
      },
      afterBaselineCommit: (committedReport) => {
        if (!pendingPublication || pendingPublication.runStartedAt !== committedReport.runStartedAt) {
          throw new Error('Pending monitor publication does not match the committed baseline');
        }
        const recovery = recoverMonitorPublicationJournalUnderLock({
          journalPath: publicationJournalPath
        });
        if (!recovery.status.startsWith('completed')) {
          throw new Error(`Monitor publication recovery ended with ${recovery.status}`);
        }
      },
      onAbort: () => {
        if (fs.existsSync(publicationJournalPath)) {
          recoverMonitorPublicationJournalUnderLock({
            journalPath: publicationJournalPath
          });
          return;
        }
        for (const artifact of Object.values(stageArtifacts || {})) {
          unlinkIfExists(artifact.stagedPath);
          if (artifact.previous) unlinkIfExists(artifact.previous.path);
        }
      }
    });
    if (!baselineWrite.written) {
      return applyMonitorWriteDisposition(report, baselineWrite);
    }
    report = baselineWrite.report;
  }

  return report;
}
