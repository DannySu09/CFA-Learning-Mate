/* OpenAI-compatible LLM client.
 * Supports both the Chat Completions API (POST /chat/completions) and the
 * Responses API (POST /responses), selectable per request via apiStyle.
 */

const LLM_TIMEOUT_MS = 120_000;

function buildHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/** Low-level chat call; returns the raw text reply. Pass json: true when
 * the reply must be a JSON object (pins response_format, which is faster
 * and more reliable than hoping the model formats it correctly). */
export async function llmChat({ apiBaseUrl, apiKey, model, apiStyle, system, user, json = false }) {
  const url = apiStyle === 'responses'
    ? `${apiBaseUrl}/responses`
    : `${apiBaseUrl}/chat/completions`;

  const body = apiStyle === 'responses'
    ? JSON.stringify({ model, instructions: system, input: user })
    : JSON.stringify({
        model,
        temperature: 0.4,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        // JSON mode requires the word "json" somewhere in the messages —
        // the study-note prompt already contains it.
        ...(json ? { response_format: { type: 'json_object' } } : {})
      });

  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body,
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
  });
  if (!res.ok) {
    let text = '';
    try { text = (await res.text()).slice(0, 400); } catch { /* ignore */ }
    throw new Error(`LLM request failed (${res.status}): ${text}`);
  }
  const data = await res.json();

  if (apiStyle === 'responses') {
    if (typeof data.output_text === 'string') return data.output_text;
    const parts = (data.output || [])
      .filter(o => o.type === 'message')
      .flatMap(o => (o.content || []).filter(c => c.type === 'text').map(c => c.text));
    return parts.join('');
  }
  return data.choices?.[0]?.message?.content ?? '';
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
  "terms": [{"term": "Common-size analysis", "definition": "Detailed explanation of what the term means.", "story": "Story-telling teaching aid to remember it."}]
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
- terms: every CFA term/abbreviation in the question or options. Each entry
  has TWO parts, both plain text (no markdown, no HTML):
  - definition: a clear, detailed, accurate explanation of what the term
    means (2-4 sentences) — the substance a candidate must know.
  - story: a separate story-telling style teaching aid (an analogy, an
    "imagine that..." hook, or a tiny story, 1-3 sentences) that makes the
    term easy to understand and recall. Never a dry dictionary line.
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
    throw new Error('LLM response was not valid JSON — retry or switch the API style in options.');
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
