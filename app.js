'use strict';

const $ = s => document.querySelector(s);

// ---------- persistence (per-browser conveniences only) ----------

function load(key, fallback) {
  try {
    const v = localStorage.getItem('lp.' + key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem('lp.' + key, JSON.stringify(value)); } catch { }
}

const state = {
  lang: load('lang', 'fr'),
  mode: load('mode', 'phrases'),     // phrases | dialogues | conversation
  input: load('input', 'speech'),    // speech | writing
  category: 0,
  dialogue: 0,
  step: -1,
};
if (!LANGS[state.lang]) state.lang = 'fr';
if (!['phrases', 'dialogues', 'conversation'].includes(state.mode)) state.mode = 'phrases';
const scores = load('scores', {});

function esc(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Wraps every word in a span that remembers its character range, so the
// word being spoken can be highlighted.
function wordsHTML(text) {
  let html = '';
  let last = 0;
  for (const m of text.matchAll(/\S+/g)) {
    html += esc(text.slice(last, m.index));
    const end = m.index + m[0].length;
    html += /[\p{L}\p{N}]/u.test(m[0])
      ? `<span class="w" data-s="${m.index}" data-e="${end}">${esc(m[0])}</span>`
      : esc(m[0]);
    last = end;
  }
  return html + esc(text.slice(last));
}

// ---------- speech synthesis ----------

const synth = window.speechSynthesis;

function voicesFor(lang) {
  if (!synth) return [];
  const prefix = LANGS[lang].tts.slice(0, 2);
  return synth.getVoices().filter(v => v.lang.toLowerCase().replace('_', '-').startsWith(prefix));
}

function pickVoice() {
  const voices = voicesFor(state.lang);
  const saved = load('voice.' + state.lang, null);
  return voices.find(v => v.name === saved)
    || voices.find(v => /natural|online/i.test(v.name))
    || voices[0]
    || null;
}

let speaking = null; // { u, el, timers, gotBoundary }

function stopSpeaking() {
  if (speaking) {
    speaking.timers.forEach(clearTimeout);
    if (speaking.el) {
      speaking.el.classList.remove('speaking');
      speaking.el.querySelectorAll('.speaking').forEach(w => w.classList.remove('speaking'));
    }
    speaking = null;
  }
  if (synth) synth.cancel();
}

// Speaks `text`. If `el` holds the text as word spans (see wordsHTML), each
// word is highlighted as it is spoken. Voices that report word boundaries
// drive the highlight exactly; for the others it is estimated from timing.
// With `word` (a single word span), only that word is spoken and highlighted.
function speak(text, { slow = false, el = null, word = null } = {}) {
  if (!synth) return;
  stopSpeaking();
  // "…" is a single character, so replacing it keeps word offsets intact.
  const u = new SpeechSynthesisUtterance(text.replace(/…/g, ' '));
  u.lang = LANGS[state.lang].tts;
  const voice = pickVoice();
  if (voice) u.voice = voice;
  const rate = parseFloat($('#rate').value);
  u.rate = slow ? Math.max(0.4, rate * 0.65) : rate;

  const me = { u, el: word || el, timers: [], gotBoundary: false };
  speaking = me;
  u.onend = u.onerror = () => { if (speaking === me) stopSpeaking(); };

  if (word) {
    u.onstart = () => { if (speaking === me) word.classList.add('speaking'); };
    synth.speak(u);
    return;
  }

  const words = el ? [...el.querySelectorAll('.w')] : [];
  const mark = w => words.forEach(x => x.classList.toggle('speaking', x === w));

  u.onstart = () => {
    if (speaking !== me || !words.length) return;
    // Timing-based fallback; cancelled as soon as a real boundary event arrives.
    const msPerChar = 72 / u.rate;
    let t = 0;
    for (const w of words) {
      me.timers.push(setTimeout(() => { if (speaking === me && !me.gotBoundary) mark(w); }, t));
      t += (w.textContent.length + 1) * msPerChar + 60;
    }
  };
  u.onboundary = e => {
    if (speaking !== me || !words.length) return;
    if (e.name && e.name !== 'word') return;
    if (!me.gotBoundary) {
      me.gotBoundary = true;
      me.timers.forEach(clearTimeout);
    }
    const i = e.charIndex;
    const w = words.find(x => +x.dataset.s <= i && i < +x.dataset.e)
      || words.find(x => +x.dataset.s >= i);
    if (w) mark(w);
  };

  synth.speak(u);
}

// Click any word to hear it on its own.
document.addEventListener('click', e => {
  const w = e.target.closest('.w');
  if (!w) return;
  const text = w.textContent.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (text) speak(text, { word: w });
});

// ---------- speech recognition (push and hold) ----------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// Starts recognising until session.rec.stop() is called. session.done
// resolves with alternative transcripts of everything said ([] if nothing).
function startRecognition() {
  if (!Recognition) throw new Error('not-supported');
  stopSpeaking();
  const rec = new Recognition();
  rec.lang = LANGS[state.lang].asr;
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 5;
  const finals = [];
  let interim = '';
  const session = { rec, onInterim: null };

  const text = () => [...finals.filter(Boolean).map(f => f[0]), interim].join(' ').replace(/\s+/g, ' ').trim();

  session.done = new Promise((resolve, reject) => {
    rec.onresult = e => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finals[i] = Array.from(r).map(a => a.transcript.trim());
        else interim += r[0].transcript;
      }
      if (session.onInterim) session.onInterim(text());
    };
    rec.onerror = e => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') reject(new Error(e.error));
    };
    rec.onend = () => {
      const parts = finals.filter(Boolean);
      const alts = parts.length === 1 && !interim.trim() ? parts[0] : [text()];
      resolve(alts.map(a => a.trim()).filter(Boolean));
    };
  });
  rec.start();
  return session;
}

