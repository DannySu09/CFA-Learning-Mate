/* Anki-Connect client: deck/model setup, dedupe, note creation.
 * The note type's card templates + CSS (defined here) render the card UI —
 * the extension only stores structured, semantically-classed fields.
 */

export const NOTE_TYPE_NAME = 'CFA Practical Problem';
const NOTE_FIELDS = ['Question', 'Options', 'CorrectAnswer', 'UserPicked', 'Explanation', 'Terms', 'Source'];

const DEFAULT_ANKI_URL = 'http://127.0.0.1:8765';
const ANKI_TIMEOUT_MS = 20_000;

export async function ankiInvoke(action, params = {}, ankiUrl = DEFAULT_ANKI_URL) {
  const res = await fetch(ankiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params }),
    signal: AbortSignal.timeout(ANKI_TIMEOUT_MS)
  });
  if (!res.ok) {
    let text = '';
    try { text = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`Anki-Connect HTTP ${res.status}${text ? `: ${text}` : ''}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

export function ankiTest(ankiUrl) {
  return ankiInvoke('version', {}, ankiUrl);
}

export async function ensureDeckAndModel({ deckName, ankiUrl }) {
  const decks = await ankiInvoke('deckNames', {}, ankiUrl);
  if (!decks.includes(deckName)) {
    await ankiInvoke('createDeck', { deck: deckName }, ankiUrl);
  }
  const models = await ankiInvoke('modelNames', {}, ankiUrl);
  if (!models.includes(NOTE_TYPE_NAME)) {
    // Only created when missing — never overwrites templates the user
    // customized inside Anki.
    await ankiInvoke('createModel', {
      modelName: NOTE_TYPE_NAME,
      inOrderFields: NOTE_FIELDS,
      css: NOTE_CSS,
      isCloze: false,
      cardTemplates: [{ Name: 'CFA Question', Front: TEMPLATE_FRONT, Back: TEMPLATE_BACK }]
    }, ankiUrl);
  } else {
    // Upgrade our own generated styling when it changed; skip if the CSS no
    // longer carries our marker (user customized it) or if the AnkiConnect
    // version is too old to support styling updates.
    try {
      const { css } = await ankiInvoke('modelStyling', { modelName: NOTE_TYPE_NAME }, ankiUrl);
      if (css && !css.includes(NOTE_CSS_MARKER)) {
        await ankiInvoke('updateModelStyling', { modelName: NOTE_TYPE_NAME, css: NOTE_CSS }, ankiUrl);
      }
    } catch { /* unsupported action on older AnkiConnect — keep going */ }
  }
}

export async function findNoteIdByQid(qid, ankiUrl) {
  const ids = await ankiInvoke('findNotes', { query: `tag:cfa-qid-${qid}` }, ankiUrl);
  return ids?.[0] ?? null;
}

/** Batch status check: qid → noteId for all given question ids (one query). */
export async function findNoteIdsByQids(qids, ankiUrl) {
  if (!qids.length) return {};
  const query = qids.map(q => `tag:cfa-qid-${q}`).join(' or ');
  const ids = await ankiInvoke('findNotes', { query: `(${query})` }, ankiUrl);
  if (!ids.length) return {};
  const infos = await ankiInvoke('notesInfo', { notes: ids }, ankiUrl);
  const map = {};
  for (const info of infos || []) {
    const tag = (info.tags || []).find(t => t.startsWith('cfa-qid-'));
    if (tag) map[tag.slice('cfa-qid-'.length)] = info.noteId;
  }
  return map;
}

export async function deleteNoteById(noteId, ankiUrl) {
  return ankiInvoke('deleteNotes', { notes: [noteId] }, ankiUrl);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Semantic option markup: the front template shows plain options (the reveal
// styles are scoped to .card.back), the back highlights correct / wrongly
// picked options via the baked-in classes.
function buildOptionsHtml(options) {
  return (options || []).map(o => {
    const cls = ['opt'];
    if (o.isCorrect) cls.push('opt-correct');
    if (o.isPicked && !o.isCorrect) cls.push('opt-wrong');
    return `<div class="${cls.join(' ')}">${escapeHtml(o.text)}</div>`;
  }).join('');
}

function buildTermsHtml(terms) {
  return (terms || []).map(t =>
    `<div class="term"><div class="term-name">${escapeHtml(t.term)}</div>` +
    `<div class="term-def">${escapeHtml(t.definition)}</div>` +
    (t.story ? `<div class="term-story">📖 ${escapeHtml(t.story)}</div>` : '') +
    `</div>`
  ).join('');
}

// Structured "Why this answer" section: takeaway box, short paragraphs,
// bulleted wrong-option reasons, memory hook. Falls back to a legacy
// explanation_html blob for models that ignore the structured prompt.
function buildExplanationHtml(llm) {
  if (llm.bigIdea || llm.paragraphs?.length || llm.wrongReasons?.length || llm.memoryHook) {
    const parts = [];
    if (llm.bigIdea) parts.push(`<div class="big-idea">💡 ${escapeHtml(llm.bigIdea)}</div>`);
    for (const p of llm.paragraphs || []) parts.push(`<p>${escapeHtml(p)}</p>`);
    if (llm.wrongReasons?.length) {
      const items = llm.wrongReasons
        .map(r => `<li><strong>${escapeHtml(r.letter)}.</strong> ${escapeHtml(r.reason)}</li>`)
        .join('');
      parts.push(`<div class="why-wrong-title">Why the others are wrong</div>`);
      parts.push(`<ul class="why-wrong">${items}</ul>`);
    }
    if (llm.memoryHook) parts.push(`<div class="memory-hook">🧠 ${escapeHtml(llm.memoryHook)}</div>`);
    return parts.join('');
  }
  return llm.explanationHtml || '';
}

export async function addQuestionNote({ settings, payload, llm }) {
  const correct = payload.options.find(o => o.isCorrect);
  const picked = payload.options.find(o => o.isPicked);

  const fields = {
    Question: payload.stemHtml,
    Options: buildOptionsHtml(payload.options),
    CorrectAnswer: correct
      ? escapeHtml(correct.text)
      : (llm.answerLetter ? `The correct answer is ${escapeHtml(llm.answerLetter)}.` : ''),
    UserPicked: picked && !picked.isCorrect ? escapeHtml(picked.text) : '',
    Explanation: buildExplanationHtml(llm),
    Terms: buildTermsHtml(llm.terms),
    Source: `${payload.pageUrl}#q-${payload.qid}`
  };

  return ankiInvoke('addNote', {
    note: {
      deckName: settings.deckName,
      modelName: NOTE_TYPE_NAME,
      fields,
      tags: ['CFA', `cfa-qid-${payload.qid}`],
      options: { allowDuplicate: false, duplicateScope: 'deck' }
    }
  }, settings.ankiUrl);
}

