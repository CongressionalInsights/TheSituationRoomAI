const EIA_FEED_IDS = new Set(['energy-eia', 'energy-eia-brent', 'energy-eia-ng']);

const URL_CREDENTIAL_FIELDS = new Set([
  'apikey', 'key', 'token', 'accesstoken', 'authorization', 'clientsecret', 'password', 'secret', 'xapikey'
]);
const MAX_DIAGNOSTIC_DEPTH = 8;
const MAX_DIAGNOSTIC_LENGTH = 65536;
const MAX_DIAGNOSTIC_NODES = 256;

function isUrlCredentialField(name) {
  let decoded = name;
  for (let depth = 0; depth < MAX_DIAGNOSTIC_DEPTH; depth += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return URL_CREDENTIAL_FIELDS.has(decoded.replace(/[^a-z0-9]/gi, '').toLowerCase());
      decoded = next;
    } catch {
      return true;
    }
  }
  return true;
}

function isNestedDiagnosticUrl(value) {
  return /^https?(?::|%)/i.test(value)
    || ((value.includes('?') || value.includes('&') || /%(?:25)*(?:3f|26)/i.test(value))
      && (value.includes('=') || /%(?:25)*3d/i.test(value)));
}

function redactUrl(rawUrl, depth, budget) {
  if (depth >= MAX_DIAGNOSTIC_DEPTH || --budget.remaining < 0 || rawUrl.length > MAX_DIAGNOSTIC_LENGTH) {
    return 'REDACTED';
  }
  const redactValue = (key, value) => isUrlCredentialField(key) ? 'REDACTED'
    : isNestedDiagnosticUrl(value) ? redactUrl(value, depth + 1, budget) : value;
  const redactPath = (value) => value.replace(/(\/api\/area\/(?:json|csv)\/)[^/]+/i, '$1REDACTED');
  let parsed;
  try { parsed = new URL(rawUrl); } catch {}
  if (parsed) {
    let changed = false;
    const params = new URLSearchParams();
    for (const [key, value] of parsed.searchParams) {
      const safe = redactValue(key, value);
      params.append(key, safe);
      if (safe !== value) changed = true;
    }
    if (changed) parsed.search = params.toString();
    if (parsed.username || parsed.password) {
      if (parsed.username) parsed.username = 'REDACTED';
      if (parsed.password) parsed.password = 'REDACTED';
      changed = true;
    }
    const pathname = redactPath(parsed.pathname);
    if (pathname !== parsed.pathname) { parsed.pathname = pathname; changed = true; }
    if (isNestedDiagnosticUrl(parsed.hash.slice(1))) {
      const hash = redactUrl(parsed.hash.slice(1), depth + 1, budget);
      if (hash !== parsed.hash.slice(1)) { parsed.hash = hash; changed = true; }
    }
    return changed ? parsed.toString() : rawUrl;
  }
  const question = rawUrl.indexOf('?');
  if (question >= 0) {
    const fragment = rawUrl.indexOf('#', question);
    const end = fragment < 0 ? rawUrl.length : fragment;
    const params = new URLSearchParams(rawUrl.slice(question + 1, end));
    const safeParams = new URLSearchParams();
    let changed = false;
    for (const [key, value] of params) {
      const safe = redactValue(key, value);
      safeParams.append(key, safe);
      if (safe !== value) changed = true;
    }
    const path = redactPath(rawUrl.slice(0, question));
    return path + (changed ? `?${safeParams}` : rawUrl.slice(question, end)) + rawUrl.slice(end);
  }
  // Encoded wrapper values may themselves be encoded URLs. Never return an
  // undecodable URL-shaped value whose credential boundary cannot be inspected.
  if (/%[0-9a-f]{2}/i.test(rawUrl)) {
    try {
      const decoded = decodeURIComponent(rawUrl);
      if (decoded !== rawUrl) {
        const safe = redactUrl(decoded, depth + 1, budget);
        return safe === decoded ? rawUrl : encodeURIComponent(safe);
      }
    } catch {
      if (isNestedDiagnosticUrl(rawUrl)) return 'REDACTED';
    }
  }
  return redactPath(rawUrl);
}

