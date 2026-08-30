const CREDENTIAL_FIELD_NAMES = new Set([
  'apikey',
  'authorization',
  'clientsecret',
  'password',
  'secret',
  'xapikey'
]);

function normalizeFieldName(name) {
  return String(name || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function isCredentialFieldName(name) {
  return CREDENTIAL_FIELD_NAMES.has(normalizeFieldName(name));
}

export function redactCredentialFields(value) {
  if (typeof value === 'string') {
    return value.replace(/([?&]\s*(?:api[_-]?key|x-api-key|client_secret|password|secret)=)[^&\s"'<>]+/gi, '$1REDACTED');
  }
  if (Array.isArray(value)) return value.map((entry) => redactCredentialFields(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    isCredentialFieldName(key) ? 'REDACTED' : redactCredentialFields(entry)
  ]));
}

export function removeCredentialFields(value) {
  if (typeof value === 'string') return redactCredentialFields(value);
  if (Array.isArray(value)) return value.map((entry) => removeCredentialFields(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isCredentialFieldName(key))
    .map(([key, entry]) => [key, removeCredentialFields(entry)]));
}

export function sanitizeEiaBody(body) {
  if (typeof body !== 'string') return body;
  try {
    return JSON.stringify(removeCredentialFields(JSON.parse(body)));
  } catch {
    return redactCredentialFields(body);
  }
}
