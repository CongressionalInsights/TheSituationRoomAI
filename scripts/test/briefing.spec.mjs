import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { DEFAULT_BRIEFING_MODEL, BRIEFING_MAX_OUTPUT_TOKENS, BRIEFING_OUTPUT_TOKEN_CEILING, BRIEFING_TIMEOUT_MS, generateBriefing, inspectBriefingResponse, resolveBriefingProfile, resolveBriefingOutputLimit } from '../../gcp/openai-proxy/briefing.js';

const key = 'inert-briefing-fixture-key';
const input = [{ role: 'user', content: 'Four fixture headlines.' }];
const complete = (overrides = {}) => ({
  id: 'resp_briefing_fixture', model: DEFAULT_BRIEFING_MODEL, status: 'completed',
  reasoning: { effort: 'none' },
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Complete fixture briefing.' }] }],
  usage: { input_tokens: 80, output_tokens: 12, output_tokens_details: { reasoning_tokens: 0 } },
  ...overrides
});
const response = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });

function declaration(file, name, async = false) {
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf(`${async ? 'async ' : ''}function ${name}(`);
  assert.ok(start >= 0, `${file}: ${name}`);
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(end > start, name);
  return source.slice(start, end);
}

test('briefing config defaults to Terra and rejects lower or unreviewed model settings', () => {
  for (const value of [undefined, '', '  ']) assert.deepEqual(resolveBriefingProfile(value), { model: 'gpt-6.1-terra', reasoningEffort: 'none' });
  assert.deepEqual(resolveBriefingProfile(' gpt-6.1-terra '), { model: 'gpt-6.1-terra', reasoningEffort: 'none' });
  assert.deepEqual(resolveBriefingProfile('gpt-6.1-sol'), { model: 'gpt-6.1-sol', reasoningEffort: 'low' });
  assert.deepEqual(resolveBriefingProfile('gpt-6-astra'), { model: 'gpt-6-astra', reasoningEffort: 'low' });
  for (const value of ['gpt-4o-mini', 'gpt-5.2', 'gpt-6-luna', 'unreviewed-model', 'gpt-6.1-terra\nother']) assert.equal(resolveBriefingProfile(value), null);
});

test('briefing transport requests Terra with none,320tokens, fixed HTTPS and safe provenance', async () => {
  let calls = 0;
  const result = await generateBriefing({ apiKey: key, input, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.deepEqual(body, { model: DEFAULT_BRIEFING_MODEL, input, reasoning: { effort: 'none' }, max_output_tokens: 320 });
    return response(complete());
  } });
  assert.equal(calls, 1);
  assert.equal(result.text, 'Complete fixture briefing.');
  assert.equal(result.provenance.status, 'completed');
  assert.equal(result.provenance.modelVerified, true);
  assert.equal(result.provenance.requestedModel, result.provenance.servedModel);
  assert.equal(result.provenance.responseId, 'resp_briefing_fixture');
  assert.equal(result.provenance.usage.reasoningTokens, 0);
  assert.ok(!JSON.stringify(result).includes(key));
});

test('briefing output configuration is bounded, explicit and defaults to the existing ceiling', () => {
  for (const value of [undefined, null, '', '  ']) assert.equal(resolveBriefingOutputLimit(value), 320);
  for (const [value, expected] of [[320, 320], [' 1024 ', 1024], [4096, 4096]]) {
    assert.equal(resolveBriefingOutputLimit(value), expected);
  }
  assert.equal(BRIEFING_OUTPUT_TOKEN_CEILING, 4096);
  for (const value of [0, 319, 4097, -1, 1024.5, NaN, Infinity, true, {}, [], '1e3', '0x400', '1024 tokens']) {
    assert.equal(resolveBriefingOutputLimit(value), null, String(value));
  }
});

test('configured briefing output ceiling binds request, acceptance and provenance without retry', async () => {
  for (const outputTokens of [800, 1024, 1025]) {
    let calls = 0;
    const result = await generateBriefing({ apiKey: key, input, maxOutputTokens: '1024', fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(JSON.parse(options.body).max_output_tokens, 1024);
      return response(complete({ usage: { input_tokens: 80, output_tokens: outputTokens, output_tokens_details: { reasoning_tokens: 0 } } }));
    } });
    assert.equal(calls, 1);
    assert.equal(result.provenance.maxOutputTokens, 1024);
    assert.equal(result.provenance.status, outputTokens <= 1024 ? 'completed' : 'fallback');
    assert.equal(result.provenance.reason, outputTokens <= 1024 ? null : 'output_limit_exceeded');
  }
});

