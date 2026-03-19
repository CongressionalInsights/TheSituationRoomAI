import fs from 'node:fs';

const plan = JSON.parse(process.env.MOCK_FETCH_PLAN || '[]');
const logPath = process.env.MOCK_FETCH_LOG || '';
const calls = [];
let index = 0;

function writeCalls() {
  if (!logPath) return;
  fs.writeFileSync(logPath, JSON.stringify(calls, null, 2));
}

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), String(value)])
  );
}

globalThis.fetch = async (url, options = {}) => {
  const entry = plan[index++];
  const record = {
    url: String(url),
    method: String(options.method || 'GET').toUpperCase(),
    headers: normalizeHeaders(options.headers || {}),
    body: typeof options.body === 'string' ? options.body : null
  };
  calls.push(record);
  writeCalls();

  if (!entry) {
    throw new Error(`Unexpected fetch: ${record.url}`);
  }
  if (entry.match && !record.url.includes(entry.match)) {
    throw new Error(`Expected fetch containing "${entry.match}" but got "${record.url}"`);
  }
  if (entry.throw) {
    const error = new Error(entry.throw.message || 'mock fetch failed');
    if (entry.throw.code) error.code = entry.throw.code;
    throw error;
  }

  return new Response(entry.body ?? '', {
    status: entry.status ?? 200,
    headers: entry.headers || { 'content-type': 'application/json; charset=utf-8' }
  });
};
