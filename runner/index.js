/*
 * Runner service for asynchronous AI editing jobs.
 *
 * This Express server exposes two HTTP endpoints:
 *
 *   POST /jobs-create  – create a new job. Requires x-runner-secret header.
 *   GET  /jobs-status  – fetch the status of an existing job. Requires x-runner-secret header.
 *
 * Jobs are stored in Redis. A background worker processes each queued job by
 * invoking OpenAI’s Responses API with a strict JSON response format. The
 * worker chooses between multiple models (primary and fallbacks) and applies
 * project‑specific presets and brand guides to the prompts. All output is
 * validated and sanitised before being marked as complete.
 */

const express = require('express');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');

// Use the built‑in fetch available in Node >=18. This avoids issues with
// node-fetch being ESM‑only. AbortController is also globally available.

const PORT = Number(process.env.PORT || 8080);

const app = express();
app.use(express.json({ limit: '2mb' }));

// Simple CORS middleware to allow calls from Netlify functions or the UI
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,x-runner-secret');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Health endpoint for readiness probes and debugging
app.get('/health', (req, res) => {
  return res.json({ ok: true, uptime: process.uptime(), port: PORT });
});

// Configuration from environment variables with sane defaults
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

// Connect to Redis and log connection state. We avoid crashing the process
// when Redis is temporarily unavailable by listening for errors.
const redis = new Redis(REDIS_URL);
redis.on('error', (err) => {
  console.error('[redis] error:', err && err.message);
});
redis.on('connect', () => {
  console.log('[redis] connected');
});
redis.on('reconnecting', () => {
  console.log('[redis] reconnecting…');
});

// Load knowledge documents. These guide the AI on brand, UI, UX and copy.
// We support both `knowledge` at the project root and under `async-ia-pack/knowledge`.
function loadKnowledge() {
  const candidates = [
    path.join(__dirname, 'knowledge'),
    path.join(__dirname, 'async-ia-pack', 'knowledge'),
  ];
  const knowledge = {};
  for (const name of ['brand', 'ui', 'ux', 'copy']) {
    knowledge[name] = {};
    for (const dir of candidates) {
      try {
        const raw = fs.readFileSync(path.join(dir, `${name}.json`), 'utf8');
        knowledge[name] = JSON.parse(raw);
        break;
      } catch (err) {
        // Try next directory
      }
    }
  }
  return knowledge;
}
const KNOWLEDGE = loadKnowledge();

// Utility: sleep helper for the worker loop
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Generate a unique job id using timestamp and random bits
function generateId() {
  return (
    Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8)
  );
}

