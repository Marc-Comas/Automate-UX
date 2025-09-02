/*
 * Runner service for asynchronous AI editing jobs.
 *
 * Endpoints (protected by the x-runner-secret header):
 *   POST /jobs-create  – enqueue a new job
 *   GET  /jobs-status  – poll status of a job by id
 *
 * Jobs live in Redis lists/keys. A background worker pops from the queue,
 * calls OpenAI Responses API with strict JSON output, validates it and writes
 * the result back. All failures are recorded and surfaced — no "cambios fantasma".
 */

const express = require('express');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const PORT = Number(process.env.PORT || 8080);
const {
  REDIS_URL = '',
  RUNNER_SHARED_SECRET,
  OPENAI_API_KEY,
  OPENAI_MODEL_PRIMARY,
  OPENAI_MODEL_FALLBACK,
  OPENAI_MODEL_FALLBACK2,
  MODEL_TIMEOUT_MS = '26000',
  WORKER_ENABLED = 'true',
} = process.env;

// --- Infra: Redis with resilient error handling ---
const redis = new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: null });
redis.on('error', (err) => console.error('[redis] error:', err && err.message));
redis.on('connect', () => console.log('[redis] connected'));
redis.on('reconnecting', () => console.log('[redis] reconnecting...'));

// --- HTTP server ---
const app = express();
app.use(express.json({ limit: '2mb' }));

// CORS mínimo para funciones Netlify
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-runner-secret');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => {
  return res.json({ ok: true, uptime: process.uptime(), port: PORT });
});

// --- Knowledge loading ---
function loadKnowledge() {
  const dir = path.join(__dirname, 'knowledge');
  const knowledge = {};
  for (const name of ['brand', 'ui', 'ux', 'copy']) {
    try {
      const raw = fs.readFileSync(path.join(dir, `${name}.json`), 'utf8');
      knowledge[name] = JSON.parse(raw);
    } catch (err) {
      console.warn(`[knowledge] ${name}.json not found or invalid: ${err.message}`);
      knowledge[name] = {};
    }
  }
  return knowledge;
}
const KNOWLEDGE = loadKnowledge();

// --- Utils ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const generateId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function buildSystemPrompt(preset, brand) {
  const base = [];
  base.push('You edit or generate small static websites: index.html, styles/style.css, scripts/app.js.');
  base.push('Return ONLY JSON with shape {"files": {"index.html": string, "styles/style.css": string, "scripts/app.js": string}}. No markdown, no explanations.');
  base.push('For security, do not use external <script src> or CSS @import; keep everything inline/local. Maintain responsiveness and accessibility.');

  switch (preset) {
    case 'code':
      base.push('CODE mode: change JS (scripts/app.js) and minimal HTML hooks only. Do NOT change CSS.');
      break;
    case 'ui':
      base.push('UI mode: change CSS (styles/style.css) and class names in HTML when needed. Do NOT change JS.');
      break;
    case 'ux':
      base.push('UX mode: reorganize sections in index.html per prompt. Keep JS/CSS unless class names must update.');
      break;
    case 'copy':
      base.push('COPY mode: change textual content in index.html only. Keep tag structure, no CSS/JS edits.');
      break;
    default:
      base.push('If no preset is given, you may edit HTML/CSS/JS as needed while keeping coherence and minimal diff.');
  }

  if (brand && typeof brand === 'object' && Object.keys(brand).length) {
    base.push('Brand palette and tone to use:');
    base.push(JSON.stringify(brand));
  } else if (KNOWLEDGE.brand && KNOWLEDGE.brand.default) {
    base.push('Default brand when none provided:');
    base.push(JSON.stringify(KNOWLEDGE.brand.default));
  }

  if (KNOWLEDGE.ui?.components) base.push('UI components guidance: ' + JSON.stringify(KNOWLEDGE.ui.components));
  if (KNOWLEDGE.ux?.rules) base.push('UX structural rules: ' + JSON.stringify(KNOWLEDGE.ux.rules));
  if (KNOWLEDGE.copy) base.push('Copywriting guidance: ' + JSON.stringify(KNOWLEDGE.copy));

  return base.join('\n');
}

function buildUserContent(prompt, files, brand) {
  const payload = {
    prompt,
    files: {
      'index.html': files['index.html'] || '',
      'styles/style.css': files['styles/style.css'] || '',
      'scripts/app.js': files['scripts/app.js'] || '',
    },
  };
  if (brand) payload.brand = brand;
  return JSON.stringify(payload);
}