/* ---------------- note type templates & styling ---------------- */

const TEMPLATE_FRONT = `<div class="card cfa front">
  <div class="q-kicker">CFA Practical Problem</div>
  <div class="q-stem">{{Question}}</div>
  <div class="options">{{Options}}</div>
</div>`;

const TEMPLATE_BACK = `<div class="card cfa back">
  <div class="q-stem">{{Question}}</div>
  <div class="options">{{Options}}</div>
  {{#CorrectAnswer}}<div class="answer-banner">✅ {{CorrectAnswer}}</div>{{/CorrectAnswer}}
  {{#UserPicked}}<div class="picked-banner">⚠️ You chose: {{UserPicked}}</div>{{/UserPicked}}
  {{#Explanation}}<div class="section"><div class="section-title">📖 Why this answer</div><div class="section-body">{{Explanation}}</div></div>{{/Explanation}}
  {{#Terms}}<div class="section"><div class="section-title">📚 Key CFA Terms</div><div class="section-body terms">{{Terms}}</div></div>{{/Terms}}
  <div class="source">{{Source}}</div>
</div>`;

// Marker so the extension can detect and upgrade its own generated CSS
// without ever clobbering styling the user has customized in Anki.
const NOTE_CSS_MARKER = '/* CFA Practical Problem card UI (auto-generated) */';

