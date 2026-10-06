/* Gemini client: prompts, schema, validation and the API call, all in the browser.
   The key stays in this browser only (localStorage). */
(function () {

const LAYOUTS = ['cover', 'bullets', 'two', 'stats', 'quote', 'chart', 'closing'];

const STR = { type: 'STRING' };
const STRS = { type: 'ARRAY', items: STR };

// Gemini responseSchema (OpenAPI subset)
const DECK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: STR,
    subtitle: STR,
    slides: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          layout: { type: 'STRING', enum: LAYOUTS },
          title: STR,
          subtitle: STR,
          bullets: STRS,
          left: { type: 'OBJECT', properties: { heading: STR, bullets: STRS } },
          right: { type: 'OBJECT', properties: { heading: STR, bullets: STRS } },
          stats: { type: 'ARRAY', items: { type: 'OBJECT', properties: { value: STR, label: STR }, required: ['value', 'label'] } },
          quote: STR,
          author: STR,
          chart: { type: 'OBJECT', properties: { labels: STRS, values: { type: 'ARRAY', items: { type: 'NUMBER' } }, unit: STR } },
          notes: STR,
        },
        required: ['layout', 'title'],
      },
    },
  },
  required: ['title', 'slides'],
};

const TONES = {
  pro: 'formal and businesslike',
  story: 'narrative, built around a story arc',
  sales: 'persuasive, aimed at convincing the audience to act',
  edu: 'educational, clear for learners, with simple examples',
};
const DEPTHS = {
  brief: '2-3 short bullets per slide, each under 8 words',
  mid: '3-4 bullets per slide, each under 14 words',
  deep: '4-5 bullets per slide, each a full informative sentence under 22 words',
};

const RULES = (lang) => `
Layouts and the fields each one uses:
- cover: title, subtitle (first slide only)
- bullets: title, bullets
- two: title, left{heading,bullets}, right{heading,bullets} (comparisons, before/after, pros/cons)
- stats: title, stats (2-4 items, value is short like "۴۲٪" or "3.2M")
- quote: title, quote, author
- chart: title, chart{labels (3-6), values (numbers, same count), unit}
- closing: title, subtitle (last slide only: summary or call to action)
Rules:
- Write ALL text in ${lang === 'en' ? 'English' : 'Persian (Farsi), using Persian digits ۰-۹ in text; numbers inside chart.values stay numeric'}.
- One idea per slide. Vary layouts; use at least one of two/stats/chart when the topic allows.
- Only use statistics you are reasonably confident about; otherwise phrase as estimates ("حدود", "about") or avoid numbers.
- notes: 1-3 sentences of speaker notes for every slide.
- No markdown, no emoji.`;

function buildCreatePrompt({ topic, count, tone, lang, depth }) {
  return `Create a presentation outline with full slide content.
Topic: ${topic}
Exactly ${count} slides. Slide 1 layout = cover, slide ${count} layout = closing.
Tone: ${TONES[tone] || TONES.pro}.
Density: ${DEPTHS[depth] || DEPTHS.mid}.
${RULES(lang)}
Return JSON matching the schema.`;
}

function buildEditPrompt({ deck, instruction, lang }) {
  return `Here is a presentation as JSON:
${JSON.stringify(deck)}

Apply this change request from the user: "${instruction}"

Return the COMPLETE revised presentation as JSON in the same schema. Keep everything the user did not ask to change exactly as it is. Slide count may change only if the request asks for it (max 20).
${RULES(lang)}`;
}

const s = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v, n, max) => (Array.isArray(v) ? v.map((x) => s(x, max)).filter(Boolean).slice(0, n) : []);