export function redactDiagnosticUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return rawUrl;
  return redactUrl(rawUrl, 0, { remaining: MAX_DIAGNOSTIC_NODES });
}

function redactUnstructuredText(value, budget) {
  return value.replace(/https?(?::\/\/|%(?:25)*3a)[^\s"'<>\\]+/gi, (url) => redactUrl(url, 0, budget))
    .replace(/([?&])([^=?&#\s"'<>]+)=([^&#\s"'<>]*)/g, (match, separator, key) =>
      isUrlCredentialField(key) ? `${separator}${key}=REDACTED` : match);
}

export function redactDiagnosticText(value) {
  if (typeof value !== 'string') return value;
  if (value.length > MAX_DIAGNOSTIC_LENGTH) return 'REDACTED';
  const budget = { remaining: MAX_DIAGNOSTIC_NODES };
  let parsed;
  try { parsed = JSON.parse(value); } catch { return redactUnstructuredText(value, budget); }
  // Preserve JSON escaping so subsequent source-specific field sanitization
  // still parses the diagnostic instead of falling back to unstructured text.
  let changed = false;
  const exhausted = Symbol('diagnostic traversal exhausted');
  const redactJson = (entry, depth) => {
    if (depth >= MAX_DIAGNOSTIC_DEPTH || --budget.remaining < 0) throw exhausted;
    if (typeof entry === 'string') {
      const safe = redactUnstructuredText(entry, budget);
      if (safe !== entry) changed = true;
      return safe;
    }
    if (Array.isArray(entry)) return entry.map((item) => redactJson(item, depth + 1));
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, redactJson(item, depth + 1)]));
    }
    return entry;
  };
  try {
    const safe = redactJson(parsed, 0);
    return changed ? JSON.stringify(safe) : value;
  } catch (error) {
    if (error === exhausted) return 'REDACTED';
    throw error;
  }
}

export function sanitizeDiagnosticPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  return {
    ...payload,
    ...(typeof payload.fetchedUrl === 'string' ? { fetchedUrl: redactDiagnosticUrl(payload.fetchedUrl) } : {}),
    ...(typeof payload.message === 'string' ? { message: redactDiagnosticText(payload.message) } : {}),
    ...(payload.error && typeof payload.body === 'string' ? { body: redactDiagnosticText(payload.body) } : {})
  };
}

function isEiaCredentialField(name) {
  return String(name || '').replace(/[^a-z0-9]/gi, '').toLowerCase() === 'apikey';
}

function stripEiaCredentialFields(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    value.forEach((entry) => stripEiaCredentialFields(entry));
    return value;
  }
  Object.keys(value).forEach((key) => {
    if (isEiaCredentialField(key)) {
      delete value[key];
      return;
    }
    stripEiaCredentialFields(value[key]);
  });
  return value;
}

function redactEiaCredentialText(value) {
  return String(value || '')
    .replace(/([?&]\s*api[_-]?key=)[^&\s"'<>]+/gi, '$1REDACTED')
    .replace(/((?:%3f|%26)api(?:_|-|%5f)?key%3d)(?:(?!%26)[^&\s"'<>])+/gi, '$1REDACTED');
}

export function isEiaFeed(feed) {
  return feed?.keyGroup === 'eia' || EIA_FEED_IDS.has(feed?.id);
}

export function sanitizeEiaBody(body) {
  if (typeof body !== 'string') return body;
  try {
    const parsed = JSON.parse(body);
    return JSON.stringify(stripEiaCredentialFields(parsed));
  } catch {
    return redactEiaCredentialText(body);
  }
}

export function sanitizeEiaPayload(feed, payload) {
  if (!isEiaFeed(feed) || !payload || typeof payload !== 'object') return payload;
  return {
    ...payload,
    body: sanitizeEiaBody(payload.body),
    message: typeof payload.message === 'string' ? sanitizeEiaBody(payload.message) : payload.message,
    fetchedUrl: typeof payload.fetchedUrl === 'string' ? redactEiaCredentialText(payload.fetchedUrl) : payload.fetchedUrl
  };
}