const NOTE_CSS = `
/* CFA Practical Problem card UI (auto-generated) */
.card {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 17px;
  line-height: 1.65;
  color: #1e293b;
  background: #ffffff;
  padding: 10px 18px;
}
.card .q-kicker {
  font-size: 12px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: #94a3b8;
  margin-bottom: 6px;
}
.q-stem { font-size: 18px; font-weight: 600; color: #0f172a; }
/* Shared scenario/exhibit block attached to vignette questions */
.vignette {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #f8fafc;
  padding: 10px 12px;
  font-size: 15px;
  margin: 8px 0 12px;
}
.vignette h2 { font-size: 16px; margin: 6px 0; }
.vignette table { border-collapse: collapse; margin: 8px auto; }
.vignette th, .vignette td { border: 1px solid #94a3b8; padding: 5px 8px; }
.vignette th { background: #eef2f7; }
.options { margin: 14px 0 6px; }
.opt {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 10px 14px;
  margin: 8px 0;
  background: #f8fafc;
}
/* Reveal styles are scoped to the back card — the front stays neutral. */
.card.back .opt-correct {
  border-color: #22c55e;
  background: #f0fdf4;
  box-shadow: inset 3px 0 0 #22c55e;
}
.card.back .opt-wrong {
  border-color: #ef4444;
  background: #fef2f2;
  box-shadow: inset 3px 0 0 #ef4444;
}
.answer-banner {
  margin: 14px 0 4px;
  background: #16a34a;
  color: #fff;
  border-radius: 10px;
  padding: 10px 14px;
  font-weight: 700;
  font-size: 16px;
}
.picked-banner {
  margin: 8px 0 4px;
  background: #dc2626;
  color: #fff;
  border-radius: 10px;
  padding: 8px 14px;
  font-weight: 600;
  font-size: 15px;
}
.section { margin-top: 18px; }
.section-title {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: #475569;
  border-bottom: 2px solid #e2e8f0;
  padding-bottom: 6px;
  margin-bottom: 10px;
}
.section-body p { margin: 8px 0; }
/* Structured explanation blocks (generated from LLM JSON parts) */
.big-idea {
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-left: 4px solid #3b82f6;
  border-radius: 8px;
  padding: 10px 12px;
  font-weight: 600;
  color: #1e40af;
  margin: 10px 0;
}
.why-wrong-title { font-weight: 700; margin: 12px 0 4px; color: #475569; }
ul.why-wrong { margin: 4px 0 10px; padding-left: 20px; }
ul.why-wrong li { margin: 6px 0; }
.memory-hook {
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-left: 4px solid #22c55e;
  border-radius: 8px;
  padding: 10px 12px;
  color: #14532d;
  font-weight: 600;
  margin: 10px 0;
}
.term {
  border-left: 3px solid #3b82f6;
  background: #eff6ff;
  border-radius: 0 8px 8px 0;
  padding: 8px 12px;
  margin: 8px 0;
}
.term-name { font-weight: 700; color: #1d4ed8; }
.term-def { margin-top: 4px; line-height: 1.6; }
/* Story-telling teaching aid — shown after the detailed definition */
.term-story {
  margin-top: 6px;
  padding: 6px 10px;
  background: #fffbeb;
  border-left: 3px solid #f59e0b;
  border-radius: 0 6px 6px 0;
  font-style: italic;
  color: #78350f;
}
.source {
  margin-top: 22px;
  font-size: 11px;
  color: #94a3b8;
  word-break: break-all;
}
/* Night mode (Anki adds the nightMode class to the card element) */
.card.nightMode { background: #0f172a; color: #e2e8f0; }
.nightMode .q-stem { color: #f1f5f9; }
.nightMode .opt { border-color: #334155; background: #1e293b; }
.nightMode .card.back .opt-correct { border-color: #16a34a; background: #052e16; }
.nightMode .card.back .opt-wrong { border-color: #b91c1c; background: #2a0a0a; }
.nightMode .section-title { color: #94a3b8; border-color: #334155; }
.nightMode .term { background: #172554; border-color: #3b82f6; }
.nightMode .term-name { color: #93c5fd; }
.nightMode .vignette { border-color: #334155; background: #1e293b; }
.nightMode .vignette th { background: #334155; }
.nightMode .term-story { background: #451a03; border-color: #f59e0b; color: #fde68a; }
.nightMode .big-idea { background: #172554; border-color: #1e3a8a; color: #bfdbfe; }
.nightMode .why-wrong-title { color: #94a3b8; }
.nightMode .memory-hook { background: #052e16; border-color: #166534; color: #bbf7d0; }
.nightMode .source { color: #64748b; }
.nightMode .answer-banner { background: #15803d; }
.nightMode .picked-banner { background: #b91c1c; }
`;
