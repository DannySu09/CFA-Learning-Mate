/* CFA Practical Problem → Anki — background service worker.
 * Orchestrates: content script message → LLM generation → Anki-Connect.
 * All network calls and the API key live here, never in the page context.
 */
import { llmChat, generateExplanation } from './llm.js';
import {
  ankiTest,
  ensureDeckAndModel,
  findNoteIdByQid,
  findNoteIdsByQids,
  deleteNoteById,
  addQuestionNote,
  getNoteFields,
  getNotesFields,
  renderCardFrontHtml,
  renderCardBackHtml,
  buildNoteFields,
  modelHasOfficialTips
} from './anki.js';

const DEFAULT_SETTINGS = {
  apiBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.4,
  apiStyle: 'chat', // 'chat' | 'responses'
  ankiUrl: 'http://127.0.0.1:8765',
  deckName: 'CFA::Practical Problems'
};

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}

function isLocalEndpoint(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

// Fetches only bypass CORS for origins covered by host permissions.
// api.openai.com comes from manifest host_permissions; custom endpoints need
// the optional permission the options page requests on save / test.
async function ensureApiHostPermission(apiBaseUrl) {
  let origin;
  try {
    origin = new URL(apiBaseUrl).origin;
  } catch {
    return false;
  }
  if (origin.includes('api.openai.com')) return true;
  return chrome.permissions.contains({ origins: [origin + '/*'] });
}

// Both the save and the preview ("AI Explain") path need the LLM; fail fast
// with a message that points at the options page.
async function validateLlmSettings(settings) {
  if (!settings.apiBaseUrl || !settings.model) {
    throw new Error('LLM settings are missing — open the extension options page.');
  }
  if (!settings.apiKey && !isLocalEndpoint(settings.apiBaseUrl)) {
    throw new Error('API key is not configured — open the extension options page.');
  }
  if (!(await ensureApiHostPermission(settings.apiBaseUrl))) {
    throw new Error('Host permission for the API is missing — open the extension options page and click "Test LLM" to grant it.');
  }
}

// Anki is the only source of truth for whether a card exists: saving always
// replaces an existing card — the extension keeps no local saved-state.
async function handleSave(payload) {
  const settings = await getSettings();
  await validateLlmSettings(settings);

  // "AI Explain" may have already generated the note — reuse it instead of
  // paying for a second LLM request.
  const { llm: precomputed, ...question } = payload;

  const existing = await findNoteIdByQid(question.qid, settings.ankiUrl);
  let replaced = false;
  if (existing) {
    try {
      await deleteNoteById(existing, settings.ankiUrl);
      replaced = true;
    } catch {
      // Note already gone — proceed with a fresh add.
    }
  }

  const llm = precomputed ?? await generateExplanation(question, settings);
  const { hasOfficialTips } = await ensureDeckAndModel(settings);
  const noteId = await addQuestionNote({ settings, payload: question, llm, hasOfficialTips });
  // Verify the note actually landed in Anki before reporting success —
  // the button only flips to "added" when this re-query confirms it.
  const confirmed = await findNoteIdByQid(question.qid, settings.ankiUrl);
  if (!confirmed) {
    throw new Error('The card was submitted but Anki did not confirm it — check the deck manually.');
  }
  // Render both card faces (templates + CSS against Anki's stored fields) so
  // the content script can show them under the button: the front for the new
  // card, the back reusing the generated explanation. The preview is a
  // nicety — if it fails, the card is still safely in Anki.
  let preview = {};
  try {
    const fields = await getNoteFields(confirmed, settings.ankiUrl);
    preview = { ...renderCardFrontHtml(fields), ...renderCardBackHtml(fields) };
  } catch { /* preview skipped */ }
  return { ok: true, verified: true, replaced, noteId: confirmed, ...preview };
}

// "AI Explain": generate the explanation and preview the card back WITHOUT
// touching Anki (no deck/model creation, no note). The content script keeps
// the returned note and reuses it when "Save to Anki" is clicked.
async function handleExplain(payload) {
  const settings = await getSettings();
  await validateLlmSettings(settings);
  const llm = await generateExplanation(payload, settings);
  const preview = renderCardBackHtml(buildNoteFields({
    payload,
    llm,
    hasOfficialTips: await modelHasOfficialTips(settings.ankiUrl)
  }));
  return { ok: true, llm, ...preview };
}

// Render card backs for questions already saved in Anki, so the page can
// show the explanation under the "Re-add to Anki" button (e.g. after a
// reload, when the in-session preview cache is gone).
async function handleCardBacks(qids) {
  const { ankiUrl } = await getSettings();
  const map = await findNoteIdsByQids(qids, ankiUrl);
  // Object keys coerce to strings, but Anki-Connect needs numeric note ids —
  // build the id list from the map values before any lookup.
  const fieldsById = await getNotesFields([...new Set(Object.values(map))], ankiUrl);
  const backs = {};
  for (const [qid, noteId] of Object.entries(map)) {
    if (fieldsById[noteId]) backs[qid] = renderCardBackHtml(fieldsById[noteId]);
  }
  return { ok: true, backs };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'SAVE_QUESTION') {
    handleSave(msg.payload)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true; // async response

  } else if (msg?.type === 'EXPLAIN_QUESTION') {
    handleExplain(msg.payload)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;

  } else if (msg?.type === 'GET_CARD_BACKS') {
    handleCardBacks(msg.qids || [])
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;

  } else if (msg?.type === 'CHECK_STATUS') {
    (async () => {
      const { ankiUrl } = await getSettings();
      return { ok: true, map: await findNoteIdsByQids(msg.qids || [], ankiUrl) };
    })()
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;

  } else if (msg?.type === 'TEST_ANKI') {
    (async () => {
      await ankiTest(msg.ankiUrl);
      // Keep the deck + note type in sync too: clicking "Test Anki" applies
      // field/template/CSS upgrades without having to save a card.
      const settings = await getSettings();
      await ensureDeckAndModel({
        deckName: msg.deckName || settings.deckName,
        ankiUrl: msg.ankiUrl || settings.ankiUrl
      });
      return { ok: true };
    })()
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;

  } else if (msg?.type === 'TEST_LLM') {
    (async () => {
      if (!(await ensureApiHostPermission(msg.settings?.apiBaseUrl))) {
        throw new Error('Host permission for the API is missing — click "Save settings" first to grant it.');
      }
      const text = await llmChat({
        ...msg.settings,
        system: 'You are a helpful assistant.',
        user: 'Reply with exactly the word: OK'
      });
      return { ok: true, sample: String(text).slice(0, 120) };
    })()
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
});