function validateAiOutput(obj) {
  if (!obj || typeof obj !== 'object' || !obj.files) throw new Error('No files property returned');
  const files = obj.files;
  for (const key of ['index.html', 'styles/style.css', 'scripts/app.js']) {
    if (typeof files[key] !== 'string') throw new Error(`File ${key} missing or not a string`);
  }
  // sanitize
  files['index.html'] = files['index.html']
    .replace(/<script[^>]*\s+src=['"][^'"]+['"][^>]*>\s*<\/script>/gi, '')
    .replace(/<link[^>]+rel=['"]stylesheet['"][^>]+href=['"]http[^'"]+['"][^>]*>/gi, '');
  return files;
}

async function callOpenAI(model, systemPrompt, userContent) {
  const url = 'https://api.openai.com/v1/responses';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` };
  // Usamos Responses API con instrucciones + input y JSON estricto
  const body = {
    model,
    instructions: systemPrompt,
    input: userContent,
    response_format: { type: 'json_object' }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(MODEL_TIMEOUT_MS));
  try {
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    clearTimeout(timeout);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const message = data?.error?.message || `OpenAI HTTP ${resp.status}`;
      return { ok: false, error: message };
    }
    // Normaliza distintas formas de salida de Responses API
    let text = '';
    if (typeof data?.output_text === 'string') text = data.output_text;
    else if (Array.isArray(data?.output)) {
      // concatenar textos
      text = data.output.map(part => {
        if (typeof part === 'string') return part;
        if (Array.isArray(part?.content)) return part.content.map(c => c?.text || '').join('');
        return part?.content?.[0]?.text || '';
      }).join('');
    } else if (typeof data?.response === 'string') {
      text = data.response;
    } else if (typeof data?.response?.content === 'string') {
      text = data.response.content;
    }

    let obj;
    try { obj = JSON.parse(text); }
    catch { return { ok: false, error: 'AI returned invalid JSON' }; }

    try { return { ok: true, files: validateAiOutput(obj) }; }
    catch (e) { return { ok: false, error: e.message }; }
  } catch (err) {
    const message = err.name === 'AbortError' ? 'timeout' : err.message;
    return { ok: false, error: message };
  }
}

async function runJob(job) {
  job.status = 'running';
  job.updatedAt = Date.now();
  await redis.set('jobs:data:' + job.id, JSON.stringify(job));

  const candidates = [OPENAI_MODEL_PRIMARY, OPENAI_MODEL_FALLBACK, OPENAI_MODEL_FALLBACK2].filter(Boolean);
  const systemPrompt = buildSystemPrompt(job.preset, job.brand);
  const userContent = buildUserContent(job.prompt, job.files, job.brand);

  for (const model of candidates) {
    const res = await callOpenAI(model, systemPrompt, userContent);
    if (res.ok) {
      job.status = 'done';
      job.result = { files: res.files };
      job.error = null;
      job.updatedAt = Date.now();
      await redis.set('jobs:data:' + job.id, JSON.stringify(job));
      return;
    }
    job.logs.push(`Model ${model} failed: ${res.error}`);
    job.updatedAt = Date.now();
    await redis.set('jobs:data:' + job.id, JSON.stringify(job));
  }
  job.status = 'error';
  job.error = job.logs[job.logs.length - 1] || 'AI failed';
  job.updatedAt = Date.now();
  await redis.set('jobs:data:' + job.id, JSON.stringify(job));
}

async function workerLoop() {
  if (String(WORKER_ENABLED) === 'false') return;
  while (true) {
    try {
      const jobId = await redis.lpop('jobs:queue');
      if (!jobId) { await sleep(2000); continue; }
      const jobStr = await redis.get('jobs:data:' + jobId);
      if (!jobStr) continue;
      const job = JSON.parse(jobStr);
      await runJob(job);
    } catch (err) {
      console.error('Worker error:', err?.message || err);
      await sleep(2000);
    }
  }
}

function authenticate(req, res, next) {
  const secret = req.header('x-runner-secret');
  if (!secret || secret !== RUNNER_SHARED_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.post('/jobs-create', authenticate, async (req, res) => {
  const { preset = '', prompt = '', files = {}, brand = null } = req.body || {};
  if (!files || typeof files !== 'object') return res.status(400).json({ error: 'files must be provided' });
  const id = generateId();
  const job = { id, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), preset, prompt, files, brand, logs: [], result: null, error: null };
  await redis.set('jobs:data:' + id, JSON.stringify(job));
  await redis.rpush('jobs:queue', id);
  return res.status(202).json({ jobId: id });
});

app.get('/jobs-status', authenticate, async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const jobStr = await redis.get('jobs:data:' + id);
  if (!jobStr) return res.status(404).json({ error: 'Job not found' });
  const job = JSON.parse(jobStr);
  const logs = Array.isArray(job.logs) ? job.logs.slice(Math.max(0, job.logs.length - 20)) : [];
  return res.json({ status: job.status, result: job.result, error: job.error, logs });
});

app.listen(PORT, () => console.log(`[runner] listening on ${PORT}`));
workerLoop().catch((err) => console.error('Worker failed to start:', err?.message || err));
