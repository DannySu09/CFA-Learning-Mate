/* OpenAI-compatible LLM client.
 * Supports both the Chat Completions API (POST /chat/completions) and the
 * Responses API (POST /responses), selectable per request via apiStyle.
 */

const LLM_TIMEOUT_MS = 120_000;

// Endpoints (style|origin|model) that rejected thinking-control params with
// 400/422. Remembered for the session so the plain-body retry happens at
// most once — later calls skip the params instead of failing again.
const fastModeUnsupported = new Set();

function isDeepSeekRequest({ model, apiBaseUrl }) {
  return /deepseek/i.test(String(model ?? '')) || /deepseek\.com/i.test(String(apiBaseUrl ?? ''));
}

// There is no cross-provider standard for turning reasoning off: OpenAI uses
// reasoning_effort (chat) / reasoning.effort (responses), DeepSeek uses
// thinking.type, Qwen uses enable_thinking, and OpenRouter-style gateways
// normalize reasoning.enabled. Pick the params the model name implies; {}
// when nothing safe matches, so non-reasoning models stay untouched.
// Unsupported guesses are caught by the 400/422 fallback in llmChat.
function fastModeParams({ model, apiBaseUrl, apiStyle }) {
  const m = String(model ?? '');
  const responses = apiStyle === 'responses';
  if (isDeepSeekRequest({ model, apiBaseUrl })) {
    return responses ? { reasoning: { effort: 'none' } } : { thinking: { type: 'disabled' } };
  }
  if (/qwen/i.test(m)) {
    return responses ? {} : { enable_thinking: false };
  }
  if (m.includes('/')) { // OpenRouter-style "vendor/model" names
    return { reasoning: { enabled: false, exclude: true } };
  }
  if (/gpt-5/i.test(m)) {
    return responses ? { reasoning: { effort: 'minimal' } } : { reasoning_effort: 'minimal' };
  }
  if (/\bo[134](-mini|-pro)?\b/i.test(m)) {
    return responses ? { reasoning: { effort: 'low' } } : { reasoning_effort: 'low' };
  }
  return {};
}

function normalizeUsage(data, apiStyle) {
  const usage = data?.usage;
  if (!usage || typeof usage !== 'object') return null;
  return apiStyle === 'responses'
    ? {
        inputTokens: usage.input_tokens ?? null,
        outputTokens: usage.output_tokens ?? null,
        totalTokens: usage.total_tokens ?? null
      }
    : {
        promptTokens: usage.prompt_tokens ?? null,
        completionTokens: usage.completion_tokens ?? null,
        totalTokens: usage.total_tokens ?? null
      };
}

function getFinishReason(data, apiStyle) {
  if (apiStyle === 'responses') {
    const output = data?.output;
    if (Array.isArray(output)) {
      const last = output[output.length - 1];
      if (last?.finish_reason) return last.finish_reason;
    }
    return data?.finish_reason ?? null;
  }
  return data?.choices?.[0]?.finish_reason ?? null;
}

function buildHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/** Low-level chat call; returns the raw text reply. Pass json: true when
 * the reply must be a JSON object (pins response_format, which is faster
 * and more reliable than hoping the model formats it correctly). */