// Makes `btn` a push-and-hold microphone: recording runs while the button
// (or Space/Enter on it) is held down and stops when it is released.
function holdToTalk(btn, { onInterim = () => { }, onResult, onError }) {
  let session = null;

  const start = e => {
    if (session || btn.disabled) return;
    e.preventDefault();
    let s;
    try { s = startRecognition(); } catch (err) { onError(err); return; }
    session = s;
    const label = btn.textContent;
    btn.classList.add('recording');
    btn.textContent = '🔴 Listening… release when done';
    s.onInterim = onInterim;
    s.done.then(onResult, onError).finally(() => {
      if (session === s) session = null;
      btn.classList.remove('recording');
      btn.textContent = label;
    });
  };
  const stop = () => {
    if (!session || session.stopping) return;
    const s = session;
    s.stopping = true;
    btn.classList.remove('recording');
    btn.textContent = '⏳ …';
    // Keep listening briefly after release so the last syllable isn't cut off.
    setTimeout(() => s.rec.stop(), 500);
  };

  btn.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (btn.setPointerCapture) btn.setPointerCapture(e.pointerId);
    start(e);
  });
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointercancel', stop);
  btn.addEventListener('lostpointercapture', stop);
  btn.addEventListener('keydown', e => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) start(e);
  });
  btn.addEventListener('keyup', e => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); stop(); }
  });
  btn.addEventListener('contextmenu', e => e.preventDefault());
}

function micError(err) {
  switch (err.message) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access was blocked. Allow it in the address bar and try again.';
    case 'not-supported':
      return 'Speech recognition is not supported in this browser. Try Edge or Chrome, or switch to ⌨️ Writing.';
    case 'network':
      return 'Speech recognition needs an internet connection.';
    case 'language-not-supported':
      return 'This browser cannot recognise ' + LANGS[state.lang].name + ' speech.';
    default:
      return 'Speech recognition error: ' + err.message;
  }
}

const NOTHING_HEARD = 'I didn\'t hear anything. Hold the button while you speak.';

// The live line has a fixed height; for long speech show the most recent words.
function showLive(el, text) {
  el.textContent = text.length > 120 ? '…' + text.slice(-120) : text;
}

// ---------- matching ----------