// Build a system prompt that instructs the model how to behave. The preset
// determines which part of the files may be modified. Brand and knowledge
// guides are included to ensure consistency.
function buildSystemPrompt(preset, brand) {
  const base = [];
  base.push(
    'You are an assistant that edits or generates small static websites consisting of three files: index.html, styles/style.css and scripts/app.js.'
  );
  base.push(
    'Return only a JSON object with a single property "files". The "files" property is an object with exactly three string properties: "index.html", "styles/style.css" and "scripts/app.js".'
  );
  base.push(
    'Do not return any additional properties. Do not wrap the JSON in markdown. Do not include explanations. Always respond with strict JSON.'
  );
  base.push(
    'The HTML must not include <script> tags with external src attributes, and the CSS must not include @import rules.'
  );
  base.push(
    'Preserve the existing structure, responsiveness and accessibility wherever possible.'
  );

  switch (preset) {
    case 'code':
      base.push(
        'You are working in Code mode. Modify only the JavaScript in scripts/app.js or small hooks in index.html if strictly necessary. Do not modify CSS.'
      );
      break;
    case 'ui':
      base.push(
        'You are working in UI mode. Modify only the CSS in styles/style.css and adjust class names in index.html as needed. Do not modify JavaScript.'
      );
      break;
    case 'ux':
      base.push(
        'You are working in UX mode. Rearrange or replace sections in index.html according to the prompt. Keep scripts/app.js and styles/style.css unchanged except for structural class names that need updating.'
      );
      break;
    case 'copy':
      base.push(
        'You are working in Copy mode. Modify only the textual content within index.html. Keep tag structure intact and do not modify styles or JavaScript.'
      );
      break;
    default:
      base.push(
        'If no preset is specified, you may modify HTML, CSS and JS as needed to satisfy the prompt. Maintain coherence and avoid unnecessary changes.'
      );
      break;
  }

  // Merge brand guidelines. Use provided brand or default brand from knowledge
  if (brand && typeof brand === 'object' && Object.keys(brand).length > 0) {
    base.push(
      'Use the following brand palette and tone. Colours are given as hexadecimal strings.'
    );
    base.push(JSON.stringify(brand));
  } else if (KNOWLEDGE.brand && KNOWLEDGE.brand.default) {
    base.push('When no brand is provided, fall back to this default brand palette and tone:');
    base.push(JSON.stringify(KNOWLEDGE.brand.default));
  }

  // UI guidelines
  if (KNOWLEDGE.ui && KNOWLEDGE.ui.components) {
    base.push('Follow these UI component guidelines for consistency:' + JSON.stringify(KNOWLEDGE.ui.components));
  }
  // UX guidelines
  if (KNOWLEDGE.ux && KNOWLEDGE.ux.rules) {
    base.push('Follow these UX structural rules if you need to rearrange sections:' + JSON.stringify(KNOWLEDGE.ux.rules));
  }
  // Copy guidelines
  if (KNOWLEDGE.copy && KNOWLEDGE.copy.voice) {
    base.push('Follow these copywriting guidelines:' + JSON.stringify(KNOWLEDGE.copy));
  }

  return base.join('\n');
}

// Build the user content (prompt + files + brand). We always send all three files
// as strings to give the model complete context.
function buildUserContent(prompt, files, brand) {
  const payload = {
    prompt: prompt || '',
    files: {
      'index.html': files['index.html'] || '',
      'styles/style.css': files['styles/style.css'] || '',
      'scripts/app.js': files['scripts/app.js'] || '',
    },
  };
  if (brand) payload.brand = brand;
  return JSON.stringify(payload);
}

// Validate the AI output. We require a "files" object with exactly three
// string values. Sanitise HTML by removing external scripts and CSS links.
function validateAiOutput(obj) {
  if (!obj || typeof obj !== 'object' || !obj.files) {
    throw new Error('No files property returned');
  }
  const files = obj.files;
  const required = ['index.html', 'styles/style.css', 'scripts/app.js'];
  for (const key of required) {
    if (typeof files[key] !== 'string') {
      throw new Error(`File ${key} missing or not a string`);
    }
  }
  // Sanitise HTML: remove external scripts and remote CSS links
  files['index.html'] = files['index.html'].replace(/<script[^>]*\s+src=['"][^'"]+['"][^>]*>\s*<\/script>/gi, '');
  files['index.html'] = files['index.html'].replace(/<link[^>]+rel=['"]stylesheet['"][^>]+href=['"]http[^'"]+['"][^>]*>/gi, '');
  return files;
}

// Call OpenAI’s Responses API. Returns { ok: true, files } on success or
// { ok: false, error } on failure. We implement our own timeout using
// AbortController.
async function callOpenAI(model, systemPrompt, userContent) {
  const url = 'https://api.openai.com/v1/responses';
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  };
  const body = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(MODEL_TIMEOUT_MS));
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const message = data?.error?.message || `OpenAI HTTP ${resp.status}`;
      return { ok: false, error: message };
    }
    // Responses API returns `response` with role/content; some versions use
    // `response` directly or `output_text`. We try several paths.
    const content =
      data?.response?.content || data?.response || data?.output_text || '';
    let obj;
    try {
      obj = JSON.parse(content);
    } catch (err) {
      return { ok: false, error: 'AI returned invalid JSON' };
    }
    try {
      const files = validateAiOutput(obj);
      return { ok: true, files };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  } catch (err) {
    const message = err.name === 'AbortError' ? 'timeout' : err.message;
    return { ok: false, error: message };
  }
}