test('invalid briefing ceiling fails before acquisition and standalone inspection is bounded', async () => {
  let calls = 0;
  const result = await generateBriefing({ apiKey: key, input, maxOutputTokens: '4097', fetchImpl: async () => { calls++; return response(complete()); } });
  assert.equal(calls, 0);
  assert.equal(result.provenance.attempted, false);
  assert.equal(result.provenance.maxOutputTokens, null);
  assert.equal(result.provenance.reason, 'invalid_output_limit_config');
  assert.equal(inspectBriefingResponse(complete(), DEFAULT_BRIEFING_MODEL, 'bad').provenance.reason, 'invalid_output_limit_config');
  assert.equal(inspectBriefingResponse(complete({ usage: { output_tokens: 1025 } }), DEFAULT_BRIEFING_MODEL, 1024).provenance.reason, 'output_limit_exceeded');
});

test('explicit higher briefing profiles use low and omit unsupported temperature', async () => {
  for (const model of ['gpt-6.1-sol', 'gpt-6-astra']) {
    const result = await generateBriefing({ apiKey: key, input, model, temperature: 0.2, fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, model);
      assert.deepEqual(body.reasoning, { effort: 'low' });
      assert.equal(Object.hasOwn(body, 'temperature'), false);
      assert.equal(body.max_output_tokens, 320);
      return response(complete({ model, reasoning: { effort: 'low' } }));
    } });
    assert.equal(result.provenance.servedModel, model);
    assert.equal(result.provenance.servedReasoningEffort, 'low');
  }
});

test('dated snapshots retain distinct served identity, while wrong families and reasoning are rejected', async () => {
  const servedModel = 'gpt-6.1-terra-2026-11-05';
  const result = await generateBriefing({ apiKey: key, input, fetchImpl: async () => response(complete({ model: servedModel })) });
  assert.equal(result.provenance.requestedModel, DEFAULT_BRIEFING_MODEL);
  assert.equal(result.provenance.servedModel, servedModel);
  assert.equal(result.provenance.modelVerified, true);
  for (const model of ['gpt-6.1-terra-mini', 'gpt-6.1-terra-other-2026-11-05', 'gpt-4o-mini-2026-11-05']) {
    assert.equal(inspectBriefingResponse(complete({ model }), DEFAULT_BRIEFING_MODEL).provenance.reason, 'wrong_model');
  }
  const mismatch = await generateBriefing({ apiKey: key, input, fetchImpl: async () => response(complete({ reasoning: { effort: 'medium' } })) });
  assert.equal(mismatch.text, null);
  assert.equal(mismatch.provenance.reason, 'wrong_reasoning_effort');
});

test('missing key, skip and lower model config make no model request or lesser-model fallback', async () => {
  const fetchImpl = async () => { throw new Error('must not acquire'); };
  for (const [options, reason] of [[{}, 'missing_key'], [{ apiKey: key, skipReason: 'insufficient_headlines' }, 'insufficient_headlines'], [{ apiKey: key, model: 'gpt-4o-mini' }, 'unsupported_model_config']]) {
    const result = await generateBriefing({ input, fetchImpl, ...options });
    assert.equal(result.text, null);
    assert.equal(result.provenance.reason, reason);
    assert.equal(result.provenance.attempted, false);
    assert.equal(result.provenance.servedModel, null);
  }
});

