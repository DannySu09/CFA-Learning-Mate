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
    // Upgrade our own generated styling/templates when they changed; skip
    // anything the user customized inside Anki (recognized by a missing
    // auto-generation marker, or a template that no longer matches what we
    // ship). Older AnkiConnect versions may not support these actions.
    try {
      const { css } = await ankiInvoke('modelStyling', { modelName: NOTE_TYPE_NAME }, ankiUrl);
      if (css && css.includes(NOTE_CSS_MARKER) && css.trim() !== NOTE_CSS.trim()) {
        await ankiInvoke('updateModelStyling', {
          model: { name: NOTE_TYPE_NAME, css: NOTE_CSS }
        }, ankiUrl);
      }
    } catch { /* unsupported action on older AnkiConnect — keep going */ }
    try {
      const templates = await ankiInvoke('modelTemplates', { modelName: NOTE_TYPE_NAME }, ankiUrl);
      const t = templates?.['CFA Question'];
      const ours = (f, b) =>
        (f.includes(TEMPLATE_MARKER) && b.includes(TEMPLATE_MARKER)) ||
        (f === LEGACY_TEMPLATE_FRONT && b === LEGACY_TEMPLATE_BACK);
      if (t && ours(t.Front || '', t.Back || '') &&
          (t.Front !== TEMPLATE_FRONT || t.Back !== TEMPLATE_BACK)) {
        await ankiInvoke('updateModelTemplates', {
          model: {
            name: NOTE_TYPE_NAME,
            templates: { 'CFA Question': { Front: TEMPLATE_FRONT, Back: TEMPLATE_BACK } }
          }
        }, ankiUrl);
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

// Semantic option markup: letter chip + text + state tag. Reveal styles are
// scoped to .card.back — the front stays neutral (and the tags are hidden).
function buildOptionsHtml(options) {
  return (options || []).map(o => {
    const cls = ['opt'];
    let tag = '';
    if (o.isCorrect) {
      cls.push('opt-correct');
      tag = o.isPicked
        ? '<span class="opt-tag">✓ your pick</span>'
        : '<span class="opt-tag">✓ correct</span>';
    } else if (o.isPicked) {
      cls.push('opt-wrong');
      tag = '<span class="opt-tag">✗ your pick</span>';
    }
    // The raw text carries its leading letter ("A. …"); the chip renders it,
    // so strip the prefix from the text itself.
    const text = escapeHtml(o.text.replace(/^[A-Za-z]\.\s*/, ''));
    return `<div class="${cls.join(' ')}">` +
      `<span class="opt-letter">${escapeHtml(o.letter)}</span>` +
      `<span class="opt-text">${text}</span>${tag}</div>`;
  }).join('');
}

// Flat glossary rows: bold term inline with its definition; the story is a
// quiet italic line below (no nested boxes).
function buildTermsHtml(terms) {
  return (terms || []).map(t =>
    `<div class="term"><span class="term-name">${escapeHtml(t.term)}</span>` +
    ` <span class="term-def">${escapeHtml(t.definition)}</span>` +
    (t.story ? `<div class="term-story">${escapeHtml(t.story)}</div>` : '') +
    `</div>`
  ).join('');
}

// Structured "Why this answer" section: takeaway box, short paragraphs,
// bulleted wrong-option reasons, memory hook. Falls back to a legacy
// explanation_html blob for models that ignore the structured prompt.
function buildExplanationHtml(llm) {
  if (llm.bigIdea || llm.paragraphs?.length || llm.wrongReasons?.length || llm.memoryHook) {
    const parts = [];
    if (llm.bigIdea) parts.push(`<div class="big-idea">${escapeHtml(llm.bigIdea)}</div>`);
    for (const p of llm.paragraphs || []) parts.push(`<p>${escapeHtml(p)}</p>`);
    if (llm.wrongReasons?.length) {
      const items = llm.wrongReasons
        .map(r => `<li><strong>${escapeHtml(r.letter)}.</strong> ${escapeHtml(r.reason)}</li>`)
        .join('');
      parts.push(`<div class="why-wrong-title">Why the others are wrong</div>`);
      parts.push(`<ul class="why-wrong">${items}</ul>`);
    }
    if (llm.memoryHook) parts.push(`<div class="memory-hook">${escapeHtml(llm.memoryHook)}</div>`);
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

// Marker comments in the templates (and NOTE_CSS_MARKER in the CSS) let the
// extension upgrade its own generated UI in place without ever touching
// templates the user customized inside Anki.
const TEMPLATE_MARKER = '<!-- CFA Practical Problem card UI (auto-generated) -->';

const TEMPLATE_FRONT = `${TEMPLATE_MARKER}
<div class="card cfa front">
  <div class="q-kicker">CFA Practical Problem</div>
  <div class="q-stem">{{Question}}</div>
  <div class="options">{{Options}}</div>
</div>`;

const TEMPLATE_BACK = `${TEMPLATE_MARKER}
<div class="card cfa back">
  <div class="q-stem q-stem-echo">{{Question}}</div>
  <div class="options">{{Options}}</div>
  <hr class="rule">
  {{#CorrectAnswer}}<div class="verdict-correct">✓ {{CorrectAnswer}}</div>{{/CorrectAnswer}}
  {{#UserPicked}}<div class="verdict-picked">✗ You chose {{UserPicked}}</div>{{/UserPicked}}
  {{#Explanation}}<div class="section"><div class="section-title">Why this answer</div><div class="section-body">{{Explanation}}</div></div>{{/Explanation}}
  {{#Terms}}<div class="section"><div class="section-title">Key terms</div><div class="section-body terms">{{Terms}}</div></div>{{/Terms}}
  <div class="source">{{Source}}</div>
</div>`;

// Legacy auto-generated templates (pre-marker) kept verbatim so installs
// created by older versions of the extension can still be upgraded in place.
const LEGACY_TEMPLATE_FRONT = `<div class="card cfa front">
  <div class="q-kicker">CFA Practical Problem</div>
  <div class="q-stem">{{Question}}</div>
  <div class="options">{{Options}}</div>
</div>`;

const LEGACY_TEMPLATE_BACK = `<div class="card cfa back">
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
  font-size: 11px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: #94a3b8;
  margin-bottom: 8px;
}
/* Question stem on the front; on the back it echoes muted so the
   explanation leads the eye. */
.q-stem { font-size: 18px; font-weight: 600; color: #0f172a; }
.card.back .q-stem-echo {
  font-size: 15px;
  font-weight: 500;
  color: #64748b;
  line-height: 1.55;
}
/* Shared scenario/exhibit block attached to vignette questions */
.vignette {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
  padding: 10px 12px;
  font-size: 15px;
  margin: 8px 0 12px;
}
.vignette h2 { font-size: 16px; margin: 6px 0; }
.vignette table { border-collapse: collapse; margin: 8px auto; }
.vignette th, .vignette td { border: 1px solid #cbd5e1; padding: 5px 8px; }
.vignette th { background: #f1f5f9; }

/* Options — quiet rows separated by hairlines: letter chip, text, state tag */
.options { margin: 14px 0 6px; }
.opt {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 2px;
  border-bottom: 1px solid #f1f5f9;
}
.opt:last-child { border-bottom: none; }
.opt-letter {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #f1f5f9;
  color: #475569;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
}
.opt-text { flex: 1; }
/* State tags are baked into the field HTML; only the back shows them */
.card.front .opt-tag { display: none; }
.opt-tag {
  flex: none;
  margin-left: auto;
  font-size: 12px;
  font-weight: 600;
}
/* Reveal styles are scoped to the back card — the front stays neutral. */
.card.back .opt-correct {
  background: #f0fdf4;
  border-radius: 8px;
  padding: 8px 10px;
}
.card.back .opt-correct .opt-letter { background: #16a34a; color: #fff; }
.card.back .opt-correct .opt-tag { color: #15803d; }
.card.back .opt-wrong {
  background: #fef2f2;
  border-radius: 8px;
  padding: 8px 10px;
}
.card.back .opt-wrong .opt-letter { background: #dc2626; color: #fff; }
.card.back .opt-wrong .opt-tag { color: #b91c1c; }

/* Verdict summary — colored text lines, no filled blocks */
.rule { border: 0; border-top: 1px solid #e2e8f0; margin: 14px 0; }
.verdict-correct, .verdict-picked { font-size: 16px; font-weight: 600; margin: 2px 0; }
.verdict-correct { color: #15803d; }
.verdict-picked { color: #b91c1c; }

.section { margin-top: 20px; }
.section-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: #94a3b8;
  border-bottom: 1px solid #e2e8f0;
  padding-bottom: 6px;
  margin-bottom: 10px;
}
.section-body p { margin: 8px 0; }
/* The one callout on the card: the takeaway. Everything else is text. */
.big-idea {
  background: #f8fafc;
  border-left: 3px solid #6366f1;
  border-radius: 0 8px 8px 0;
  padding: 10px 12px;
  font-weight: 600;
  color: #312e81;
  margin: 10px 0;
}
.why-wrong-title { font-weight: 600; margin: 14px 0 4px; color: #475569; }
ul.why-wrong { margin: 4px 0 10px; padding-left: 20px; }
ul.why-wrong li { margin: 6px 0; }
ul.why-wrong li strong { color: #0f172a; }
.memory-hook {
  margin: 12px 0;
  padding: 2px 0 2px 12px;
  border-left: 2px solid #cbd5e1;
  font-style: italic;
  color: #475569;
}
/* Terms — flat rows, no boxes; story in light italic below */
.term { padding: 8px 2px; border-bottom: 1px solid #f1f5f9; }
.term:last-child { border-bottom: none; }
.term-name { font-weight: 700; color: #0f172a; }
.term-def { color: #334155; }
.term-story {
  margin-top: 4px;
  font-size: 14px;
  font-style: italic;
  color: #64748b;
}
.source {
  margin-top: 22px;
  font-size: 11px;
  color: #94a3b8;
  word-break: break-all;
}
/* Fallback for installs whose user-customized templates still use the
   legacy solid banners */
.answer-banner { color: #15803d; font-weight: 600; margin-top: 12px; }
.picked-banner { color: #b91c1c; font-weight: 600; }
/* Night mode (Anki adds the nightMode class to the card element) */
.card.nightMode { background: #0f172a; color: #e2e8f0; }
.nightMode .q-stem { color: #f1f5f9; }
.nightMode .card.back .q-stem-echo { color: #94a3b8; }
.nightMode .vignette { border-color: #334155; background: #1e293b; }
.nightMode .vignette th { background: #334155; }
.nightMode .vignette th, .nightMode .vignette td { border-color: #475569; }
.nightMode .opt { border-color: #1e293b; }
.nightMode .opt-letter { background: #334155; color: #cbd5e1; }
.nightMode .card.back .opt-correct { background: #052e16; }
.nightMode .card.back .opt-correct .opt-letter { background: #16a34a; }
.nightMode .card.back .opt-correct .opt-tag { color: #4ade80; }
.nightMode .card.back .opt-wrong { background: #2a0a0a; }
.nightMode .card.back .opt-wrong .opt-letter { background: #dc2626; }
.nightMode .card.back .opt-wrong .opt-tag { color: #f87171; }
.nightMode .rule { border-color: #334155; }
.nightMode .verdict-correct { color: #4ade80; }
.nightMode .verdict-picked { color: #f87171; }
.nightMode .section-title { color: #64748b; border-color: #334155; }
.nightMode .big-idea { background: #1e293b; border-color: #6366f1; color: #c7d2fe; }
.nightMode .why-wrong-title { color: #94a3b8; }
.nightMode ul.why-wrong li strong { color: #f1f5f9; }
.nightMode .memory-hook { border-color: #475569; color: #94a3b8; }
.nightMode .term { border-color: #1e293b; }
.nightMode .term-name { color: #f1f5f9; }
.nightMode .term-def { color: #cbd5e1; }
.nightMode .term-story { color: #94a3b8; }
.nightMode .answer-banner { color: #4ade80; }
.nightMode .picked-banner { color: #f87171; }
.nightMode .source { color: #475569; }
`;
