export const DEFAULT_BRIEFING_MODEL = 'gpt-6.1-terra';
export const BRIEFING_MAX_OUTPUT_TOKENS = 320;
export const BRIEFING_TIMEOUT_MS = 20000;

// Higher profiles require their supported effort, never Terra's `none` by inheritance.
const MODEL_PROFILES = Object.freeze({
  'gpt-6.1-terra': 'none',
  'gpt-6.1-sol': 'low',
  'gpt-6-astra': 'low'
});

function safeIdentifier(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value) ? value : null;
}

export function resolveBriefingProfile(configuredModel) {
  const model = typeof configuredModel === 'string' ? configuredModel.trim() : '';
  const selected = model || DEFAULT_BRIEFING_MODEL;
  if (!Object.hasOwn(MODEL_PROFILES, selected)) return null;
  return { model: selected, reasoningEffort: MODEL_PROFILES[selected] };
}

export function matchesBriefingModel(requestedModel, servedModel) {
  if (requestedModel === servedModel) return true;
  if (typeof requestedModel !== 'string' || typeof servedModel !== 'string') return false;
  const prefix = `${requestedModel}-`;
  const snapshot = servedModel.startsWith(prefix) ? servedModel.slice(prefix.length) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(snapshot);
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function inspectBriefingResponse(data, requestedModel) {
  const provenance = {
    responseId: safeIdentifier(data?.id),
    servedModel: safeIdentifier(data?.model),
    responseStatus: typeof data?.status === 'string' ? safeIdentifier(data.status) : null,
    servedReasoningEffort: safeIdentifier(data?.reasoning?.effort),
    usage: {
      inputTokens: tokenCount(data?.usage?.input_tokens),
      outputTokens: tokenCount(data?.usage?.output_tokens),
      reasoningTokens: tokenCount(data?.usage?.output_tokens_details?.reasoning_tokens)
    }
  };
  const reject = reason => ({ text: null, provenance: { ...provenance, reason } });
  if (!data || typeof data !== 'object' || data.error) return reject('response_error');
  if (!provenance.responseId) return reject('invalid_response');
  if (data.status !== 'completed' || data.incomplete_details) return reject('incomplete_response');
  if (!matchesBriefingModel(requestedModel, data.model)) return reject('wrong_model');
  if (provenance.usage.outputTokens > BRIEFING_MAX_OUTPUT_TOKENS) return reject('output_limit_exceeded');
  if (!Array.isArray(data.output)) return reject('invalid_output');
  const messages = data.output.filter(item => item?.type === 'message');
  if (!messages.length) return reject('empty_output');
  const text = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || message.status !== 'completed' || !Array.isArray(message.content)) return reject('incomplete_output');
    for (const content of message.content) {
      if (content?.type !== 'output_text' || typeof content.text !== 'string') return reject('invalid_output');
      text.push(content.text);
    }
  }
  const completeText = text.join('\n').trim();
  if (!completeText) return reject('empty_output');
  return { text: completeText, provenance: { ...provenance, reason: null } };
}

export async function generateBriefing({ apiKey, input, model, temperature, skipReason, fetchImpl = fetch } = {}) {
  const profile = resolveBriefingProfile(model);
  const provenance = {
    policy: 'terra-minimum-v1',
    requestedModel: profile?.model || safeIdentifier(typeof model === 'string' ? model.trim() : null),
    requestedReasoningEffort: profile?.reasoningEffort || null,
    maxOutputTokens: BRIEFING_MAX_OUTPUT_TOKENS,
    attempted: false,
    status: 'fallback',
    modelVerified: false,
    responseId: null,
    servedModel: null,
    responseStatus: null,
    servedReasoningEffort: null,
    httpStatus: null,
    reason: null
  };
  const fallback = reason => ({ text: null, provenance: { ...provenance, reason } });
  if (!profile) return fallback('unsupported_model_config');
  if (skipReason) return fallback(skipReason);
  if (typeof apiKey !== 'string' || !apiKey.trim()) return fallback('missing_key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIEFING_TIMEOUT_MS);
  try {
    const body = {
      model: profile.model,
      input,
      reasoning: { effort: profile.reasoningEffort },
      max_output_tokens: BRIEFING_MAX_OUTPUT_TOKENS
    };
    if (profile.reasoningEffort === 'none' && Number.isFinite(temperature)) body.temperature = temperature;
    provenance.attempted = true;
    const response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    provenance.httpStatus = response.status;
    if (!response.ok) return fallback('http_error');
    const inspected = inspectBriefingResponse(await response.json(), profile.model);
    Object.assign(provenance, inspected.provenance);
    if (!inspected.text) return fallback(inspected.provenance.reason);
    if (provenance.servedReasoningEffort && provenance.servedReasoningEffort !== profile.reasoningEffort) return fallback('wrong_reasoning_effort');
    return { text: inspected.text, provenance: { ...provenance, status: 'completed', modelVerified: true } };
  } catch (error) {
    return fallback(controller.signal.aborted ? 'timeout' : error instanceof SyntaxError ? 'invalid_json' : 'transport_error');
  } finally {
    clearTimeout(timer);
  }
}