test('briefing rejects incomplete, error, wrong-model, empty, refusal and malformed outputs', () => {
  const message = complete().output[0];
  const cases = [
    [complete({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), 'incomplete_response'],
    [complete({ error: { message: key } }), 'response_error'],
    [complete({ model: 'gpt-4o-mini' }), 'wrong_model'],
    [complete({ id: null }), 'invalid_response'],
    [complete({ output: [{ ...message, status: 'in_progress' }] }), 'incomplete_output'],
    [complete({ output: [{ ...message, content: [{ type: 'output_text', text: '   ' }] }] }), 'empty_output'],
    [complete({ output: [{ ...message, content: [{ type: 'refusal', refusal: 'Fixture refusal' }] }] }), 'invalid_output'],
    [complete({ output: null }), 'invalid_output'],
    [complete({ usage: { output_tokens: 321 } }), 'output_limit_exceeded']
  ];
  for (const [payload, reason] of cases) {
    const result = inspectBriefingResponse(payload, DEFAULT_BRIEFING_MODEL);
    assert.equal(result.text, null, reason);
    assert.equal(result.provenance.reason, reason);
    assert.ok(!JSON.stringify(result).includes(key));
  }
  const result = inspectBriefingResponse(complete({ output_text: 'Untrusted convenience field.' }), DEFAULT_BRIEFING_MODEL);
  assert.equal(result.text, 'Complete fixture briefing.');
});

test('HTTP, invalid JSON and transport errors retain bounded failure metadata with no retry', async () => {
  for (const [fetcher, reason] of [
    [async () => new Response(JSON.stringify({ error: { message: key } }), { status: 403 }), 'http_error'],
    [async () => new Response('{invalid'), 'invalid_json'],
    [async () => { throw new Error(key); }, 'transport_error']
  ]) {
    let calls = 0;
    const result = await generateBriefing({ apiKey: key, input, fetchImpl: (...args) => { calls++; return fetcher(...args); } });
    assert.equal(calls, 1);
    assert.equal(result.text, null);
    assert.equal(result.provenance.reason, reason);
    assert.equal(result.provenance.status, 'fallback');
    assert.ok(!JSON.stringify(result).includes(key));
  }
});

test('the20second technical timeout covers response-body acquisition, not only headers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let bodyStarted = false;
  const promise = generateBriefing({ apiKey: key, input, fetchImpl: async (_url, { signal }) => ({
    ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
      bodyStarted = true;
      signal.addEventListener('abort', () => reject(new Error('fixture abort')), { once: true });
    })
  }) });
  await Promise.resolve();
  assert.equal(bodyStarted, true);
  t.mock.timers.tick(BRIEFING_TIMEOUT_MS);
  const result = await promise;
  assert.equal(result.provenance.reason, 'timeout');
  assert.equal(result.text, null);
});

function staticFixture(env, fetchImpl) {
  const file = 'scripts/build_static_cache.mjs';
  const context = { Date, process: { env }, generateBriefing: options => generateBriefing({ ...options, fetchImpl }) };
  const code = ['decodeHtml', 'decodeJsonString', 'extractTitlesFromPayload'].map(name => declaration(file, name)).join('\n') + '\n' + declaration(file, 'buildAnalysis', true);
  vm.runInNewContext(code + '\nthis.build = buildAnalysis;', context);
  return context;
}
const headlineInput = (count, prefix = 'Fixture headline') => [{ feed: { name: 'Fixture source' }, payload: { body: JSON.stringify({ items: Array.from({ length: count }, (_, i) => ({ title: `${prefix} number ${i}` })) }) } }];

test('actual static briefing function selects configured request, deduplicates/caps60 and retains served proof', async () => {
  let calls = 0;
  const model = 'gpt-6.1-sol';
  const fixture = staticFixture({ OPEN_AI: key, OPENAI_API_KEY: 'ignored-inert-alias', SR_BRIEFING_MODEL: model }, async (_url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    const body = JSON.parse(options.body);
    assert.equal(body.model, model);
    assert.equal(body.reasoning.effort, 'low');
    assert.equal(body.input[1].content.split('\n').filter(l => l.startsWith('- ')).length, 60);
    assert.ok(!body.input[1].content.includes('number 69'));
    return response(complete({ model, reasoning: { effort: 'low' } }));
  });
  const data = await fixture.build([...headlineInput(70), ...headlineInput(8)]);
  assert.equal(calls, 1);
  assert.equal(data.source, 'openai');
  assert.equal(data.briefing.requestedModel, model);
  assert.equal(data.briefing.servedModel, model);
  assert.equal(data.text, 'Complete fixture briefing.');
});

test('actual static briefing passes the configured ceiling without changing its three-section input', async () => {
  const configured = staticFixture({ OPEN_AI: key, SR_BRIEFING_MAX_OUTPUT_TOKENS: '1024' }, async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.max_output_tokens, 1024);
    assert.match(body.input[1].content, /Return 3 bullet sections with short labels/);
    return response(complete({ usage: { output_tokens: 800 } }));
  });
  const result = await configured.build(headlineInput(4));
  assert.equal(result.source, 'openai');
  assert.equal(result.briefing.maxOutputTokens, 1024);
});