function norm(s) {
  return s.toLowerCase().normalize('NFC')
    .replace(/[’']/g, ' ')
    .replace(/[.,!?;:«»"“”„()\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripAccents(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// Similarity in [0, 1]. A "…" in the target accepts anything from there on.
function similarity(heard, target, ignoreAccents = false) {
  let h = norm(heard);
  let t = norm(target);
  if (target.includes('…')) {
    t = norm(target.split('…')[0]);
    const n = t.split(' ').filter(Boolean).length;
    h = h.split(' ').slice(0, n).join(' ');
  }
  if (ignoreAccents) { h = stripAccents(h); t = stripAccents(t); }
  if (!h && !t) return 1;
  return 1 - levenshtein(h, t) / Math.max(h.length, t.length);
}

function bestMatch(heardAlts, targets) {
  let best = { score: 0, loose: 0, heard: heardAlts[0] || '', target: targets[0] };
  for (const h of heardAlts) {
    for (const t of targets) {
      const s = similarity(h, t);
      if (s > best.score) best = { score: s, heard: h, target: t, loose: similarity(h, t, true) };
    }
  }
  return best;
}

// Colour each target word by whether it was heard / written.
function diffHTML(target, heard) {
  const heardWords = new Set(norm(heard).split(' '));
  return target.split(/\s+/).map(word => {
    const n = norm(word).replace(/…/g, '').trim();
    if (!n) return esc(word);
    const ok = n.split(' ').every(p => heardWords.has(p));
    return `<span class="${ok ? 'ok' : 'miss'}">${esc(word)}</span>`;
  }).join(' ');
}

function verdict(m) {
  if (m.score >= 0.9) return ['great', 'Excellent! 🎉'];
  if (m.loose >= 0.95) return ['good', 'Almost! Check the accents (é, è, ä, ö, ü, ß …).'];
  if (m.score >= 0.75) return ['good', 'Good, almost there!'];
  if (m.score >= 0.5) return ['meh', 'Getting there, try again.'];
  return ['bad', 'Not quite. Listen and try again.'];
}

// ---------- top bar ----------

function renderLangTabs() {
  const nav = $('#langTabs');
  nav.innerHTML = '';
  for (const [key, L] of Object.entries(LANGS)) {
    const b = document.createElement('button');
    b.textContent = `${L.flag} ${L.name}`;
    b.setAttribute('aria-selected', key === state.lang);
    b.onclick = () => {
      stopSpeaking();
      state.lang = key;
      state.category = 0;
      state.dialogue = 0;
      save('lang', key);
      render();
    };
    nav.appendChild(b);
  }
}

function renderVoices() {
  const sel = $('#voiceSelect');
  const voices = voicesFor(state.lang);
  const current = pickVoice();
  sel.innerHTML = '';
  sel.disabled = !voices.length;
  if (!voices.length) sel.innerHTML = '<option>No voice found</option>';
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `${v.name} (${v.lang})`;
    o.selected = current && v.name === current.name;
    sel.appendChild(o);
  }
  renderWarnings(voices);
}

function renderWarnings(voices) {
  const L = LANGS[state.lang];
  const warnings = [];
  if (!synth) {
    warnings.push('Your browser cannot speak text. Try Edge or Chrome.');
  } else if (!voices.length) {
    warnings.push(`No ${L.name} voice is installed. Edge has free online voices for all three languages; ` +
      'on Windows you can also add one under Settings → Time & language → Speech → Add voices.');
  }
  if (!Recognition && state.input === 'speech') {
    warnings.push('This browser has no speech recognition, so 🎤 is disabled. ' +
      'Use Edge or Chrome, or switch to ⌨️ Writing.');
  } else if (/Electron|Claude\//.test(navigator.userAgent) && state.input === 'speech') {
    // Embedded browsers expose the API but have no recognition service behind it.
    warnings.push('Speech recognition does not work in this built-in browser. ' +
      'Open the app in Edge (./serve.sh or serve.cmd does that) for 🎤.');
  }
  $('#warnings').innerHTML = warnings.map(w => `<p class="warn">${esc(w)}</p>`).join('');
}

function renderMode() {
  for (const b of document.querySelectorAll('#modeTabs button')) {
    b.setAttribute('aria-selected', b.dataset.mode === state.mode);
  }
  $('#phrasesView').hidden = state.mode !== 'phrases';
  $('#dialoguesView').hidden = state.mode !== 'dialogues';
  $('#conversationView').hidden = state.mode !== 'conversation';
}

function renderInput() {
  for (const b of document.querySelectorAll('.seg button')) {
    b.setAttribute('aria-pressed', b.dataset.input === state.input);
  }
  document.body.classList.toggle('input-speech', state.input === 'speech');
  document.body.classList.toggle('input-writing', state.input === 'writing');
  renderWarnings(voicesFor(state.lang));
}

// ---------- phrases ----------

function renderPhrases() {
  const L = LANGS[state.lang];
  $('#categorySelect').innerHTML = L.categories
    .map((c, i) => `<option value="${i}">${esc(c.title)}</option>`).join('');
  $('#categorySelect').value = state.category;

  const list = $('#phraseList');
  list.innerHTML = '';
  for (const p of L.categories[state.category].phrases) {
    const key = state.lang + '|' + p.t;
    const li = document.createElement('li');
    li.className = 'card';
    li.innerHTML = `
      <div class="phrase"><span class="text">${wordsHTML(p.t)}</span>${(scores[key] || 0) >= 0.9 ? ' <span class="badge" title="You said this well before">✓</span>' : ''}</div>
      <div class="en">${esc(p.en)}</div>
      ${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}
      <div class="row">
        <button class="listen">🔊 Listen</button>
        <button class="slow">🐢 Slow</button>
        <button class="say primary mic speak-only" ${Recognition ? '' : 'disabled'}>🎤 Hold to speak</button>
      </div>
      <form class="row write-form write-only">
        <input placeholder="Write the sentence" autocomplete="off" spellcheck="false" aria-label="Write the sentence">
        <button class="primary">Check</button>
      </form>
      <div class="result" aria-live="polite"></div>`;
    const textEl = li.querySelector('.text');
    const out = li.querySelector('.result');
    li.querySelector('.listen').onclick = () => speak(p.t, { el: textEl });
    li.querySelector('.slow').onclick = () => speak(p.t, { slow: true, el: textEl });
    holdToTalk(li.querySelector('.say'), {
      onInterim: t => { out.innerHTML = `<span class="live">${esc(t)}</span>`; },
      onResult: heard => {
        if (!heard.length) { out.innerHTML = `<span class="meh">${NOTHING_HEARD}</span>`; return; }
        const m = bestMatch(heard, [p.t]);
        scores[key] = Math.max(scores[key] || 0, m.score);
        save('scores', scores);
        showPhraseResult(p, li, m, 'I heard');
      },
      onError: err => { out.innerHTML = `<span class="bad">${esc(micError(err))}</span>`; },
    });
    li.querySelector('.write-form').onsubmit = e => {
      e.preventDefault();
      const v = e.target.querySelector('input').value.trim();
      if (v) showPhraseResult(p, li, bestMatch([v], [p.t]), 'You wrote');
    };
    list.appendChild(li);
  }
}

function showPhraseResult(p, li, m, label) {
  const [cls, msg] = verdict(m);
  li.querySelector('.result').innerHTML = `
    <div class="${cls}">${msg} (${Math.round(m.score * 100)}%)</div>
    <div>${label}: <em>${esc(m.heard)}</em></div>
    <div class="diff">${diffHTML(p.t, m.heard)}</div>`;
}

// ---------- dialogues ----------

let lastPartnerEl = null;

function currentStep() { return LANGS[state.lang].dialogues[state.dialogue].steps[state.step]; }

function renderDialogues() {
  $('#dialogueSelect').innerHTML = LANGS[state.lang].dialogues
    .map((d, i) => `<option value="${i}">${esc(d.title)}</option>`).join('');
  $('#dialogueSelect').value = state.dialogue;
  resetDialogue();
}

function resetDialogue() {
  stopSpeaking();
  state.step = -1;
  $('#chat').innerHTML = '<p class="muted">Press Start. Your partner speaks first, then you answer by speaking or writing.</p>';
  $('#answerBar').hidden = true;
  $('#startDialogue').textContent = 'Start';
}

function addMsg(container, who, html, scroll = true) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.innerHTML = html;
  container.appendChild(d);
  if (scroll) d.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return d;
}

function partnerTurn() {
  const s = currentStep();
  if (!s) {
    addMsg($('#chat'), 'sys', '🎉 Dialogue complete! Restart or pick another one.');
    $('#answerBar').hidden = true;
    return;
  }
  const msg = addMsg($('#chat'), 'them', `<div class="say">${wordsHTML(s.say)}</div><div class="en">${esc(s.en)}</div>`);
  lastPartnerEl = msg.querySelector('.say');
  speak(s.say, { el: lastPartnerEl });
  if (state.input === 'writing') $('#typeInput').focus();
}

function submitAnswer(heardAlts) {
  const s = currentStep();
  if (!s) return;
  const m = bestMatch(heardAlts, s.answers);
  const passed = m.score >= 0.7 || m.loose >= 0.95;
  let fb;
  if (m.score >= 0.9) fb = '<span class="great">Perfect!</span>';
  else if (passed) fb = `<span class="good">Understood!</span> Exactly: <em>${esc(m.target)}</em>`;
  else fb = `<span class="bad">Hmm, not quite.</span> Try: <em>${esc(s.answers[0])}</em>`;
  addMsg($('#chat'), 'me', `<div>${esc(m.heard)}</div><div class="fb">${fb}</div>`);
  if (passed) {
    state.step++;
    setTimeout(partnerTurn, 700);
  }
}

$('#startDialogue').onclick = () => {
  $('#chat').innerHTML = '';
  state.step = 0;
  $('#startDialogue').textContent = 'Restart';
  $('#answerBar').hidden = false;
  partnerTurn();
};

holdToTalk($('#speakAnswer'), {
  onInterim: t => showLive($('#dlgLive'), t),
  onResult: heard => {
    $('#dlgLive').textContent = '';
    if (heard.length) submitAnswer(heard);
    else addMsg($('#chat'), 'sys', NOTHING_HEARD);
  },
  onError: err => {
    $('#dlgLive').textContent = '';
    addMsg($('#chat'), 'sys', esc(micError(err)));
  },
});

$('#typeForm').onsubmit = e => {
  e.preventDefault();
  const v = $('#typeInput').value.trim();
  $('#typeInput').value = '';
  if (v) submitAnswer([v]);
};

$('#repeatLine').onclick = () => {
  const s = currentStep();
  if (s) speak(s.say, { el: lastPartnerEl });
};

$('#hintBtn').onclick = () => {
  const s = currentStep();
  if (!s) return;
  const msg = addMsg($('#chat'), 'sys', `💡 <span class="hint">${wordsHTML(s.answers[0])}</span>`);
  speak(s.answers[0], { el: msg.querySelector('.hint') });
};

$('#skipBtn').onclick = () => {
  const s = currentStep();
  if (!s) return;
  addMsg($('#chat'), 'sys', `Skipped. A good answer: <em>${esc(s.answers[0])}</em>`);
  state.step++;
  partnerTurn();
};

$('#dialogueSelect').onchange = e => { state.dialogue = +e.target.value; resetDialogue(); };

// ---------- conversation (free chat with Claude via server.py) ----------

const STARTERS = { fr: 'Bonjour ! Comment ça va ?', de: 'Hallo! Wie geht es dir?', fi: 'Moi! Mitä kuuluu?' };

const convo = {
  available: false,
  busy: false,
  // Per language: the history sent to the API, and what is shown on screen.
  history: { fr: [], de: [], fi: [] },
  shown: { fr: [], de: [], fi: [] },
};

async function checkConvoAvailable() {
  try {
    const r = await fetch('/api/status');
    convo.available = r.ok && (await r.json()).chat;
  } catch { convo.available = false; }
  renderConvo();
}

function correctionsHTML(list) {
  if (!list) return '';
  if (!list.length) return '<div class="fb"><span class="great">✓ No mistakes</span></div>';
  return `<ul class="corrections">${list.map(c =>
    `<li><s>${esc(c.original)}</s> → <b>${esc(c.corrected)}</b><br><span class="muted">${esc(c.explanation)}</span></li>`
  ).join('')}</ul>`;
}

function updateConvoControls() {
  $('#convoHint').textContent = `Start by saying hello, e.g. “${STARTERS[state.lang]}”`;
  $('#convoSetup').innerHTML = convo.available ? '' :
    '<p class="warn">Conversation needs a Claude API key. Copy <code>.env.example</code> to <code>.env</code>, ' +
    'put your key in it, and restart the server. Phrases and dialogues work without it.</p>';
  for (const b of [$('#convoMic'), $('#convoInput'), $('#convoForm button')]) {
    b.disabled = !convo.available || convo.busy || (b === $('#convoMic') && !Recognition);
  }
}

// Appends one conversation item to the chat. Messages are only ever added
// (never re-rendered) while chatting, so the scroll position stays put.
function showConvoItem(item, scroll) {
  const box = $('#convo');
  if (item.who === 'me') {
    item.node = addMsg(box, 'me', `<div>${esc(item.text)}</div>${correctionsHTML(item.corrections)}`, scroll);
  } else if (item.who === 'them') {
    item.node = addMsg(box, 'them', `
      <div class="say">${wordsHTML(item.text)}</div>
      <div class="en">${esc(item.translation)}</div>
      <div class="tools"><button title="Say it again">🔊</button></div>`, scroll);
    item.el = item.node.querySelector('.say');
    item.node.querySelector('.tools button').onclick = () => speak(item.text, { el: item.el });
  } else {
    item.node = addMsg(box, 'sys', esc(item.text), scroll);
  }
}

// Full rebuild: only on load, language switch and "New conversation".
function renderConvo() {
  updateConvoControls();
  const box = $('#convo');
  box.innerHTML = '';
  for (const item of convo.shown[state.lang]) showConvoItem(item, false);
  if (convo.busy && convo.busyLang === state.lang) {
    convo.typing = addMsg(box, 'them', '<span class="typing muted"></span>', false);
  }
}

async function sendConvo(text, spoken) {
  if (convo.busy || !convo.available) return;
  const lang = state.lang;
  const history = convo.history[lang];
  const shown = convo.shown[lang];
  const mine = { who: 'me', text };
  history.push({ role: 'user', content: (spoken ? '🎤 ' : '') + text });
  shown.push(mine);
  showConvoItem(mine, true);
  convo.busy = true;
  convo.busyLang = lang;
  updateConvoControls();
  convo.typing = addMsg($('#convo'), 'them', '<span class="typing muted"></span>');

  let data;
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang, messages: history }),
    });
    data = await r.json().catch(() => ({ error: 'The server sent an unreadable reply.' }));
    if (!r.ok || data.error) throw new Error(data.error || 'Request failed.');
  } catch (err) {
    history.pop();   // drop the unanswered message so the next try is clean
    data = null;
    shown.push({ who: 'sys', text: (err.message || 'Could not reach the server.') + ' Your message was not sent; try again.' });
  }

  convo.busy = false;
  if (convo.typing) convo.typing.remove();
  convo.typing = null;
  updateConvoControls();
  const visible = state.lang === lang;   // the user may have switched language meanwhile

  if (!data) {
    if (visible) showConvoItem(shown[shown.length - 1], true);
    return;
  }

  history.push({ role: 'assistant', content: data.raw });
  mine.corrections = data.corrections;
  const reply = { who: 'them', text: data.reply, translation: data.translation };
  shown.push(reply);
  if (!visible) return;
  mine.node.insertAdjacentHTML('beforeend', correctionsHTML(mine.corrections));
  showConvoItem(reply, true);
  speak(reply.text, { el: reply.el });
  if (state.input === 'writing') $('#convoInput').focus();
}