export async function llmChat({
  apiBaseUrl,
  apiKey,
  model,
  temperature,
  apiStyle,
  system,
  user,
  json = false,
  disableThinking = false,
  maxTokens
}) {
  const url = apiStyle === 'responses'
    ? `${apiBaseUrl}/responses`
    : `${apiBaseUrl}/chat/completions`;

  // Optional temperature (0–2). Omit it when unset so the endpoint's own
  // default applies; the options page and background defaults ship 0.4.
  const t = temperature === undefined || temperature === null || temperature === ''
    ? NaN
    : Number(temperature);
  const temp = Number.isFinite(t) ? { temperature: t } : {};

  const maxOutput = Number(maxTokens);
  const outputLimit = Number.isFinite(maxOutput) && maxOutput > 0
    ? (apiStyle === 'responses' ? { max_output_tokens: maxOutput } : { max_tokens: maxOutput })
    : {};
  const fastKey = `${apiStyle}|${apiBaseUrl}|${model}`;
  const fast = disableThinking === true ? fastModeParams({ model, apiBaseUrl, apiStyle }) : {};
  const useFast = Object.keys(fast).length > 0 && !fastModeUnsupported.has(fastKey);

  const baseBody = apiStyle === 'responses'
    ? { model, ...temp, ...outputLimit, instructions: system, input: user }
    : {
        model,
        ...temp,
        ...outputLimit,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        // JSON mode requires the word "json" somewhere in the messages —
        // the study-note prompt already contains it.
        ...(json ? { response_format: { type: 'json_object' } } : {})
      };
  let fastApplied = useFast;

  const startedAt = performance.now();
  const doFetch = (obj) => fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(obj),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
  });

  let res;
  let errText = '';
  try {
    res = await doFetch(useFast ? { ...baseBody, ...fast } : baseBody);
    // Strict endpoints reject unknown params (400) or fail validation (422),
    // naming the offending key in the body. One plain retry keeps such
    // endpoints working, and fastModeUnsupported prevents the failed attempt
    // from repeating on every call. Other 400s (bad model, unsupported
    // response_format…) are left to fail fast below, without poisoning the
    // cache or stripping params that were never the problem.
    if (!res.ok && useFast && (res.status === 400 || res.status === 422)) {
      try { errText = (await res.text()).slice(0, 400); } catch { /* ignore */ }
      if (!errText || Object.keys(fast).some(k => errText.includes(k))) {
        fastApplied = false;
        fastModeUnsupported.add(fastKey);
        errText = '';
        console.warn('[LLM] thinking-disable params rejected — retrying without them', {
          model, status: res.status, params: fast
        });
        res = await doFetch(baseBody);
      }
    }
  } catch (err) {
    const durationMs = Math.round(performance.now() - startedAt);
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`LLM request timed out after ${durationMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    let text = errText;
    if (!text) {
      try { text = (await res.text()).slice(0, 400); } catch { /* ignore */ }
    }
    throw new Error(`LLM request failed (${res.status}) after ${Math.round(performance.now() - startedAt)}ms: ${text}`);
  }
  const data = await res.json();

  let text = '';
  if (apiStyle === 'responses') {
    if (typeof data.output_text === 'string') text = data.output_text;
    else {
      const parts = (data.output || [])
        .filter(o => o.type === 'message')
        .flatMap(o => (o.content || []).filter(c => c.type === 'text').map(c => c.text));
      text = parts.join('');
    }
  } else {
    text = data.choices?.[0]?.message?.content ?? '';
  }

  const durationMs = Math.round(performance.now() - startedAt);
  console.info('[LLM] request complete', {
    model,
    apiStyle,
    durationMs,
    usage: normalizeUsage(data, apiStyle),
    finishReason: getFinishReason(data, apiStyle),
    chars: text.length,
    thinkingOff: fastApplied ? Object.keys(fast).join(',') : false
  });
  return text;
}

const SYSTEM_PROMPT = `You are a CFA (Chartered Financial Analyst) exam tutor. You explain CFA exam
questions with a friendly, story-telling teaching style so a candidate can
remember the concept during the exam.

Given a CFA practical problem (question + answer options), produce a study
note in EXACTLY this JSON shape:

{
  "answer_letter": "B",
  "big_idea": "One-sentence takeaway, max 25 words.",
  "paragraphs": ["Short paragraph (max 3 sentences), teaching the concept with a simple story or analogy.", "Optional second short paragraph."],
  "wrong_reasons": [{"letter": "A", "reason": "One sentence: why this option is tempting but wrong."}],
  "memory_hook": "One memorable sentence that makes the answer stick.",
  "terms": [{"term": "Common-size analysis", "definition": "A 1-2 sentence story-flavored explanation of what the term means."}]
}

Rules:
- answer_letter: letter of the correct option. If the problem states it, keep
  it; otherwise solve it yourself.
- big_idea: the single most important takeaway, one short sentence.
- paragraphs: 1-2 short paragraphs, max 3 sentences each. Plain text only —
  no markdown, no HTML (LaTeX math like \[ ... \] is fine). Teach with a
  simple story or analogy.
- wrong_reasons: one entry per wrong option, one sentence each, plain text.
  Empty array if there are no wrong options.
- memory_hook: one short memorable sentence, plain text.
- terms: the up to 3 MOST important CFA terms or abbreviations for
  understanding this question — not every term present. Each entry is plain
  text (no markdown, no HTML):
  - definition: a clear, accurate explanation of what the term means in
    1-2 sentences, written with a story-telling flavor (an analogy or an
    "imagine that..." hook) — never a dry dictionary line.
  Empty array if there are none.
- Math: whenever a concept involves a calculation, give the actual formula
  in LaTeX — don't describe the calculation in words (e.g. write
  \[ PV = \frac{FV}{(1+r)^n} \] instead of "PV is computed by dividing FV by
  one plus r raised to the n-th power"). Put the formula on its own line in
  display math \[ ... \]; use \( ... \) only for a short inline symbol. Keep
  the surrounding prose brief — let the formula carry the math.
- Be concise: the whole note must be scannable in under 30 seconds.
- Respond with ONLY the JSON object. No code fences, no extra text.`;

function buildUserPrompt(p) {
  const lines = [];
  lines.push('Here is a CFA practical problem. Produce the study note JSON as instructed.');
  if (p.vignetteText) {
    lines.push('');
    lines.push('Shared scenario (vignette) accompanying the question:');
    lines.push(p.vignetteText);
  }
  lines.push('');
  lines.push(`Question: ${p.stemText}`);
  if (p.options?.length) {
    lines.push('');
    lines.push('Options:');
    for (const o of p.options) lines.push(`${o.letter}. ${o.text}`);
  }
  lines.push('');
  const correct = p.options?.find(o => o.isCorrect);
  const picked = p.options?.find(o => o.isPicked);
  if (correct) lines.push(`The correct answer is ${correct.letter}.`);
  if (picked && !picked.isCorrect) {
    lines.push(`The learner picked ${picked.letter} (wrong). Please also explain why ${picked.letter} is tempting but incorrect.`);
  } else if (picked && picked.isCorrect) {
    lines.push('The learner answered correctly.');
  } else {
    lines.push('The learner has not answered yet — solve the question yourself.');
  }
  const tips = (p.options || []).filter(o => o.tipText);
  if (tips.length) {
    lines.push('');
    lines.push('Official feedback from the page (verbatim, for reference — align');
    lines.push('your explanation with it when consistent, but write in your own words):');
    for (const o of tips) {
      lines.push(`- ${o.letter} (${o.isCorrect ? 'Correct' : 'Incorrect'}): ${o.tipText}`);
    }
  }
  return lines.join('\n');
}

/** Tolerant JSON extraction: strips code fences and stray prose. */
export function parseLlmJson(text) {
  let t = String(text ?? '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Generate the structured study note (answer, explanation, terms). */
export async function generateExplanation(payload, settings) {
  const raw = await llmChat({
    ...settings,
    json: true,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(payload)
  });
  const json = parseLlmJson(raw);
  if (!json) {
    const capHint = settings.maxTokens ? ` If maxTokens is too low, raise it in options.` : '';
    throw new Error(`LLM response was not valid JSON.${capHint} Retry or switch the API style in options.`);
  }
  return {
    answerLetter: String(json.answer_letter ?? '').trim(),
    // Structured parts for the "Why this answer" section.
    bigIdea: String(json.big_idea ?? '').trim(),
    paragraphs: Array.isArray(json.paragraphs)
      ? json.paragraphs.map(p => String(p ?? '').trim()).filter(Boolean)
      : [],
    wrongReasons: Array.isArray(json.wrong_reasons)
      ? json.wrong_reasons
          .map(r => ({
            letter: String(r?.letter ?? '').trim().toUpperCase(),
            reason: String(r?.reason ?? '').trim()
          }))
          .filter(r => r.letter && r.reason)
      : [],
    memoryHook: String(json.memory_hook ?? '').trim(),
    // Legacy fallback for models that still return explanation_html.
    explanationHtml: String(json.explanation_html ?? '').trim(),
    terms: Array.isArray(json.terms)
      ? json.terms
          .map(t => ({
            term: String(t?.term ?? '').trim(),
            definition: String(t?.definition ?? '').trim(),
            story: String(t?.story ?? '').trim()
          }))
          .filter(t => t.term)
      : []
  };
}
