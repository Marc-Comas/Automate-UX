// runner/index.js (ESM)
// Guarded Responses API runner: asks the model for a *scoped* JSON patch,
// then applies it only inside the requested section, protecting the rest.

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyOps } from './domPatcher.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');

// Comma-separated model chain, in order of preference
const DEFAULT_MODEL_CHAIN = (process.env.MODEL_CHAIN || 'gpt-5,gpt-4o,gpt-4o-mini').split(',');

// Selectors we *never* let the model touch.
const PROTECTED_SELECTORS = [
  'head',
  'link[rel="stylesheet"]',
  'script[src]',
  'meta',
  'title',
  'nav',
  '[data-protect]'
];

// Heuristics to map prompts to a default target
const PROMPT_TO_SECTION = [
  { re: /(testimoni|reseñ|opini|testimonial)/i, selector: '[data-section="testimonials"]' },
  { re: /(galeri|carrusel|slider|gallery|carousel)/i, selector: '[data-section="gallery"]' },
  { re: /(inici|hero|cabecera|header|landing)/i, selector: '[data-section="hero"]' },
  { re: /(contact)/i, selector: '[data-section="contact"]' },
  { re: /(precios|planes|pricing)/i, selector: '[data-section="pricing"]' },
];

const OPENAI_URL = 'https://api.openai.com/v1/responses';

// JSON schema the model must respect
const OPS_SCHEMA = {
  name: 'dom_patch_schema',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ops'],
    properties: {
      notes: { type: 'string' },
      targetRoot: { type: 'string' },
      ops: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['op', 'selector'],
          additionalProperties: false,
          properties: {
            op: { enum: ['replace_text','append_html','replace_html','set_attr','add_class','remove_class','upsert_style'] },
            selector: { type: 'string' },
            text: { type: 'string' },
            html: { type: 'string' },
            attr: { type: 'string' },
            value: { type: 'string' },
            cssSelector: { type: 'string' },
            styleRules: { type: 'string' }
          }
        }
      }
    }
  },
  strict: true
};

function guessTargetSection(prompt, html) {
  for (const m of PROMPT_TO_SECTION) {
    if (m.re.test(prompt)) return m.selector;
  }
  const anchors = ['hero','gallery','testimonials','contact','pricing'];
  for (const a of anchors) {
    if ((html || '').includes(`data-section="${a}"`)) return `[data-section="${a}"]`;
  }
  return 'main, body';
}

function systemInstruction() {
  return `You are a precise front‑end refactor assistant.
- Return *only* strict JSON per the provided JSON schema.
- Make minimal, surgical changes.
- Never modify: <head>, <nav>, external scripts, or anything with [data-protect].
- Avoid broad selectors. Prefer descendants of the provided root.
- ops:
  • replace_text      – set textContent only
  • append_html       – append safe HTML
  • replace_html      – replace innerHTML (use sparingly)
  • set_attr          – set/update an attribute
  • add_class/remove_class
  • upsert_style      – add/update CSS rules (cssSelector + styleRules)
No prose, only JSON.`;
}

function buildInput({ prompt, html, css, target }) {
  const root = target || guessTargetSection(prompt, html);
  const guidance = `TARGET ROOT: ${root}
Context:
- Operate only within \`${root}\`.
- Do not touch global layout, colors, fonts unless explicitly asked.
Task: ${prompt}`;

  return [
    { role: 'system', content: systemInstruction() },
    { role: 'user', content: [
      { type: 'input_text', text: guidance },
      { type: 'input_text', text: `HTML:\n${html}` },
      { type: 'input_text', text: `CSS:\n${css || ''}` }
    ]}
  ];
}

async function callModelChain({ prompt, files, target, timeoutMs }) {
  const html = files['index.html'] ?? '';
  const css  = files['styles/style.css'] ?? '';
  const input = buildInput({ prompt, html, css, target });
  let lastErr;

  for (const model of DEFAULT_MODEL_CHAIN) {
    try {
      const body = {
        model,
        input,
        text: { format: { type: 'json_schema', json_schema: OPS_SCHEMA } },
        // Some models only accept default temperature (1), so only send for 5 / 4o
        ...(model.startsWith('gpt-5') || model.includes('4o') ? { temperature: 0.4 } : {}),
        ...(model.startsWith('gpt-5') ? { reasoning: { effort: 'medium' } } : {})
      };

      // Guard: if the model is the small 4o-mini, remove temperature
      if (model.includes('4o-mini')) delete body.temperature;

      const res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs || 120000)
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`HTTP ${res.status}: ${t}`);
      }
      const data = await res.json();

      const text =
        data.output_text ||
        (data.output && data.output[0] && data.output[0].content && data.output[0].content[0] && data.output[0].content[0].text) ||
        JSON.stringify(data);

      let parsed;
      try { parsed = JSON.parse(text); }
      catch (e) { throw new Error(`Model returned non‑JSON: ${text.slice(0, 300)}`); }

      return { ops: parsed, modelUsed: model, targetRoot: parsed.targetRoot || (target || guessTargetSection(prompt, html)) };
    } catch (err) {
      lastErr = err;
      console.warn(`Model ${model} failed: ${err.message}`);
    }
  }
  throw lastErr || new Error('All models failed');
}

export async function runJob(payload) {
  const TIMEOUT = parseInt(process.env.MODEL_TIMEOUT_MS || process.env.MODEL_TIMEOUT || '90000', 10);
  const { ops, modelUsed, targetRoot } = await callModelChain({ ...payload, timeoutMs: TIMEOUT });

  const startingHTML = payload.files['index.html'] ?? '';
  const startingCSS  = payload.files['styles/style.css'] ?? '';

  const patched = applyOps({
    html: startingHTML,
    css: startingCSS,
    ops: ops.ops || [],
    root: targetRoot,
    protectedSelectors: PROTECTED_SELECTORS
  });

  return {
    ok: true,
    model: modelUsed,
    changed: patched.changed,
    files: { 'index.html': patched.html, 'styles/style.css': patched.css }
  };
}

// Local quick test (optional)
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const sampleHtml = await fs.readFile(path.resolve('sample-index.html'), 'utf8').catch(() => '<main data-section="testimonials"><h2>Testimonis</h2><div class="items"><p>Anna</p></div></main>');
    const out = await runJob({
      prompt: 'Convierte testimonios en un carrusel con botones prev/next (sin tocar otras secciones).',
      files: { 'index.html': sampleHtml, 'styles/style.css': '' }
    });
    console.log(out);
  })().catch(e => (console.error(e), process.exit(1)));
}
