# CFA Practical Problems → Anki

A Chrome extension (Manifest V3) that saves **CFA Institute practical problems**
to Anki via [Anki-Connect](https://foosoft.net/projects/anki-connect/), with
LLM-generated **storytelling explanations** and a **CFA term glossary** on the
back of each card.

## How it works

1. **Detect** — on `https://learn.cfainstitute.org/courses/*/external_tools/*`
   the content script watches the (SPA) page and finds question blocks:
   `div[data-quiz-question-id="…"]`.
2. **Button** — every question gets an injected **📥 Save to Anki** button.
   Questions you answered incorrectly are tinted red. The "added" status is
   **queried from Anki itself** (batched `findNotes` on the `cfa-qid-<id>`
   tags) — the extension keeps no local saved-state, so it always reflects
   reality (delete a card in Anki and the pill disappears). Added questions
   show **✓ Added to Anki** with a **↻ Re-add to Anki** button.
3. **Extract** — on click, the question stem, options, the correct answer
   (`svg[name="IconCheck"]`) and your pick (`svg[name="IconX"]` + checked) are
   read from the DOM. Shared vignette scenarios (intro text + exhibit tables)
   preceding the question are included so each card is self-contained.
4. **Generate** — the background service worker sends the question (plus any
   vignette) alone to an OpenAI-compatible LLM (**Chat Completions** or
   **Responses** API) which returns a JSON study note: answer letter, a
   structured storytelling explanation (big idea, short paragraphs, wrong-
   option reasons, memory hook), and storytelling-style CFA `terms` with
   definitions.
5. **Add to Anki** — Anki-Connect creates the note in the configured deck.
   Saving **always replaces** an existing card (checked by tag
   `cfa-qid-<id>`), and the note is re-queried afterwards to verify it
   landed before the UI flips to "added". Uses the `CFA Practical Problem`
   note type whose card templates render the styled UI.

### Card layout
- **Front:** question stem + options (no answer revealed).
- **Back:** correct-answer banner, options with green correct / red "you chose"
  highlights, **📖 Why this answer** (storytelling explanation), **📚 Key CFA
  Terms** glossary cards, and a small source footer.

## Setup

1. **Anki + Anki-Connect** — install the
   [AnkiConnect add-on](https://ankiweb.net/shared/info/2055492159)
   (code `2055492159`) and restart Anki.
2. **Allow the extension to reach Anki** — open the AnkiConnect config and add
   your extension id to the CORS allow-list:
   ```json
   {
     "webCorsOriginList": ["chrome-extension://<YOUR_EXTENSION_ID>"]
   }
   ```
   The id is shown at `chrome://extensions` (enable *Developer mode*) after
   loading the extension. Restart Anki after editing the config.
3. **Load the extension** — `chrome://extensions` → *Developer mode* →
   *Load unpacked* → select this folder.
4. **Configure** — open the extension's options page and set:
   - API base URL (any OpenAI-compatible endpoint; defaults to
     `https://api.openai.com/v1`), API key, model, and API style
     (`chat` = Chat Completions, `responses` = Responses API)
   - Anki-Connect URL (default `http://127.0.0.1:8765`)
   - Target deck (default `CFA::Practical Problems`, created automatically)
   - Use the **Test Anki** / **Test LLM** buttons to verify both connections.
5. Open a practical problem page → click **📥 Save to Anki** on any question.

## Development

- `test/sample.html` is a local fixture replicating the question HTML
  (one failed, one unanswered, one correct). To test detection against it:
  `chrome://extensions` → extension details → enable
  **Allow access to file URLs**, then open the file in a tab.
- If CFAI changes its markup, the selectors live in `src/content.js`
  (`extractOptions`, `.user_content`, `.fs-mask`, `svg[name="IconCheck"]`…).

## Notes & limitations

- The LLM gets **only the question and options** — the page's official
  feedback text is never sent and never shown on the card.
- Math formulas rendered by MathJax degrade to plain text on the card.
- The API key is stored in `chrome.storage.local`; requests go directly from
  the extension to your chosen endpoint.
- The note type is created once, only if missing — templates you customize
  inside Anki are never overwritten.
