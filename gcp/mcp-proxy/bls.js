export const BLS_CPI_URL = 'https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0';

export function inspectBlsPayload(input, expectedSeriesId = null) {
  let parsed;
  try { parsed = typeof input === 'string' ? JSON.parse(input) : input; } catch {}
  const apiSuccess = parsed?.status === 'REQUEST_SUCCEEDED';
  const results = Array.isArray(parsed?.Results) ? parsed.Results : [parsed?.Results];
  const series = results.flatMap(result => Array.isArray(result?.series) ? result.series : []);
  const rows = series.flatMap(entry => Array.isArray(entry?.data) ? entry.data : []);
  const schemaValid = results.every(result => result && !result.error && !result.errors && Array.isArray(result.series))
    && series.length > 0 && series.every(entry => entry && typeof entry === 'object'
    && !Array.isArray(entry) && !entry.error && !entry.errors &&
    typeof entry?.seriesID === 'string' && /^[A-Z0-9_#-]+$/.test(entry.seriesID)
    && Array.isArray(entry.data) && entry.data.length > 0
    && entry.data.every(row => row && typeof row === 'object' && !row.error && !row.errors
      && /^\d{4}$/.test(String(row.year || ''))
      && /^M(?:0[1-9]|1[0-3])$/.test(row.period || '')
      && Object.hasOwn(row, 'value')
      && (row.value === null || typeof row.value === 'string' || typeof row.value === 'number')))
    && (!expectedSeriesId || (series.length === 1 && series[0].seriesID === expectedSeriesId));
  // Provider prose can echo registration keys. Return only locally owned messages.
  const error = !parsed || typeof parsed !== 'object' || Array.isArray(parsed) ? 'invalid_json'
    : !apiSuccess || parsed.error || parsed.errors ? 'bls_api_error'
      : !schemaValid ? 'invalid_bls_series' : null;
  return {
    apiSuccess, schemaValid, seriesCount: series.length, observationCount: rows.length,
    apiStatus: ['REQUEST_SUCCEEDED', 'REQUEST_NOT_PROCESSED', 'REQUEST_FAILED'].includes(parsed?.status) ? parsed.status : null,
    error, message: error === 'bls_api_error' ? 'BLS API did not return a successful series response.'
      : error === 'invalid_bls_series' ? 'BLS response has absent, empty, mismatched or malformed series.'
        : error ? 'BLS returned invalid JSON.' : null
  };
}

export function getBlsApiError(input, expectedSeriesId = null) {
  return inspectBlsPayload(input, expectedSeriesId).message;
}

export function sanitizeBlsBody(input, expectedSeriesId = null) {
  const inspection = inspectBlsPayload(input, expectedSeriesId);
  if (inspection.error) return JSON.stringify({ status: inspection.apiStatus, error: inspection.error, message: inspection.message });
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  return JSON.stringify({ ...parsed, message: [] }, (key, value) =>
    ['registrationkey', 'apikey'].includes(key.replace(/[^a-z0-9]/gi, '').toLowerCase()) ? undefined : value);
}

export function isDefaultBlsRequest(feed, { key, keyParam, keyHeader, query, params, history, start, end, proxy } = {}) {
  return feed?.id === 'bls-cpi' && feed.url === BLS_CPI_URL
    && !key && !keyParam && !keyHeader && !query && !history && !start && !end && !proxy
    && (!params || Object.keys(params).length === 0);
}
