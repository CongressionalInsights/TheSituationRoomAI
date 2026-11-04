const ERROR_CLASSES = new Set(['fetch_failed', 'invalid_response', 'empty_payload']);
const TRANSPORT_CODES = new Set([
  'timeout', 'ABORT_ERR', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
  'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
]);

export function buildFirmsPrimaryFailureDiagnostic(failure = {}) {
  const status = failure?.httpStatus;
  const upstreamStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  const codes = [failure?.code, failure?.cause?.code];
  const transportCode = upstreamStatus !== null ? null
    : failure?.name === 'AbortError' || failure?.name === 'TimeoutError' || failure?.code === 20
      ? 'timeout' : codes.find(code => TRANSPORT_CODES.has(code)) || null;
  // Construct the log from an allowlist; never serialize the error or provider response.
  const diagnostic = {
    event: 'firms_primary_failure',
    feedId: 'nasa-firms',
    errorClass: ERROR_CLASSES.has(failure?.error) ? failure.error : 'fetch_failed',
    upstreamStatus,
    transportCode
  };
  const payload = failure?.payloadDiagnostic;
  if (payload && typeof payload === 'object') {
    const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
    Object.assign(diagnostic, {
      responseFormat: ['csv', 'json'].includes(payload.responseFormat) ? payload.responseFormat : 'unknown',
      schemaRecognized: payload.schemaRecognized === true,
      parseCompleted: payload.parseCompleted === true,
      parsedRowCount: count(payload.parsedRowCount),
      normalizedItemCount: count(payload.normalizedItemCount)
    });
  }
  return diagnostic;
}

export function buildGdacsPrimaryFailureDiagnostic(failure = {}) {
  // Reuse the fixed status/transport allowlist without retaining RSS or error text.
  const bounded = buildFirmsPrimaryFailureDiagnostic(failure?.error === 'invalid_rss'
    ? { error: 'invalid_response', httpStatus: failure.httpStatus } : failure);
  return {
    event: 'gdacs_primary_failure', feedId: 'gdacs-alerts',
    errorClass: bounded.errorClass, upstreamStatus: bounded.upstreamStatus,
    transportCode: bounded.transportCode
  };
}