test('actual static builder preserves factual fallback for insufficient, absent-key, incomplete and wrong-model responses', async () => {
  let calls = 0;
  const mock = payload => async () => { calls++; return response(payload); };
  const short = await staticFixture({ OPEN_AI: key }, mock(complete())).build(headlineInput(3));
  assert.equal(short.source, 'fallback');
  assert.equal(short.briefing.reason, 'insufficient_headlines');
  assert.equal(calls, 0);
  const noKey = await staticFixture({}, mock(complete())).build(headlineInput(10));
  assert.equal(noKey.briefing.reason, 'missing_key');
  assert.equal(noKey.text.split('\n').length, 9);
  assert.equal(calls, 0);
  for (const [payload, reason] of [[complete({ status: 'incomplete' }), 'incomplete_response'], [complete({ model: 'gpt-4o-mini' }), 'wrong_model']]) {
    const data = await staticFixture({ OPENAI_API_KEY: key }, mock(payload)).build(headlineInput(4));
    assert.equal(data.source, 'fallback');
    assert.equal(data.briefing.reason, reason);
    assert.ok(data.text.startsWith('Top signals:'));
    assert.ok(!data.text.includes('Complete fixture briefing'));
  }
  assert.equal(calls, 2);
});

function routeFixture(file, payload, fetchImpl, env = {}) {
  const logs = [];
  const context = {
    process: { env }, OPENAI_URL: 'https://api.openai.com/v1/responses',
    console: { log: line => logs.push(line) }, fetch: fetchImpl,
    generateBriefing: options => generateBriefing({ ...options, fetchImpl }),
    readBody: async () => JSON.stringify(payload),
    sendJson: (_res, status, body) => ({ status, body })
  };
  vm.runInNewContext(declaration(file, 'handleChat', true) + '\nthis.handle = handleChat;', context);
  const invoke = () => file === 'server.mjs' ? context.handle(payload, key) : context.handle({ headers: { 'x-openai-key': key } }, {});
  return { invoke, logs };
}

for (const file of ['server.mjs', 'gcp/openai-proxy/server.js']) {
  test(`${file} takes the output ceiling only from server configuration`, async () => {
    let calls = 0;
    const route = routeFixture(file, { purpose: 'briefing', messages: input, maxOutputTokens: 4096, max_output_tokens: 4096 }, async (_url, options) => {
      calls++;
      assert.equal(JSON.parse(options.body).max_output_tokens, 1024);
      return response(complete({ usage: { output_tokens: 800 } }));
    }, { SR_BRIEFING_MAX_OUTPUT_TOKENS: '1024' });
    const result = await route.invoke();
    assert.equal(calls, 1);
    assert.equal(result.status, 200);
    assert.equal(result.body.briefing.maxOutputTokens, 1024);
    const invalid = routeFixture(file, { purpose: 'briefing', messages: input }, async () => { calls++; throw new Error('must not acquire'); }, { SR_BRIEFING_MAX_OUTPUT_TOKENS: '1e3' });
    const failure = await invalid.invoke();
    assert.equal(calls, 1);
    assert.equal(failure.status, 502);
    assert.equal(failure.body.briefing.reason, 'invalid_output_limit_config');
  });
  test(`${file} applies dedicated briefing configuration and refuses a lower configured model without acquisition`, async () => {
    let calls = 0;
    const fetchImpl = async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'gpt-6.1-sol');
      assert.equal(body.reasoning.effort, 'low');
      assert.equal(Object.hasOwn(body, 'temperature'), false);
      return response(complete({ model: 'gpt-6.1-sol', reasoning: { effort: 'low' } }));
    };
    const configured = routeFixture(file, { purpose: 'briefing', model: DEFAULT_BRIEFING_MODEL, messages: input }, fetchImpl, { SR_BRIEFING_MODEL: 'gpt-6.1-sol' });
    assert.equal((await configured.invoke()).status, 200);
    assert.equal(calls, 1);
    const rejected = routeFixture(file, { purpose: 'briefing', messages: input }, fetchImpl, { SR_BRIEFING_MODEL: 'gpt-4o-mini' });
    const result = await rejected.invoke();
    assert.equal(result.status, 502);
    assert.equal(result.body.briefing.reason, 'unsupported_model_config');
    assert.equal(calls, 1);
  });
  test(`${file} routes briefing purpose to dedicated model config while general chat stays unchanged`, async () => {
    let calls = 0;
    const payload = { purpose: 'briefing', model: 'gpt-4o-mini', messages: input, context: { fixture: true }, temperature: 0.2 };
    const route = routeFixture(file, payload, async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.equal(body.model, DEFAULT_BRIEFING_MODEL);
      assert.equal(body.reasoning.effort, 'none');
      assert.equal(body.max_output_tokens, BRIEFING_MAX_OUTPUT_TOKENS);
      assert.equal(body.temperature, 0.2);
      return response(complete());
    }, { OPENAI_MODEL: 'unrelated-chat-override' });
    const result = await route.invoke();
    assert.equal(result.status, 200);
    assert.equal(result.body.briefing.modelVerified, true);
    assert.equal(calls, 1);
    assert.ok(route.logs.length > 0);
    assert.ok(!route.logs.join('').includes(key));
    assert.ok(!route.logs.join('').includes('Four fixture headlines'));
    const chat = routeFixture(file, { messages: input }, async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'gpt-4o-mini');
      assert.equal(body.reasoning, undefined);
      return response({ id: 'resp_chat_fixture', model: 'gpt-4o-mini', output_text: 'Chat fixture.' });
    });
    assert.equal((await chat.invoke()).body.text, 'Chat fixture.');
  });
  test(`${file} retains incomplete briefing failure provenance without publishing partial text`, async () => {
    const route = routeFixture(file, { purpose: 'briefing', messages: input }, async () => response(complete({ status: 'incomplete' })));
    const result = await route.invoke();
    assert.equal(result.status, 502);
    assert.equal(result.body.error, 'briefing_unavailable');
    assert.equal(result.body.briefing.reason, 'incomplete_response');
    assert.equal(result.body.text, undefined);
  });
}

