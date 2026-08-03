/* CFA Practical Problem → Anki
 * Content script: detects CFA Institute quiz question blocks on the page,
 * injects a "Save to Anki" button per question, and extracts structured
 * question data on click.
 *
 * The quiz UI is an SPA: questions swap in and out without a URL change, and
 * the markup can live inside shadow roots (web components) that a plain
 * querySelectorAll / MutationObserver on the document cannot see. We
 * therefore traverse shadow roots when scanning, attach observers to every
 * shadow root we find, and re-wire observers as new roots appear.
 */
(() => {
  'use strict';

  const TAG = 'cfa2anki';
  const Q_SELECTOR = 'div[data-quiz-question-id]';
  const RADIO_SELECTOR = 'input[name^="interaction_"]';
  const BUTTON_SAVE = '📥 Save to Anki';
  const BUTTON_RE_ADD = '↻ Re-add to Anki';
  const BUTTON_AI = '✨ AI Explain';
  const STATUS_ADDED = '✓ Added to Anki';

  // Question id: from the attribute (review mode) or derived from the radio
  // names (practice mode, where the wrapper has no data-quiz-question-id).
  function getQid(qEl) {
    const attr = qEl.getAttribute('data-quiz-question-id');
    if (attr) return attr;
    const m = qEl.querySelector(RADIO_SELECTOR)?.name.match(/^interaction_(.+)$/);
    if (m) {
      qEl.setAttribute('data-quiz-question-id', m[1]); // keep DOM consistent
      return m[1];
    }
    return null;
  }

  // Injected as a <style> into the document AND into every shadow root —
  // shadow roots do not inherit document styles.
  const STYLE_TEXT = `
.cfa2anki-wrap { margin: 14px 0 6px; text-align: left; }
/* Outline button in Anki's dark gray — no state colors; "done" just mutes
   to the lighter gray. */
.cfa2anki-btn {
  font: 600 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  color: #333; background: #fff; border: 1px solid #333;
  border-radius: 8px; padding: 9px 14px; cursor: pointer;
  transition: background .15s;
}
.cfa2anki-btn:hover:not(:disabled) { background: #f1f5f9; }
.cfa2anki-btn.done { color: #64748b; border-color: #cbd5e1; }
.cfa2anki-btn.done:hover:not(:disabled) { background: #f1f5f9; }
.cfa2anki-btn:disabled { opacity: .55; }
/* Secondary action: less outstanding, pushed to the right edge of the row. */
.cfa2anki-btn-ai {
  margin-left: auto;
  font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  color: #475569; background: #fff; border: 1px solid #cbd5e1;
  border-radius: 8px; padding: 8px 12px; cursor: pointer;
  transition: background .15s;
}
.cfa2anki-btn-ai:hover:not(:disabled) { background: #f1f5f9; }
.cfa2anki-btn-ai:disabled { opacity: .55; }
.cfa2anki-status {
  display: inline-block;
  font: 600 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  color: #15803d; background: #f0fdf4; border: 1px solid #bbf7d0;
  border-radius: 999px; padding: 4px 10px; margin-right: 8px; vertical-align: middle;
}
/* The pill's own display rule would otherwise override the hidden attribute
   (author styles beat the UA's [hidden] { display:none }) — restore it. */
.cfa2anki-status[hidden] { display: none; }
/* Button row: status pill + save button on the left, AI Explain pushed to
   the right edge. */
.cfa2anki-wrap { display: flex; align-items: center; gap: 8px; }
/* Card-face previews: the rendered Anki card, framed like a sheet of paper.
   Their content lives in a closed shadow root, so page styles can't restyle
   them (and the page can't see them). */
.cfa2anki-preview, .cfa2anki-preview-front {
  display: block; margin: 12px 0 4px;
  border: 1px solid #e2e8f0; border-radius: 14px; overflow: hidden;
  background: #fff; box-shadow: 0 2px 12px rgba(15, 23, 42, .08);
  text-align: left; /* the page's styles can't re-center the preview */
}
.cfa2anki-toast {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
  background: #111827; color: #fff; font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  padding: 10px 16px; border-radius: 10px; max-width: 340px;
  box-shadow: 0 4px 12px rgba(0,0,0,.3);
  opacity: 0; transform: translateY(8px); transition: opacity .2s, transform .2s;
  pointer-events: none;
}
.cfa2anki-toast.show { opacity: 1; transform: translateY(0); }
.cfa2anki-toast.error { background: #b91c1c; }
.cfa2anki-spinner {
  display: inline-block; width: 12px; height: 12px; margin-right: 7px;
  border: 2px solid rgba(255,255,255,.4); border-top-color: #fff;
  border-radius: 50%; vertical-align: -1px;
  animation: cfa2anki-spin .7s linear infinite;
}
@keyframes cfa2anki-spin { to { transform: rotate(360deg); } }
.cfa2anki-popover {
  position: fixed; z-index: 2147483647;
  background: #111827; color: #fff;
  font: 600 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  padding: 8px 12px; border-radius: 8px;
  box-shadow: 0 4px 14px rgba(0,0,0,.35);
  max-width: 300px;
  opacity: 0; transform: translateY(4px);
  transition: opacity .18s, transform .18s;
  pointer-events: none;
}
.cfa2anki-popover.show { opacity: 1; transform: translateY(0); }
.cfa2anki-popover::before {
  content: ''; position: absolute; top: -5px; left: 16px;
  border-left: 5px solid transparent; border-right: 5px solid transparent;
  border-bottom: 5px solid #111827;
}
`;

  // "Added" status is NOT stored locally — it is a cache of the last
  // Anki status query (qid → noteId), refreshed on mutations and after adds.
  const ankiState = new Map();

  // Preview state per question: the LLM study note (so "Save to Anki" reuses
  // it instead of re-requesting) and the rendered card faces (back once
  // "AI Explain" ran, front once the card is saved). Kept so SPA re-renders
  // can restore previews without another LLM/Anki round trip.
  const previewCache = new Map(); // qid → { llm, front: {html,css}|null, back: {html,css}|null }
  // host element → its closed shadow root (the only reference that survives).
  const previewRoots = new WeakMap();

  // Reloading the extension (chrome://extensions) while a quiz tab stays open
  // severs the old content script's Chrome API bindings: its buttons keep
  // working, but chrome.runtime goes undefined. Detect that state so we can
  // tell the user to refresh the page instead of failing with a TypeError.
  const CONTEXT_LOST_MSG =
    'Extension connection lost — it was probably reloaded. Refresh this page to continue.';
  function runtimeAvailable() {
    return Boolean(chrome?.runtime?.id);
  }

  /* ---------------- extraction ---------------- */

  // Keep only tags that render well inside an Anki card; drop scripts,
  // styles, event handlers, and Canvas's layout classes.
  const ALLOWED_TAGS = new Set([
    'p', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'br', 'span',
    'div', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img', 'blockquote', 'code', 'pre'
  ]);

  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const node of doc.body.querySelectorAll('*')) {
      const tag = node.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        node.replaceWith(...node.childNodes);
        continue;
      }
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        const keep = tag === 'img' && (name === 'src' || name === 'alt');
        if (!keep && (name.startsWith('on') || name.startsWith('aria-') ||
            ['style', 'class', 'id', 'tabindex', 'role'].includes(name))) {
          node.removeAttribute(attr.name);
        }
      }
    }
    return doc.body.innerHTML;
  }

  // Option values are UUIDs on the live site — strip them from any text we
  // collect instead of trusting input.value.
  const UUID_RE_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  function cleanText(s) {
    return String(s ?? '')
      .replace(UUID_RE_G, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^\s*Answer:\s*/i, ' ')
      .replace(/Correct Answer Feedback:[\s\S]*/gi, ' ')
      .replace(/Incorrect Answer Feedback:[\s\S]*/gi, ' ')
      .replace(/Correct answer:\s*/gi, ' ')
      .replace(/Incorrect answer:\s*/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // textContent does NOT include shadow-root content — the quiz engine may
  // render option text inside web components, so collect it recursively.
  function deepText(node) {
    if (!node) return '';
    let t = node.nodeType === Node.TEXT_NODE ? node.textContent : (node.textContent || '');
    if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot) {
      t += ' ' + deepText(node.shadowRoot);
    }
    return t;
  }

  // Find the smallest ancestor that contains exactly this one option input —
  // a structural (class-name independent) replacement for the sample's
  // .fs-mask wrapper. It also carries the state icon (IconCheck/IconX).
  function optionRegion(input) {
    let node = input;
    while (node.parentElement) {
      const parent = node.parentElement;
      if (parent.querySelectorAll('input[type="radio"]').length === 1) {
        node = parent; // still inside this option's own subtree
        continue;
      }
      break; // reached a level spanning multiple options
    }
    return node;
  }

  // Each option is a radio input. Option text lives in different wrappers
  // depending on the render — try the content wrapper, then the label, then
  // aria-label/title (the input itself carries "Answer: A. …" on the live
  // site), then the whole option region (incl. shadow roots, minus noise).
  function optionText(region, labelEl, input) {
    const candidates = [];
    const contentEl = (labelEl || region)?.querySelector('.user_content');
    if (contentEl) candidates.push(deepText(contentEl));
    if (labelEl && labelEl !== contentEl) candidates.push(deepText(labelEl));
    const aria = input?.getAttribute('aria-label')
      || labelEl?.getAttribute('aria-label')
      || region?.getAttribute('aria-label')
      || region?.getAttribute('title');
    if (aria) candidates.push(aria);
    if (region && region !== contentEl && region !== labelEl) candidates.push(deepText(region));
    for (const raw of candidates) {
      const text = cleanText(raw);
      if (text && text.length > 1) return text;
    }
    return '';
  }

  // Official per-option feedback: each option region carries a second
  // .user_content div whose label span reads "Correct Answer Feedback:"
  // (correct option) or "Incorrect Answer Feedback:" (each wrong option).
  // Unanswered questions have no feedback blocks at all. Returns sanitized
  // HTML (for the card) + plain text (for the LLM prompt), or empty strings.
  function optionTip(region) {
    if (!region) return { tip: '', tipText: '' };
    const isFeedbackLabel = s => /^(Correct|Incorrect) Answer Feedback:\s*$/i.test(s || '');
    const el = [...region.querySelectorAll('.user_content')]
      .find(node => [...node.querySelectorAll('span')].some(span => isFeedbackLabel(span.textContent)));
    if (!el) return { tip: '', tipText: '' };
    const clone = el.cloneNode(true);
    const label = [...clone.querySelectorAll('span')].find(span => isFeedbackLabel(span.textContent));
    label?.remove();
    return { tip: sanitizeHtml(clone.innerHTML), tipText: richText(clone) };
  }

  function extractOptions(qEl, qid) {
    const inputs = qEl.querySelectorAll(`input[name="interaction_${qid}"]`);
    return [...inputs].map((input, i) => {
      const region = optionRegion(input);
      const labelEl = input.closest('label');
      let text = optionText(region, labelEl, input);
      if (!text) {
        console.warn('[CFA2Anki] option text not found, using placeholder', {
          qid,
          html: (region || input).outerHTML?.slice(0, 600)
        });
        text = `Option ${i + 1}`;
      }
      const m = text.match(/^([A-Za-z])\./);
      const letter = m ? m[1].toUpperCase() : String.fromCharCode(65 + i);
      const tip = optionTip(region);
      return {
        letter,
        text,
        isCorrect: !!region?.querySelector('svg[name="IconCheck"]'),
        isPicked: input.checked,
        tip: tip.tip,
        tipText: tip.tipText,
        _region: region // internal, stripped before sending
      };
    });
  }

  function getStatus(options) {
    const picked = options.find(o => o.isPicked);
    if (!picked) return 'unanswered';
    return picked.isCorrect ? 'correct' : 'failed';
  }

  function extractQuestion(qEl) {
    const qid = getQid(qEl);
    const rawOptions = extractOptions(qEl, qid);
    const regions = rawOptions.map(o => o._region).filter(Boolean);
    // The stem is the first content wrapper NOT inside an option region/label.
    const stemEl = [...qEl.querySelectorAll('.user_content')]
      .find(el => !el.closest('label') && !regions.some(r => r.contains(el)));
    const vignette = findVignette(qEl);
    const options = rawOptions.map(({ _region, ...rest }) => rest);
    const stemHtml = sanitizeHtml(stemEl ? stemEl.innerHTML : '');
    const vignetteHtml = vignette ? sanitizeHtml(vignette.innerHTML) : '';
    return {
      qid,
      status: getStatus(options),
      // The vignette becomes part of the card front (and back) so the
      // question is self-contained.
      stemHtml: vignetteHtml ? `<div class="vignette">${vignetteHtml}</div>${stemHtml}` : stemHtml,
      stemText: richText(stemEl),
      vignetteText: richText(vignette),
      options,
      pageUrl: location.href
    };
  }

  /* ---------------- UI: button + toast ---------------- */

  function injectButton(qEl) {
    if (qEl.querySelector(`.${TAG}-btn`)) return;
    // Fallback containers are often <span> grids — adapt the wrapper element
    // and let it span the full row so the button always sits below the stem.
    const wrap = document.createElement(qEl.tagName === 'SPAN' ? 'span' : 'div');
    wrap.className = `${TAG}-wrap`;
    if (qEl.tagName === 'SPAN') {
      wrap.style.display = 'flex';
      wrap.style.gridColumn = '1 / -1';
    }
    const status = document.createElement('span');
    status.className = `${TAG}-status`;
    status.textContent = STATUS_ADDED;
    status.hidden = true;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${TAG}-btn`;
    btn.addEventListener('click', () => onClick(btn, qEl));
    const btnAi = document.createElement('button');
    btnAi.type = 'button';
    btnAi.className = `${TAG}-btn-ai`;
    btnAi.textContent = BUTTON_AI;
    btnAi.addEventListener('click', () => onExplain(btnAi, qEl));
    wrap.append(status, btn, btnAi);
    qEl.appendChild(wrap);
  }

  // Render LaTeX math inside a preview shadow root. CFA pages already load
  // MathJax — use it (v3 typesetPromise, v2 Hub); otherwise load MathJax 3
  // from a CDN once (CSP permitting). Without MathJax the styled LaTeX
  // source still shows, display math on its own line.
  let mathJaxLoaded = false;
  function typesetMath(root) {
    if (!/\\[\(\[]/.test(root.innerHTML)) return;
    const M = window.MathJax;
    if (M && typeof M.typesetPromise === 'function') {
      M.typesetPromise([root]).catch(() => {});
    } else if (M && M.Hub) {
      M.Hub.Queue(['Typeset', M.Hub, root]);
    } else if (!mathJaxLoaded) {
      mathJaxLoaded = true;
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js';
      s.async = true;
      s.addEventListener('load', () => {
        if (window.MathJax?.typesetPromise) window.MathJax.typesetPromise([root]).catch(() => {});
      });
      root.appendChild(s);
    }
  }

  // Show a card face right under the button. HTML/CSS are rendered by the
  // background from the note type's own templates (single source of truth)
  // and live in a closed shadow root — page styles can't restyle the card,
  // and the page's framework can't touch it. The front sits above the back,
  // like flipping the card.
  function renderPreview(qEl, role, html, css) {
    const wrap = qEl.querySelector(`.${TAG}-wrap`);
    if (!wrap) return;
    const cls = `${TAG}-preview${role === 'front' ? '-front' : ''}`;
    let host = qEl.querySelector(`.${cls}`);
    if (!host) {
      host = document.createElement(qEl.tagName === 'SPAN' ? 'span' : 'div');
      host.className = cls;
      if (qEl.tagName === 'SPAN') {
        host.style.display = 'block';
        host.style.gridColumn = '1 / -1';
      }
      const other = qEl.querySelector(role === 'front' ? `.${TAG}-preview` : `.${TAG}-preview-front`);
      if (other) other.insertAdjacentElement(role === 'front' ? 'beforebegin' : 'afterend', host);
      else wrap.insertAdjacentElement('afterend', host);
    }
    host.dataset.qid = getQid(qEl);
    let root = previewRoots.get(host);
    if (!root) {
      root = host.attachShadow({ mode: 'closed' });
      previewRoots.set(host, root);
    }
    root.innerHTML = `<style>${css}</style>${html}`;
    typesetMath(root);
  }

  function refreshButtons() {
    collectQuestions().forEach(qEl => {
      const btn = qEl.querySelector(`.${TAG}-btn`);
      // Skip buttons currently mid-add — a scan must not clobber the
      // spinner/adding state while the request is in flight.
      if (!btn || btn.dataset.busy === '1') return;
      const qid = getQid(qEl);
      const saved = ankiState.has(qid);
      const statusEl = qEl.querySelector(`.${TAG}-status`);
      if (statusEl) statusEl.hidden = !saved;
      btn.classList.toggle('done', saved);
      btn.textContent = saved ? BUTTON_RE_ADD : BUTTON_SAVE;
      btn.disabled = false;
      // Card-face previews belong to a question: when the SPA swaps the
      // container to a new question, drop stale previews; if the same
      // question re-rendered without them (or re-parsed the container's
      // HTML, which recreates the host without its shadow root), restore
      // them from the cache.
      for (const role of ['back', 'front']) {
        const cls = role === 'front' ? `${TAG}-preview-front` : `${TAG}-preview`;
        const host = qEl.querySelector(`.${cls}`);
        const intact = host && host.dataset.qid === qid && previewRoots.has(host);
        if (host && !intact) host.remove();
        if (!intact) {
          const cached = previewCache.get(qid)?.[role];
          if (cached) renderPreview(qEl, role, cached.html, cached.css);
        }
      }
    });
  }

  // Small bubble anchored under the button, auto-dismisses.
  function showPopover(anchor, msg) {
    let el = document.querySelector(`.${TAG}-popover`);
    if (!el) {
      el = document.createElement('div');
      el.className = `${TAG}-popover`;
      document.body.appendChild(el);
    }
    el.textContent = msg;
    const r = anchor.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 12))}px`;
    el.style.top = `${r.bottom + 8}px`;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 4000);
  }

  // Debounced Anki status refresh — triggered by page mutations and after
  // adds, never by the 1s safety-net scan, so Anki-Connect isn't hammered.
  let statusTimer = null;
  function scheduleStatusRefresh() {
    if (statusTimer) return;
    statusTimer = setTimeout(async () => {
      statusTimer = null;
      await refreshAnkiStatus();
    }, 600);
  }

  async function refreshAnkiStatus() {
    if (!runtimeAvailable()) return; // extension reloaded — nothing to ask
    const qids = [...new Set(collectQuestions().map(q => getQid(q)).filter(Boolean))];
    if (!qids.length) return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CHECK_STATUS', qids });
      if (res?.ok) {
        ankiState.clear();
        for (const [qid, noteId] of Object.entries(res.map || {})) ankiState.set(qid, noteId);
        refreshButtons();
        // Questions already in Anki get their card back rendered under the
        // button (e.g. after a reload) so the explanation stays readable.
        fetchCardBacks();
      }
    } catch {
      // Anki unreachable — keep the last known status.
    }
  }

  // qids with an in-flight card-back fetch (avoid duplicate requests).
  const pendingBacks = new Set();
  async function fetchCardBacks() {
    if (!runtimeAvailable()) return;
    const missing = [];
    for (const qEl of collectQuestions()) {
      const qid = getQid(qEl);
      if (!qid || !ankiState.has(qid)) continue; // only added problems
      if (previewCache.get(qid)?.back || pendingBacks.has(qid)) continue;
      pendingBacks.add(qid);
      missing.push({ qid, qEl });
    }
    if (!missing.length) return;
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'GET_CARD_BACKS',
        qids: missing.map(m => m.qid)
      });
      if (res?.ok && res.backs) {
        for (const { qid, qEl } of missing) {
          const b = res.backs[qid];
          if (b?.cardBackHtml && b.cardCss) {
            const prev = previewCache.get(qid) || {};
            previewCache.set(qid, { ...prev, back: { html: b.cardBackHtml, css: b.cardCss } });
            renderPreview(qEl, 'back', b.cardBackHtml, b.cardCss);
          }
        }
      }
    } catch {
      // Anki unreachable — keep the last known state.
    } finally {
      for (const m of missing) pendingBacks.delete(m.qid);
    }
  }

  async function onClick(btn, qEl) {
    if (!runtimeAvailable()) {
      toast(CONTEXT_LOST_MSG, true);
      return;
    }
    const payload = extractQuestion(qEl);
    // Reuse the note generated by "AI Explain" instead of requesting a fresh
    // one from the LLM.
    const llm = previewCache.get(payload.qid)?.llm;
    if (llm) payload.llm = llm;
    const wrap = btn.closest(`.${TAG}-wrap`);
    // Adding state: spinner + disabled until Anki confirms the note exists.
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.classList.remove('done');
    btn.innerHTML = `<span class="${TAG}-spinner"></span>Adding to Anki…`;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'SAVE_QUESTION', payload });
      if (res?.ok && res.verified) {
        ankiState.set(payload.qid, res.noteId);
        delete btn.dataset.busy;
        refreshButtons();
        showPopover(wrap, res.replaced ? 'Card re-added to Anki ✓' : 'Card added to Anki ✓');
        // The card is saved: show its faces under the button. The back is
        // always shown (reusing the "AI Explain" content, re-rendered from
        // Anki's stored copy so it matches what was stored); the front is
        // only shown for direct saves — after "AI Explain" it just repeats
        // the question already on the page.
        if (res.cardFrontHtml && res.cardCss) {
          const prev = previewCache.get(payload.qid) || {};
          const aiExplained = !!(prev.llm || llm);
          previewCache.set(payload.qid, {
            llm: prev.llm || llm || null,
            front: aiExplained ? null : { html: res.cardFrontHtml, css: res.cardCss },
            back: res.cardBackHtml ? { html: res.cardBackHtml, css: res.cardCss } : prev.back || null
          });
          if (aiExplained) {
            qEl.querySelector(`.${TAG}-preview-front`)?.remove();
          } else {
            renderPreview(qEl, 'front', res.cardFrontHtml, res.cardCss);
          }
          if (res.cardBackHtml) renderPreview(qEl, 'back', res.cardBackHtml, res.cardCss);
        }
      } else {
        delete btn.dataset.busy;
        refreshButtons();
        scheduleStatusRefresh();
        toast(`Could not add card: ${res?.error || 'Anki did not confirm the card — try again'}`, true);
      }
    } catch (err) {
      delete btn.dataset.busy;
      refreshButtons();
      scheduleStatusRefresh();
      toast(`Could not add card: ${err.message}`, true);
    }
  }

  // "AI Explain": generate the explanation (LLM) and preview the card back —
  // nothing is written to Anki. The generated note is cached so "Save to
  // Anki" can reuse it.
  async function onExplain(btnAi, qEl) {
    if (!runtimeAvailable()) {
      toast(CONTEXT_LOST_MSG, true);
      return;
    }
    const payload = extractQuestion(qEl);
    const wrap = btnAi.closest(`.${TAG}-wrap`);
    btnAi.dataset.busy = '1';
    btnAi.disabled = true;
    btnAi.innerHTML = `<span class="${TAG}-spinner"></span>Explaining…`;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'EXPLAIN_QUESTION', payload });
      if (res?.ok && res.cardBackHtml && res.cardCss) {
        // The explanation replaces the front preview — the front would just
        // repeat the question that is already on the page.
        previewCache.set(payload.qid, {
          llm: res.llm,
          front: null,
          back: { html: res.cardBackHtml, css: res.cardCss }
        });
        renderPreview(qEl, 'back', res.cardBackHtml, res.cardCss);
        qEl.querySelector(`.${TAG}-preview-front`)?.remove();
        showPopover(wrap, 'Explanation ready — click Save to Anki to add the card');
      } else {
        toast(`Could not generate explanation: ${res?.error || 'the request failed — try again'}`, true);
      }
    } catch (err) {
      toast(`Could not generate explanation: ${err.message}`, true);
    } finally {
      delete btnAi.dataset.busy;
      btnAi.disabled = false;
      btnAi.textContent = BUTTON_AI;
    }
  }

  function toast(msg, isError = false) {
    let el = document.querySelector(`.${TAG}-toast`);
    if (!el) {
      el = document.createElement('div');
      el.className = `${TAG}-toast`;
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 4500);
  }

  /* ---------------- SPA watching (incl. shadow DOM) ---------------- */

  const styledRoots = new WeakSet();
  function ensureStyle(root) {
    if (styledRoots.has(root)) return;
    styledRoots.add(root);
    const style = document.createElement('style');
    style.dataset.cfa2anki = 'true';
    style.textContent = STYLE_TEXT;
    (root === document ? document.head : root).appendChild(style);
  }

  const observedRoots = new WeakSet();
  // Observe every mutation type that can signal a question shift: node swaps
  // (childList), reused containers whose data-quiz-question-id is updated
  // in place (attributes), and React-style text-only updates (characterData).
  const OBSERVE_OPTS = {
    childList: true,
    subtree: true,
    attributes: true,
    // qid + aria-label: reused containers updated in place (question shift);
    // name/checked: practice-mode radios updated when the question or the
    // user's answer state changes.
    attributeFilter: ['data-quiz-question-id', 'aria-label', 'name', 'checked'],
    characterData: true
  };

  function ensureObserved(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    const obs = new MutationObserver(() => {
      scheduleScan();
      scheduleStatusRefresh(); // question swaps / answers → resync with Anki
      observeShadowRoots(root); // pick up any newly-created shadow roots
    });
    obs.observe(root, OBSERVE_OPTS);
  }

  // Attach observers + styles to every shadow root under `root`, recursively.
  function observeShadowRoots(root) {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        ensureStyle(el.shadowRoot);
        ensureObserved(el.shadowRoot);
        observeShadowRoots(el.shadowRoot);
      }
    }
  }

  // querySelectorAll that also descends into shadow roots.
  function queryAllDeep(root, selector) {
    const found = [];
    const visit = (node) => {
      for (const el of node.querySelectorAll(selector)) found.push(el);
      for (const el of node.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(root);
    return found;
  }

  function commonAncestor(els) {
    let node = els[0].parentElement;
    while (node && !els.every(el => node.contains(el))) node = node.parentElement;
    return node;
  }

  // Practice mode: no data-quiz-question-id wrapper. Group the interaction
  // radios by name and climb from their common ancestor until the container
  // also holds the question stem (a .user_content outside any option label).
  function findQuestionContainer(group) {
    let node = commonAncestor(group);
    for (let i = 0; i < 8 && node?.parentElement; i++) {
      const hasStem = [...node.querySelectorAll('.user_content')]
        .some(el => !el.closest('label'));
      if (hasStem) break;
      node = node.parentElement;
    }
    return node;
  }

  function collectQuestions(root = document) {
    const found = queryAllDeep(root, Q_SELECTOR);
    if (found.length) return found;
    const byName = new Map();
    for (const input of queryAllDeep(root, RADIO_SELECTOR)) {
      if (!byName.has(input.name)) byName.set(input.name, []);
      byName.get(input.name).push(input);
    }
    for (const group of byName.values()) {
      const container = findQuestionContainer(group);
      if (container) found.push(container);
    }
    return found;
  }

  // Vignette scenario: a shared context block (intro text + exhibits) that
  // precedes one or more questions and lives OUTSIDE any question container.
  // Without it, a card asking about "the data in Exhibit 1" has no data.
  function isVignetteLike(el) {
    const text = cleanText(el.textContent);
    return text.length >= 30 || !!el.querySelector('table, img');
  }

  function findVignette(qEl) {
    let node = qEl.parentElement;
    for (let depth = 0; depth < 6 && node && node !== document.body; depth++) {
      let sib = node.previousElementSibling;
      while (sib) {
        const v = queryAllDeep(sib, '.user_content')
          .find(el => !el.closest('[data-quiz-question-id], fieldset, .fs-mask') && isVignetteLike(el));
        if (v) return v;
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return null;
  }

  // Text with tables rendered as readable rows ("Total debt | 2,000 | 1,900")
  // — plain textContent glues table cells together without separators.
  function richText(el) {
    if (!el) return '';
    let text = '';
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { text += node.textContent; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (tag === 'tr') text += '\n';
      else if (tag === 'td' || tag === 'th') text += ' | ';
      else if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'br', 'table'].includes(tag)) text += '\n';
      if (node.shadowRoot) walk(node.shadowRoot);
      for (const child of node.childNodes) walk(child);
    };
    walk(el);
    return text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function shadowRootCount(root = document) {
    let n = 0;
    const visit = (node) => {
      for (const el of node.querySelectorAll('*')) {
        if (el.shadowRoot) {
          n++;
          visit(el.shadowRoot);
        }
      }
    };
    visit(root);
    return n;
  }

  function findDeep(root, selector) {
    for (const el of root.querySelectorAll(selector)) return el;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const r = findDeep(el.shadowRoot, selector);
        if (r) return r;
      }
    }
    return null;
  }

  function debugInfo() {
    const questions = collectQuestions();
    return {
      href: location.href,
      frame: window === window.top ? 'top' : 'iframe',
      questionBlocks: questions.length,
      withButtons: questions.filter(q => q.querySelector(`.${TAG}-btn`)).length,
      iframes: [...document.querySelectorAll('iframe')].map(f => f.src || '(no src)'),
      shadowRoots: shadowRootCount(),
      hasCfaMarkup: !!findDeep(document, '.fs-mask, .user_content')
    };
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 150);
  }

  let lastCount = -1;
  let iframeLogDone = false;
  // Stamp each question container with the qid it showed last scan, so a
  // question shift (even with the container element reused) is visible in
  // the console and the button/status state is re-derived from fresh data.
  const stampedQids = new WeakMap();
  function scan() {
    const els = collectQuestions();
    els.forEach(qEl => {
      const qid = getQid(qEl);
      if (stampedQids.get(qEl) !== qid) {
        stampedQids.set(qEl, qid);
        console.log(`[CFA2Anki] question ${qid} rendered on ${location.href}`);
      }
    });
    if (els.length !== lastCount) {
      lastCount = els.length;
      console.log(`[CFA2Anki] scan: ${els.length} question block(s) on ${location.href}`);
    }
    // If nothing was found, surface the frames once — the quiz usually lives
    // in a cross-origin iframe the content script can't reach.
    if (els.length === 0 && !iframeLogDone) {
      iframeLogDone = true;
      const frames = [...document.querySelectorAll('iframe')].map(f => f.src || '(no src)');
      console.log('[CFA2Anki] iframes on page:', frames.length ? frames : 'none');
    }
    els.forEach(injectButton);
    refreshButtons();
    publishDebug();
  }

  // The content script runs in an isolated world, so page-visible debug data
  // must travel via the DOM, not window globals.
  function publishDebug() {
    try {
      document.body.dataset.cfa2anki = JSON.stringify(debugInfo());
    } catch { /* body may not exist yet */ }
  }

  function init() {
    console.log(`[CFA2Anki] content script loaded on ${location.href}${window === window.top ? '' : ' (iframe)'}`);
    ensureStyle(document);
    ensureObserved(document);
    observeShadowRoots(document);
    scan();
    scheduleStatusRefresh();
    // Safety net: catches swaps that slip past the observers (e.g. stylesheet-
    // driven visibility changes). Polls cheaply every second.
    setInterval(scan, 1000);
    // Dev-loop friendliness: reloading the extension severs this script's
    // chrome.runtime while the tab stays open. On the next focus, say so once
    // instead of letting the first click fail with a cryptic error.
    let contextLostNotified = false;
    window.addEventListener('focus', () => {
      if (!runtimeAvailable() && !contextLostNotified) {
        contextLostNotified = true;
        toast(CONTEXT_LOST_MSG, true);
      }
    });
  }

  init();
})();
