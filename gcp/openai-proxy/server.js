import http from 'http';

const PORT = process.env.PORT || 8080;
const OPENAI_URL = 'https://api.openai.com/v1/responses';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://congressionalinsights.github.io,http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean);

function setCors(res, origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  res.setHeader('Access-Control-Allow-Origin', allowed || ALLOWED_ORIGINS[0] || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-openai-key');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
}

function sendJson(res, status, payload, origin) {
  setCors(res, origin);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleChat(req, res) {
  const origin = req.headers.origin || '';
  const headerKey = req.headers['x-openai-key'];
  const apiKey = (Array.isArray(headerKey) ? headerKey[0] : headerKey) || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return sendJson(res, 401, { error: 'missing_api_key', message: 'OpenAI key missing.' }, origin);
  }

  let bodyText = '';
  try {
    bodyText = await readBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: 'bad_request', message: 'Could not read request body.' }, origin);
  }

  let payload = {};
  try {
    payload = JSON.parse(bodyText || '{}');
  } catch (err) {
    return sendJson(res, 400, { error: 'bad_request', message: 'Invalid JSON.' }, origin);
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const model = payload.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const temperature = Number.isFinite(payload.temperature) ? payload.temperature : 0.2;
  const context = payload.context ? JSON.stringify(payload.context) : '';

  const input = [
    {
      role: 'system',
      content: 'You are the Situation Room assistant. Keep responses concise and actionable. Use feed/source names when referencing signals.'
    }
  ];

  if (context) {
    input.push({ role: 'system', content: `Context snapshot: ${context}` });
  }
  input.push(...messages);

  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model, input, temperature, max_output_tokens: 400 })
    });

    const data = await response.json();
    if (!response.ok) {
      return sendJson(res, response.status, { error: 'openai_error', message: data?.error?.message || 'OpenAI request failed.' }, origin);
    }

    const text = data.output_text
      || data.output?.map((item) => item.content?.map((c) => c.text).join('')).join('')
      || '';

    return sendJson(res, 200, { id: data.id, model: data.model, text }, origin);
  } catch (err) {
    return sendJson(res, 500, { error: 'proxy_error', message: err.message || 'Proxy error' }, origin);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (req.method === 'OPTIONS') {
    setCors(res, origin);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health') {
    return sendJson(res, 200, { ok: true }, origin);
  }

  if (req.url === '/api/chat' && req.method === 'POST') {
    return handleChat(req, res);
  }

  return sendJson(res, 404, { error: 'not_found' }, origin);
});

server.listen(PORT, () => {
  console.log(`OpenAI proxy listening on ${PORT}`);
});