test('actual browser assistant path sends briefing purpose and rejects legacy/wrong/empty model results on both transports', async () => {
  const source = declaration('public/app.js', 'readAssistantText') + '\n' + declaration('public/app.js', 'callAssistant', true);
  const proof = { policy: 'terra-minimum-v1', status: 'completed', modelVerified: true, requestedModel: DEFAULT_BRIEFING_MODEL, servedModel: DEFAULT_BRIEFING_MODEL };
  for (const proxy of ['https://fixture.invalid/api/chat', '']) {
    let served = { text: 'Verified browser briefing.', model: DEFAULT_BRIEFING_MODEL, briefing: proof };
    const transport = async (_url, options) => {
      const payload = JSON.parse(options.body);
      assert.equal(payload.purpose, 'briefing');
      assert.equal(payload.model, DEFAULT_BRIEFING_MODEL);
      return response(served);
    };
    const context = { state: { analysisProvenance: null }, getOpenAiProxy: () => proxy, getClientOpenAiKey: () => key, isStaticMode: () => false, fetch: transport, apiFetch: transport };
    vm.runInNewContext(source + '\nthis.call = callAssistant;', context);
    assert.equal(await context.call({ purpose: 'briefing', messages: input }), 'Verified browser briefing.');
    assert.equal(context.state.analysisProvenance.requestedModel, DEFAULT_BRIEFING_MODEL);
    const snapshot = 'gpt-6.1-terra-2026-11-05';
    served = { text: 'Dated fixture briefing.', model: snapshot, briefing: { ...proof, servedModel: snapshot } };
    assert.equal(await context.call({ purpose: 'briefing', messages: input }), 'Dated fixture briefing.');
    for (const candidate of [{ text: 'Legacy response', model: 'gpt-4o-mini' }, { text: 'Wrong response', model: 'gpt-4o-mini', briefing: proof }, { text: ' ', model: DEFAULT_BRIEFING_MODEL, briefing: proof }]) {
      served = candidate;
      await assert.rejects(context.call({ purpose: 'briefing', messages: input }), /briefing_unverified/);
    }
    served = { text: 'Legacy proxy used the requested Terra hint.', model: DEFAULT_BRIEFING_MODEL };
    await assert.rejects(context.call({ purpose: 'briefing', messages: input, model: 'gpt-4o-mini' }), /briefing_unverified/);
  }
});

test('actual browser general-chat requests do not inherit briefing purpose or policy validation', async () => {
  const source = declaration('public/app.js', 'readAssistantText') + '\n' + declaration('public/app.js', 'callAssistant', true);
  const context = {
    state: { analysisProvenance: null }, getOpenAiProxy: () => 'https://fixture.invalid/api/chat', getClientOpenAiKey: () => key,
    fetch: async (_url, options) => {
      assert.equal(Object.hasOwn(JSON.parse(options.body), 'purpose'), false);
      return response({ text: 'General chat unchanged.', model: 'gpt-4o-mini' });
    }
  };
  vm.runInNewContext(source + '\nthis.call = callAssistant;', context);
  assert.equal(await context.call({ messages: input }), 'General chat unchanged.');
  assert.equal(context.state.analysisProvenance, null);
});

