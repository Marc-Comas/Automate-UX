// runner/index.js (ESM)
// Purpose: call OpenAI Responses API with a constrained "patch" schema and
// apply only the requested, scoped changes to the user's HTML/CSS using domPatcher.

import 'dotenv/config';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyOps } from './domPatcher.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

const DEFAULT_MODEL_CHAIN = (process.env.MODEL_CHAIN || 'gpt-5,gpt-4o,gpt-4o-mini').split(',');

// Some sections we NEVER let the model touch
const PROTECTED_SELECTORS = [
  'head',
  'link[rel="stylesheet"]',
  'script[src]',
  'meta',
  'title',
  'nav',
  '[data-protect]'
];

// Map of common prompt keywords -> default target section anchors
const PROMPT_TO_SECTION = [
  { re: /(testimoni|reseñ|opini)/i, selector: '[data-section="testimonials"]' },
  { re: /(galeri|carrusel|slider)/i, selector: '[data-section="gallery"]' },
  { re: /(inici|hero|cabecera|header|landing)/i, selector: '[data-section="hero"]' },
  { re: /(contact)/i, selector: '[data-section="contact"]' },
  { re: /(precios|planes|pricing)/i, selector: '[data-section="pricing"]' }
];

// OpenAI Responses API endpoint
const OPENAI_URL = 'https://api.openai.com/v1/responses';

// Patch schema the model must return
const OPS_SCHEMA = {
  name: 'dom_patch_schema',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ops'],
    properties: {
      notes: { type: 'string' },
      targetRoot: { type: 'string' }, // optional override of the root selector
      ops: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['op', 'selector'],
          additionalProperties: false,
          properties: {
            op: { enum: ['replace_text', 'append_html', 'replace_html', 'set_attr', 'add_class', 'remove_class', 'upsert_style'] },
            selector: { type: 'string' },
            // replace_text
            text: { type: 'string' },
            // append/replace_html
            html: { type: 'string' },
            // set_attr
            attr: { type: 'string' },
            value: { type: 'string' },
            // upsert_style (CSS)
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
  // Fallback to a known anchor present in the HTML
  const anchors = ['hero','gallery','testimonials','contact','pricing'];
  for (const a of anchors) {
    if (html.includes(`data-section="${a}"`)) return `[data-section="${a}"]`;
  }
  return 'main, body'; // safest fallback
}

// Build the system instruction
function systemPrompt(projectName) {
  return `You are a precise front-end refactor assistant.
- You MUST return strictly valid JSON following the provided JSON schema.
- Only propose minimal, surgical changes.
- Never modify navigation, external scripts, <head>, or any selector marked with [data-protect].
- Prefer selectors as specific as possible to avoid touching siblings.
- Use ops:
  - replace_text: change only the textContent inside matched nodes.
  - append_html: append safe HTML at the end of the matched node.
  - replace_html: replace innerHTML of the matched node (use sparingly).
  - set_attr: set or update an attribute on matched nodes.
  - add_class / remove_class
  - upsert_style: add/update CSS rules (provide cssSelector + styleRules).
Return JSON only. No prose.`;
}

// Construct the user input for Responses API
function buildInput({ prompt, html, css, target }) {
  const root = target || guessTargetSection(prompt, html);
  const guidance = `TARGET ROOT: ${root}
Context:
- The current HTML is chunked; you will operate only within "${root}".
- Avoid broad selectors like "body" or "div". Prefer [data-section="..."] descendants.
- Do not change colors, fonts, or layout globally unless explicitly asked.
Task: ${prompt}`;

  // The Responses API accepts "input" as an array of content blocks
  return [
    { role: 'system', content: systemPrompt('Project') },
    { role: 'user', content: [
      { type: 'input_text', text: guidance },
      { type: 'input_text', text: `HTML:\n${html}` },
      { type: 'input_text', text: `CSS:\n${css || ''}` }
    ]}
  ];
}

// Call the model chain with schema output
async function generateOps(payload, timeoutMs) {
  const { prompt, files } = payload;
  const html = files['index.html'] ?? '';
  const css = files['styles/style.css'] ?? '';
  const target = payload.target || null;

  const input = buildInput({ prompt, html, css, target });

  const modelChain = DEFAULT_MODEL_CHAIN;
  let lastErr = null;

  for (const model of modelChain) {
    try {
      const body = {
        model,
        input,
        text: { format: { type: 'json_schema', json_schema: OPS_SCHEMA } },
        // Constrain temperature for determinism; some models only support 1 - then omit:
        temperature: model.includes('4o-mini') ? 1 : (payload.temperature ?? 0.4),
        reasoning: model.startsWith('gpt-5') ? { effort: 'medium' } : undefined
      };

      if (model.includes('4o-mini') || model === 'gpt-4o-mini' || model === 'o4-mini') {
        delete body.temperature;
      }

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
        const txt = await res.text();
        throw new Error(`OpenAI ${model} HTTP ${res.status}: ${txt}`);
      }
      const data = await res.json();

      let text;
      if (typeof data.output_text === 'string') {
        text = data.output_text;
      } else if (Array.isArray(data.output) && data.output[0] && data.output[0].content && data.output[0].content[0] && data.output[0].content[0].text) {
        text = data.output[0].content[0].text;
      } else {
        text = JSON.stringify(data);
      }

      let ops;
      try {
        ops = JSON.parse(text);
      } catch (e) {
        throw new Error(`Model ${model} returned non-JSON text: ${text.slice(0, 400)}`);
      }

      return { ops, modelUsed: model, targetRoot: ops.targetRoot || (target || guessTargetSection(prompt, html)) };
    } catch (err) {
      lastErr = err;
      console.warn(`Model ${model} failed: ${err.message}`);
      continue;
    }
  }

  throw lastErr ?? new Error('All models failed');
}

// Main exported handler used by your job runner
export async function runJob(payload) {
  // payload: { prompt, files: { 'index.html': '...', 'styles/style.css': '...' }, target? }
  const TIMEOUT = parseInt(process.env.MODEL_TIMEOUT_MS || process.env.MODEL_TIMEOUT || '90000', 10);

  const { ops, modelUsed, targetRoot } = await generateOps(payload, TIMEOUT);

  // Apply dom patch guarded by protected selectors
  const startingHTML = payload.files['index.html'] ?? '';
  const startingCSS = payload.files['styles/style.css'] ?? '';

  const { html: newHTML, css: newCSS, changed } = applyOps({
    html: startingHTML,
    css: startingCSS,
    ops: ops.ops || [],
    root: targetRoot,
    protectedSelectors: PROTECTED_SELECTORS
  });

  return {
    ok: true,
    model: modelUsed,
    changed,
    files: {
      'index.html': newHTML,
      'styles/style.css': newCSS
    }
  };
}

// If you want to test locally:
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const sampleHtml = await fs.readFile(path.resolve('sample-index.html'), 'utf8').catch(() => '<main data-section="testimonials"><h2>Testimonis</h2><div class="items"><p>Anna</p></div></main>');
    const sampleCss = '/* styles */';
    const out = await runJob({
      prompt: 'Convierte las reseñas de "Testimonis" en un carrusel simple con botones anterior/siguiente; no toques otras secciones.',
      files: { 'index.html': sampleHtml, 'styles/style.css': sampleCss }
    });
    console.log(out);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
