const EIA_FEED_IDS = new Set(['energy-eia', 'energy-eia-brent', 'energy-eia-ng']);

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
  return String(value || '').replace(/([?&]\s*api[_-]?key=)[^&\s"'<>]+/gi, '$1REDACTED');
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