test('actual briefing button marks its request and preserves heuristic fallback/error state restoration', async () => {
  const button = { disabled: false, textContent: 'Briefing', classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {} };
  let fallback = 0, purpose;
  const context = {
    elements: { analysisRun: button }, state: { analysisRunning: false, analysisProvenance: { stale: true } }, hasAssistantAccess: () => true,
    setAnalysisMeta() {}, setAnalysisOutput() {}, buildChatContext: () => ({ fixture: true }),
    callAssistant: async options => { purpose = options.purpose; throw new Error('fixture model unavailable'); },
    normalizeOpenAIError: () => ({ message: 'Fixture unavailable' }), generateAnalysis: () => { fallback++; }
  };
  vm.runInNewContext(declaration('public/app.js', 'runAiAnalysis', true) + '\nthis.run = runAiAnalysis;', context);
  await context.run({ emitChat: false });
  assert.equal(purpose, 'briefing');
  assert.equal(fallback, 1);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Briefing');
  assert.equal(context.state.analysisRunning, false);
  assert.equal(context.state.analysisProvenance, null);
});

test('Pages and existing OpenAI proxy workflows share only the dedicated briefing variable/default', () => {
  for (const file of ['.github/workflows/deploy-pages.yml', '.github/workflows/deploy-openai-proxy.yml']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes("${{ vars.SR_BRIEFING_MODEL || 'gpt-6.1-terra' }}"), file);
    assert.ok(source.includes("${{ vars.SR_BRIEFING_MAX_OUTPUT_TOKENS || '320' }}"), file);
  }
  const pages = fs.readFileSync('.github/workflows/deploy-pages.yml', 'utf8');
  assert.ok(pages.includes('${{ secrets.OPEN_AI }}'));
  assert.ok(pages.includes('gcp/openai-proxy/briefing.js'));
  const proxy = fs.readFileSync('.github/workflows/deploy-openai-proxy.yml', 'utf8');
  assert.ok(proxy.includes('SR_BRIEFING_MAX_OUTPUT_TOKENS: process.env.SR_BRIEFING_MAX_OUTPUT_TOKENS'));
});

test('OpenAI deploy requires enabled existing secret metadata without reading or repairing credentials', () => {
  const source = fs.readFileSync('.github/workflows/deploy-openai-proxy.yml', 'utf8');
  assert.doesNotMatch(source, /secrets\.OPEN_AI|gcloud secrets (?:create|versions (?:access|add|enable|disable|destroy))/);
  assert.match(source, /--set-secrets OPENAI_API_KEY=openai-api-key:latest/);
  const block = source.match(/      - name: Require existing OpenAI secret\n        run: \|\n([\s\S]*?)(?=      - name:)/);
  assert.ok(block, 'actual metadata-only workflow prerequisite');
  const script = block[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
  const stub = `gcloud() {
    printf 'CALL:%s\\n' "$*" >&2
    if [ "$2" = describe ]; then return "$FIXTURE_SECRET_EXIT"; fi
    if [ "$2" = versions ] && [ "$3" = describe ]; then
      printf '%s' "$FIXTURE_VERSION_STATE"
      return "$FIXTURE_VERSION_EXIT"
    fi
    return 99
  }`;
  for (const [secretExit, versionExit, state, pass, count] of [[0, 0, 'ENABLED', true, 2], [1, 0, 'ENABLED', false, 1], [0, 1, '', false, 2], [0, 0, 'DISABLED', false, 2], [0, 0, 'DESTROYED', false, 2]]) {
    const result = spawnSync('bash', ['-c', `${stub}\n${script}`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, PROJECT_ID: 'fixture-project', FIXTURE_SECRET_EXIT: String(secretExit), FIXTURE_VERSION_EXIT: String(versionExit), FIXTURE_VERSION_STATE: state }
    });
    assert.equal(result.status === 0, pass, result.stderr);
    const calls = result.stderr.split('\n').filter(line => line.startsWith('CALL:'));
    assert.deepEqual(calls, [
      'CALL:secrets describe openai-api-key --project fixture-project',
      'CALL:secrets versions describe latest --secret openai-api-key --project fixture-project --format=value(state)'
    ].slice(0, count));
    assert.equal(result.stdout, '');
  }
});
