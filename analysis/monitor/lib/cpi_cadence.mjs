function monthIndex(period) {
  const match = /^(\d{4})-M(0[1-9]|1[0-2])$/.exec(period || '');
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
}

function calendarReleases(schedule) {
  if (schedule?.seriesId !== 'CUUR0000SA0' || !Array.isArray(schedule.releases) || schedule.releases.length < 2) return [];
  const releases = schedule.releases.map((release) => ({
    ...release,
    month: monthIndex(release?.period),
    timestamp: typeof release?.scheduledAt === 'string'
      && /^\d{4}-\d{2}-\d{2}T08:30:00-0[45]:00$/.test(release.scheduledAt)
      ? Date.parse(release.scheduledAt) : NaN
  }));
  return releases.every((release, index) => release.month !== null && Number.isFinite(release.timestamp)
    && new Date(release.timestamp - Number(release.scheduledAt.slice(-5, -3)) * 3600000).toISOString().slice(0, 19) === release.scheduledAt.slice(0, 19)
    && (!index || (release.month === releases[index - 1].month + 1 && release.timestamp > releases[index - 1].timestamp)))
    ? releases : [];
}

function collectionState(summary) {
  return summary?.error || summary?.parseError || (summary?.httpStatus && summary.httpStatus !== 200) ? 'unavailable'
    : summary?.fallback || summary?.fallbackUsed ? 'fallback'
      : summary?.stale ? 'stale' : 'available';
}

export function summarizeCpiPublication(entry, signals, inspection, raw, proxy, now = Date.now()) {
  if (entry.id !== 'bls-cpi' || !entry.publicationSchedule) return null;
  const schedule = entry.publicationSchedule;
  const releases = calendarReleases(schedule);
  const due = releases.filter((release) => release.timestamp <= now).at(-1);
  const next = releases.find((release) => release.timestamp > now);
  const covered = Boolean(due && next);
  // Only returned, intrinsically valid numeric observations can prove cadence.
  const usable = signals.error || inspection.invalidCount || inspection.fabricatedCount ? []
    : signals.items.filter((item) => item.seriesId === schedule.seriesId && item.valueStatus === 'available'
      && Number.isFinite(item.value) && monthIndex(item.period) !== null);
  const newest = usable.sort((a, b) => monthIndex(b.period) - monthIndex(a.period))[0];
  let status = 'current';
  if (inspection.invalidCount || inspection.fabricatedCount) status = 'unusable';
  else if (signals.error || !newest) status = 'unavailable';
  else if (!covered) status = 'unknown-schedule';
  else if (monthIndex(newest.period) > due.month) status = 'unexpected-period';
  else if (!usable.some((item) => item.period === due.period)) status = 'missing';
  return {
    status,
    seriesId: schedule.seriesId,
    scheduleSource: schedule.sourceUrl || null,
    scheduleCheckedAt: schedule.checkedAt || null,
    scheduleCoverage: covered ? 'covered' : 'unknown',
    expectedPeriod: due?.period ?? null,
    scheduledPublicationAt: due?.scheduledAt ?? null,
    nextScheduledPublicationAt: next?.scheduledAt ?? null,
    observedPeriod: newest?.period ?? null,
    observationDate: newest?.observationDate ?? null,
    observationAgeMinutes: newest ? Math.round((now - newest.publishedAt) / 60000) : null,
    actualPublicationAt: null,
    collectionAvailability: {
      proxy: collectionState(proxy),
      raw: collectionState(raw),
      signals: collectionState(signals)
    }
  };
}