function normalizeDeck(raw, fallbackTitle = '') {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.slides)) throw new Error('bad_shape');
  const slides = raw.slides.slice(0, 20).map((sl, i) => {
    let layout = LAYOUTS.includes(sl?.layout) ? sl.layout : 'bullets';
    const out = { layout, title: s(sl?.title, 140) || `${i + 1}`, notes: s(sl?.notes, 600) };
    if (sl?.subtitle) out.subtitle = s(sl.subtitle, 200);
    if (layout === 'bullets') out.bullets = arr(sl.bullets, 6, 220);
    if (layout === 'two') {
      out.left = { heading: s(sl.left?.heading, 60), bullets: arr(sl.left?.bullets, 5, 160) };
      out.right = { heading: s(sl.right?.heading, 60), bullets: arr(sl.right?.bullets, 5, 160) };
      if (!out.left.bullets.length && !out.right.bullets.length) { out.layout = 'bullets'; out.bullets = arr(sl.bullets, 6, 220); }
    }
    if (layout === 'stats') {
      out.stats = (Array.isArray(sl.stats) ? sl.stats : []).map((x) => ({ value: s(x?.value, 16), label: s(x?.label, 80) })).filter((x) => x.value).slice(0, 4);
      if (out.stats.length < 2) { out.layout = 'bullets'; out.bullets = arr(sl.bullets, 6, 220); }
    }
    if (layout === 'quote') { out.quote = s(sl.quote, 280); out.author = s(sl.author, 80); if (!out.quote) { out.layout = 'bullets'; out.bullets = arr(sl.bullets, 6, 220); } }
    if (layout === 'chart') {
      const labels = arr(sl.chart?.labels, 8, 30);
      const values = (Array.isArray(sl.chart?.values) ? sl.chart.values : []).map(Number).filter((n) => Number.isFinite(n)).slice(0, labels.length);
      if (labels.length >= 2 && values.length === labels.length) out.chart = { labels, values, unit: s(sl.chart?.unit, 20) };
      else { out.layout = 'bullets'; out.bullets = arr(sl.bullets, 6, 220); }
    }
    return out;
  });
  if (!slides.length) throw new Error('empty');
  slides[0].layout = 'cover';
  if (slides.length > 1) slides[slides.length - 1].layout = 'closing';
  return { title: s(raw.title, 140) || slides[0].title || fallbackTitle, subtitle: s(raw.subtitle, 200), slides };
}

  /* ---------- direct browser call to Gemini ---------- */
  const MODELS = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash'];
  const KEY = 'parde.gemini.key', MKEY = 'parde.gemini.model';
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
  };
  const getKey = () => store.get(KEY);
  const setKey = (v) => store.set(KEY, (v || '').trim());

  class GemError extends Error { constructor(msg, kind) { super(msg); this.kind = kind; } }

  async function callModel(model, key, prompt) {
    let r;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'You are an expert presentation writer and designer. You output only valid JSON that matches the given schema.' }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: DECK_SCHEMA, temperature: 0.7 },
        }),
        signal: AbortSignal.timeout ? AbortSignal.timeout(90000) : undefined,
      });
    } catch (e) {
      throw new GemError('اتصال به Gemini برقرار نشد. اینترنت را بررسی کن؛ از ایران باید با اینترنت بدون محدودیت وصل شوی.', 'net');
    }
    if (r.ok) return r.json();
    const t = await r.text().catch(() => '');
    console.warn('Gemini', model, r.status, t.slice(0, 400));
    if (r.status === 404) throw new GemError('model', 'model');
    if (r.status === 503 || r.status === 500 || r.status === 502 || r.status === 504) throw new GemError('busy', 'busy');
    if (/location is not supported|not available in your country|region/i.test(t)) throw new GemError('Gemini از منطقه‌ی فعلی تو در دسترس نیست. با اینترنت بدون محدودیت دوباره امتحان کن.', 'geo');
    if (r.status === 400 && /API key|API_KEY/i.test(t) || r.status === 401 || r.status === 403) throw new GemError('کلید Gemini نامعتبر است. کلید را دوباره از AI Studio کپی کن.', 'key');
    if (r.status === 429) throw new GemError('سقف استفاده‌ی رایگان کلیدت پر شده. چند دقیقه بعد دوباره امتحان کن.', 'quota');
    throw new GemError(`Gemini خطا داد (${r.status}). دوباره امتحان کن.`, 'other');
  }

  async function run(body) {
    const key = getKey();
    if (!key) throw new GemError('اول کلید Gemini را وارد کن.', 'nokey');
    const lang = body.lang === 'en' ? 'en' : 'fa';
    let prompt, fallbackTitle;
    if (body.instruction) {
      const deck = normalizeDeck(body.deck);
      prompt = buildEditPrompt({ deck, instruction: String(body.instruction).slice(0, 500), lang });
      fallbackTitle = deck.title;
    } else {
      const topic = String(body.topic || '').trim().slice(0, 200);
      const count = Math.min(15, Math.max(4, parseInt(body.count, 10) || 8));
      prompt = buildCreatePrompt({ topic, count, tone: body.tone, lang, depth: body.depth });
      fallbackTitle = topic;
    }
    const saved = store.get(MKEY);
    const order = saved ? [saved, ...MODELS.filter((m) => m !== saved)] : MODELS;
    // Busy (503) → wait and retry, then move to the next model. Missing model (404) → next model.
    let data = null, sawBusy = false;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    outer: for (const m of order) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { data = await callModel(m, key, prompt); store.set(MKEY, m); break outer; }
        catch (e) {
          if (e.kind === 'model') continue outer;
          if (e.kind !== 'busy') throw e;
          sawBusy = true;
          if (typeof body.onRetry === 'function') body.onRetry(m, attempt + 1);
          await wait(1500 * (attempt + 1));
        }
      }
    }
    if (!data) throw new GemError(sawBusy
      ? 'سرورهای Gemini الان شلوغ‌اند و چند بار تلاش جواب نداد. یکی دو دقیقه بعد دوباره امتحان کن.'
      : 'هیچ مدل Gemini در دسترس نبود.', sawBusy ? 'busy' : 'model');
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    try { return normalizeDeck(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')), fallbackTitle); }
    catch { throw new GemError('خروجی مدل ناقص بود. دوباره امتحان کن.', 'parse'); }
  }

  window.Gemini = { run, getKey, setKey, model: () => store.get(MKEY) || MODELS[0] };
})();