// Process a single job by trying the primary model and fallbacks. Updates the
// job record in Redis on each attempt. On success, stores the files in
// job.result. On failure, logs the errors and sets status to 'error'.
async function runJob(job) {
  job.status = 'running';
  job.updatedAt = Date.now();
  await redis.set('jobs:data:' + job.id, JSON.stringify(job));

  const modelCandidates = [
    OPENAI_MODEL_PRIMARY,
    OPENAI_MODEL_FALLBACK,
    OPENAI_MODEL_FALLBACK2,
  ].filter(Boolean);
  const systemPrompt = buildSystemPrompt(job.preset, job.brand);
  const userContent = buildUserContent(job.prompt, job.files, job.brand);

  for (const model of modelCandidates) {
    const res = await callOpenAI(model, systemPrompt, userContent);
    if (res.ok) {
      job.status = 'done';
      job.result = { files: res.files };
      job.error = null;
      job.updatedAt = Date.now();
      await redis.set('jobs:data:' + job.id, JSON.stringify(job));
      return;
    }
    // Record the failure and continue to next model
    job.logs.push(`Model ${model} failed: ${res.error}`);
    job.updatedAt = Date.now();
    await redis.set('jobs:data:' + job.id, JSON.stringify(job));
  }
  // All models failed
  job.status = 'error';
  job.error = job.logs[job.logs.length - 1] || 'AI failed';
  job.updatedAt = Date.now();
  await redis.set('jobs:data:' + job.id, JSON.stringify(job));
}

// Worker loop: continuously pop jobs from the queue and process them. If
// WORKER_ENABLED=false, the loop exits immediately.
async function workerLoop() {
  if (WORKER_ENABLED === 'false' || WORKER_ENABLED === false) {
    console.log('[worker] disabled');
    return;
  }
  while (true) {
    try {
      const jobId = await redis.lpop('jobs:queue');
      if (!jobId) {
        // No job available; sleep a bit
        await sleep(2000);
        continue;
      }
      const jobStr = await redis.get('jobs:data:' + jobId);
      if (!jobStr) continue;
      const job = JSON.parse(jobStr);
      await runJob(job);
    } catch (err) {
      console.error('[worker] error:', err);
      await sleep(2000);
    }
  }
}

// Middleware to authenticate using a shared secret header
function authenticate(req, res, next) {
  const secret = req.header('x-runner-secret');
  if (!secret || secret !== RUNNER_SHARED_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Create a new job: store job data and push to queue
app.post('/jobs-create', authenticate, async (req, res) => {
  const { preset = '', prompt = '', files = {}, brand = null } = req.body || {};
  if (!files || typeof files !== 'object') {
    return res.status(400).json({ error: 'files must be provided' });
  }
  const id = generateId();
  const job = {
    id,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    preset,
    prompt,
    files,
    brand,
    logs: [],
    result: null,
    error: null,
  };
  await redis.set('jobs:data:' + id, JSON.stringify(job));
  await redis.rpush('jobs:queue', id);
  return res.status(202).json({ ok: true, jobId: id });
});

// Fetch the status of a job. Returns current status, result if available,
// and a truncated list of logs.
app.get('/jobs-status', authenticate, async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const jobStr = await redis.get('jobs:data:' + id);
  if (!jobStr) return res.status(404).json({ error: 'Job not found' });
  const job = JSON.parse(jobStr);
  const logs = Array.isArray(job.logs)
    ? job.logs.slice(Math.max(0, job.logs.length - 20))
    : [];
  return res.json({ status: job.status, result: job.result, error: job.error, logs });
});

// Start server and worker. We defer starting the worker until after the
// server has begun listening to avoid race conditions during startup.
app.listen(PORT, () => {
  console.log(`[runner] listening on ${PORT}`);
  workerLoop().catch((err) => {
    console.error('Worker failed to start:', err);
  });
});