holdToTalk($('#convoMic'), {
  onInterim: t => showLive($('#convoLive'), t),
  onResult: heard => {
    $('#convoLive').textContent = '';
    if (heard.length) sendConvo(heard[0], true);
    else $('#convoLive').textContent = NOTHING_HEARD;
  },
  onError: err => { $('#convoLive').textContent = micError(err); },
});

$('#convoForm').onsubmit = e => {
  e.preventDefault();
  const v = $('#convoInput').value.trim();
  $('#convoInput').value = '';
  if (v) sendConvo(v, false);
};

$('#newConvo').onclick = () => {
  if (convo.busy) return;
  stopSpeaking();
  convo.history[state.lang] = [];
  convo.shown[state.lang] = [];
  renderConvo();
};

// ---------- settings & wiring ----------

$('#categorySelect').onchange = e => { state.category = +e.target.value; renderPhrases(); };
$('#voiceSelect').onchange = e => save('voice.' + state.lang, e.target.value);

$('#rate').value = load('rate', 0.9);
$('#rateVal').textContent = $('#rate').value + '×';
$('#rate').oninput = e => {
  $('#rateVal').textContent = e.target.value + '×';
  save('rate', parseFloat(e.target.value));
};

$('#showEn').checked = load('showEn', true);
document.body.classList.toggle('hide-en', !$('#showEn').checked);
$('#showEn').onchange = e => {
  document.body.classList.toggle('hide-en', !e.target.checked);
  save('showEn', e.target.checked);
};

for (const b of document.querySelectorAll('#modeTabs button')) {
  b.onclick = () => { state.mode = b.dataset.mode; save('mode', state.mode); renderMode(); };
}
for (const b of document.querySelectorAll('.seg button')) {
  b.onclick = () => { state.input = b.dataset.input; save('input', state.input); renderInput(); };
}

$('#speakAnswer').disabled = !Recognition;

function render() {
  renderLangTabs();
  renderVoices();
  renderMode();
  renderInput();
  renderPhrases();
  renderDialogues();
  renderConvo();
}

if (synth) synth.onvoiceschanged = renderVoices;
render();
checkConvoAvailable();
