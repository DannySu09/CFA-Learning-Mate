/* Options page logic. */

const FIELDS = ['apiBaseUrl', 'apiKey', 'model', 'temperature', 'apiStyle', 'ankiUrl', 'deckName'];
const DEFAULTS = {
  apiBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.4,
  apiStyle: 'chat',
  ankiUrl: 'http://127.0.0.1:8765',
  deckName: 'CFA::Practical Problems'
};

async function load() {
  const stored = await chrome.storage.local.get(FIELDS);
  for (const f of FIELDS) {
    document.getElementById(f).value = stored[f] ?? DEFAULTS[f];
  }
}

function readForm() {
  const out = {};
  for (const f of FIELDS) {
    const v = document.getElementById(f).value.trim();
    out[f] = f === 'temperature' ? (v === '' ? '' : Number(v)) : v;
  }
  return out;
}

function setStatus(msg, ok = true) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = ok ? 'ok' : 'err';
}

function apiOrigin(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return '';
  }
}

// Requests without CORS need host permission for the API's origin.
// api.openai.com is already granted via manifest host_permissions.
async function ensureOriginPermission(origin) {
  if (!origin || origin.includes('api.openai.com')) return true;
  const perm = { origins: [origin + '/*'] };
  if (await chrome.permissions.contains(perm)) return true;
  return chrome.permissions.request(perm);
}

document.getElementById('save').addEventListener('click', async () => {
  const s = readForm();
  const origin = apiOrigin(s.apiBaseUrl);
  if (!origin) {
    setStatus('Invalid API base URL.', false);
    return;
  }
  if (s.temperature === '' || Number.isNaN(s.temperature) || s.temperature < 0 || s.temperature > 2) {
    setStatus('Temperature must be a number between 0 and 2.', false);
    return;
  }
  await chrome.storage.local.set(s);

  const granted = await ensureOriginPermission(origin);
  setStatus(granted
    ? 'Settings saved ✓ Permission granted for the API host.'
    : 'Settings saved, but permission for the API host was denied — card creation will fail for this endpoint.',
    granted);
});

document.getElementById('test-anki').addEventListener('click', async () => {
  setStatus('Testing Anki-Connect…');
  const res = await chrome.runtime.sendMessage({
    type: 'TEST_ANKI',
    ankiUrl: document.getElementById('ankiUrl').value.trim(),
    deckName: document.getElementById('deckName').value.trim()
  });
  setStatus(res.ok
    ? 'Anki-Connect OK ✓ (note type up to date)'
    : `Anki-Connect error: ${res.error}\n\nIs Anki running with the AnkiConnect add-on installed?`,
    res.ok);
});

document.getElementById('test-llm').addEventListener('click', async () => {
  const settings = readForm();
  const origin = apiOrigin(settings.apiBaseUrl);
  if (!origin) {
    setStatus('Invalid API base URL.', false);
    return;
  }
  // Grant host permission first, otherwise the request hits a CORS error.
  const granted = await ensureOriginPermission(origin);
  if (!granted) {
    setStatus('Permission for the API host was denied — the test cannot run.', false);
    return;
  }
  setStatus('Testing LLM connection…');
  const res = await chrome.runtime.sendMessage({ type: 'TEST_LLM', settings: settings });
  setStatus(res.ok
    ? `LLM OK ✓ (reply: ${res.sample})`
    : `LLM error: ${res.error}`,
    res.ok);
});

load();
