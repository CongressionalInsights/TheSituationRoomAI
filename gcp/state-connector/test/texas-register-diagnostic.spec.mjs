import assert from 'node:assert/strict';
import test from 'node:test';
import { describeTexasRegisterFailure } from '../texas-register-diagnostic.js';

function failure(body, headers, url = 'https://www.sos.texas.gov/texreg/sos/index.html') {
  const response = new Response(body, { status: 405, headers });
  Object.defineProperties(response, {
    url: { value: url },
    redirected: { value: true }
  });
  return response;
}

test('Texas Register diagnostic classifies a CloudFront/S3 response without disclosing it', async () => {
  const event = await describeTexasRegisterFailure(failure(
    '<Error><Code>MethodNotAllowed</Code><RequestId>private-body-value</RequestId></Error>',
    {
      'Content-Type': 'application/xml; charset=utf-8',
      Server: 'AmazonS3',
      Allow: 'HEAD, OPTIONS, private-header-value, HEAD',
      Via: '1.1 private-edge.cloudfront.net (CloudFront)',
      'X-Amz-Cf-Id': 'private-edge-id',
      'Set-Cookie': 'private-cookie'
    },
    'https://www.sos.texas.gov/texreg/sos/index.html?token=private-query'
  ));
  assert.deepEqual(event, {
    severity: 'WARNING', message: 'texas_register_upstream_failure', method: 'GET', status: 405,
    redirected: true, finalHost: 'www.sos.texas.gov', finalPath: 'current_issue',
    contentType: 'application/xml', server: 'amazons3', allow: ['HEAD', 'OPTIONS'],
    cloudFrontVia: true, cloudFrontResponseHeader: true, cloudFrontErrorMarker: false,
    s3MethodNotAllowedMarker: true, s3AccessDeniedMarker: false, methodNotAllowedMarker: true,
    challengeMarker: false, bodyPrefixState: 'complete'
  });
  assert.doesNotMatch(JSON.stringify(event), /private-/);
});

test('Texas Register diagnostic discards unknown metadata and cancels after the bounded prefix', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(4096) + '<Code>AccessDenied</Code>'));
    },
    cancel() { cancelled = true; }
  });
  const event = await describeTexasRegisterFailure(failure(body,
    { Server: 'private-host-value', 'Content-Type': 'application/private-type', 'CF-Mitigated': 'challenge' },
    'https://user:pass@private-host.invalid/path?code=private-query'));
  assert.equal(event.finalHost, 'other');
  assert.equal(event.finalPath, 'other');
  assert.equal(event.server, 'other');
  assert.equal(event.contentType, 'other');
  assert.equal(event.s3AccessDeniedMarker, false);
  assert.equal(event.challengeMarker, true);
  assert.equal(event.bodyPrefixState, 'capped');
  assert.equal(cancelled, true);
  assert.doesNotMatch(JSON.stringify(event), /private-|user:pass/);
});

test('Texas Register diagnostic preserves status and headers when reading the body fails', async () => {
  const body = new ReadableStream({
    start(controller) { controller.error(new Error('private-cause')); }
  });
  const event = await describeTexasRegisterFailure(failure(body,
    { Server: 'CloudFront' }, 'https://www.sos.state.tx.us/texreg/archive/November272026/index.html'));
  assert.equal(event.status, 405);
  assert.equal(event.server, 'cloudfront');
  assert.equal(event.finalHost, 'www.sos.state.tx.us');
  assert.equal(event.finalPath, 'archive_issue');
  assert.equal(event.bodyPrefixState, 'read_failed');
  assert.doesNotMatch(JSON.stringify(event), /private-cause/);
});

test('only the current issue failure emits the diagnostic and the caller still sees a 502', async (t) => {
  const key = 'synthetic-inbound-key';
  t.mock.method(console, 'log', () => {});
  const originalKey = process.env.API_KEY;
  process.env.API_KEY = key;
  t.after(() => {
    if (originalKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = originalKey;
  });
  const { handleRequest } = await import('../server.js');
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.method, undefined);
    assert.equal(new Headers(options.headers).has('x-api-key'), false);
    return failure('<Code>MethodNotAllowed</Code>', { Server: 'AmazonS3' }, url);
  });

  async function signalRequest(type) {
    const req = { method: 'GET', url: `/signals?state=TX&signalType=${type}`, headers: { 'x-api-key': key } };
    const res = {
      setHeader() {},
      writeHead(status) { this.statusCode = status; },
      end(text) { this.body = JSON.parse(text); }
    };
    await handleRequest(req, res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.error, 'upstream_unavailable');
    assert.equal(res.body.meta.verifiedZeroResults, false);
    assert.doesNotMatch(JSON.stringify(res.body), /texas_register_upstream_failure|amazons3/);
  }

  await signalRequest('rulemaking');
  await signalRequest('executive_order');
  assert.equal(fetchMock.mock.callCount(), 2);
  const records = console.log.mock.calls.map(({ arguments: [row] }) => JSON.parse(row));
  const diagnostic = records.filter((row) => row.message === 'texas_register_upstream_failure');
  assert.equal(diagnostic.length, 1);
  assert.equal(diagnostic[0].status, 405);
  assert.equal(diagnostic[0].finalPath, 'current_issue');
});
