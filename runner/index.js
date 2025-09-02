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
// Use the global `fetch` API provided by Node 18+. The previous
// implementation used node-fetch which is ESM-only and caused ERR_REQUIRE_ESM
// errors when required in CommonJS. Node 18 includes a native fetch
// implementation, so we rely on that instead.
// NOTE: Do not import or require node-fetch here.
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Configuration from environment
const {
  REDIS_URL,
  RUNNER_SHARED_SECRET,
  OPENAI_API_KEY,
  OPENAI_MODEL_PRIMARY,
  OPENAI_MODEL_FALLBACK,
  OPENAI_MODEL_FALLBACK2,
  MODEL_TIMEOUT_MS = '26000',
  WORKER_ENABLED = 'true',
} = process.env;

// Normalise model identifiers. Users might set shorthand names like 'o4' or
// 'o4-mini'. Map these to valid OpenAI model IDs. Extend this map as new
// models emerge. If no mapping exists, return the original value.
function normalizeModel(name) {
  const map = {
    'o4': 'gpt-4o',
    'o4-mini': 'gpt-4o-mini',
    'o4-mini-2024-07-18': 'gpt-4o-mini',
    'gpt5': 'gpt-5',
    'gpt5-mini': 'gpt-5-mini',
  };
  return map[name] || name;
}

// Connect to Redis
const redis = new Redis(REDIS_URL);

// Load knowledge documents into memory once at startup
function loadKnowledge() {
  const dir = path.join(__dirname, '..', 'knowledge');
  const knowledge = {};
  for (const name of ['brand', 'ui', 'ux', 'copy']) {
    try {
      const file = path.join(dir, `${name}.json`);
      const raw = fs.readFileSync(file, 'utf8');
      knowledge[name] = JSON.parse(raw);
    } catch (err) {
      console.warn(`Failed to load ${name}.json: ${err.message}`);
      knowledge[name] = {};
    }
  }
  return knowledge;
}
const KNOWLEDGE = loadKnowledge();

// Utility to sleep
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Generate a simple unique identifier based on timestamp and random bits
function generateId() {
  return (
    Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8)
  );
}

// Build a system prompt based on the preset and optional brand metadata.
function buildSystemPrompt(preset, brand) {
  // Base instructions common to all jobs
  const base = [];
  base.push(
    'You are an assistant that edits or generates small static websites consisting of three files: index.html, styles/style.css and scripts/app.js.'
  );
  base.push(
    'You must return a JSON object with a single property "files". The "files" property is an object with exactly three string properties: "index.html", "styles/style.css" and "scripts/app.js".'
  );
  base.push(
    'Do not return any additional properties. Do not wrap the JSON in markdown. Do not include explanations. Always respond with strict JSON.'
  );
  base.push(
    'The HTML must not include <script> tags with external src attributes, and the CSS must not include @import rules.'
  );
  base.push(
    'Preserve the existing structure and accessibility wherever possible. Maintain responsive layout.'
  );

  // Apply preset‑specific instructions
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
        'If no preset is specified, you may modify HTML, CSS, and JS as needed to satisfy the prompt. Maintain coherence and avoid unnecessary changes.'
      );
      break;
  }

  // Incorporate brand guidelines if provided
  if (brand && typeof brand === 'object') {
    const keys = Object.keys(brand);
    if (keys.length > 0) {
      base.push(
        'Use the following brand palette and tone. Colours are given as hexadecimal strings.'
      );
      base.push(JSON.stringify(brand));
    }
  } else if (KNOWLEDGE.brand && KNOWLEDGE.brand.default) {
    base.push(
      'When no brand is provided, fall back to this default brand palette and tone:'
    );
    base.push(JSON.stringify(KNOWLEDGE.brand.default));
  }

  // Add UI/UX/copy rules from knowledge documents
  if (KNOWLEDGE.ui && KNOWLEDGE.ui.components) {
    base.push(
      'Follow these UI component guidelines for consistency:' +
        JSON.stringify(KNOWLEDGE.ui.components)
    );
  }
  if (KNOWLEDGE.ux && KNOWLEDGE.ux.rules) {
    base.push(
      'Follow these UX structural rules if you need to rearrange sections:' +
        JSON.stringify(KNOWLEDGE.ux.rules)
    );
  }
  if (KNOWLEDGE.copy && KNOWLEDGE.copy.tone) {
    base.push(
      'Follow these copywriting guidelines:' + JSON.stringify(KNOWLEDGE.copy)
    );
  }

  return base.join('\n');
}

// Build the user content payload. This contains the prompt and a snapshot of
// the existing files. We send all three files, ensuring strings, even if
// empty, because OpenAI needs complete context. Brand information is also
// included if provided.
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

// Validate the AI output. Ensures we have the expected structure and that
// everything is a string. Additional sanitisation removes remote scripts or
// external stylesheets for security.
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
  // Sanitise HTML: remove external scripts and stylesheet links
  files['index.html'] = files['index.html'].replace(/<script[^>]*\s+src=['"][^'"]+['"][^>]*>\s*<\/script>/gi, '');
  files['index.html'] = files['index.html'].replace(/<link[^>]+rel=['"]stylesheet['"][^>]+href=['"]http[^'"]+['"][^>]*>/gi, '');
  return files;
}

// Call OpenAI via the Chat Completions API with a given model.
// Returns { ok, files?, error? }.
async function callOpenAI(model, systemPrompt, userContent) {
  // Use chat completions endpoint for stability and JSON mode support.
  const url = 'https://api.openai.com/v1/chat/completions';
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  };
  const body = {
    model,
    // Do not specify temperature because some models (e.g. gpt-5, gpt-4o-mini)
    // accept only the default temperature of 1 and reject custom values.
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
    // Chat completions returns choices array with message content
    const content = data?.choices?.[0]?.message?.content || '';
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

// Process a single job by calling one or more models. Mutates and saves
// the job record in Redis. If AI fails, records error.
async function runJob(job) {
  job.status = 'running';
  job.updatedAt = Date.now();
  await redis.set('jobs:data:' + job.id, JSON.stringify(job));
  // Normalise model names to ensure valid OpenAI model IDs. e.g. map 'o4' → 'gpt-4o'
  const modelCandidates = [OPENAI_MODEL_PRIMARY, OPENAI_MODEL_FALLBACK, OPENAI_MODEL_FALLBACK2]
    .filter(Boolean)
    .map((m) => normalizeModel(m));
  // Build prompts once
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
    // Log the error and continue to the next model
    job.logs.push(`Model ${model} failed: ${res.error}`);
    job.updatedAt = Date.now();
    await redis.set('jobs:data:' + job.id, JSON.stringify(job));
  }
  // If we reach here, all models failed
  job.status = 'error';
  job.error = job.logs[job.logs.length - 1] || 'AI failed';
  job.updatedAt = Date.now();
  await redis.set('jobs:data:' + job.id, JSON.stringify(job));
}

// Background worker loop
async function workerLoop() {
  if (WORKER_ENABLED === 'false') return;
  while (true) {
    try {
      const jobId = await redis.lpop('jobs:queue');
      if (!jobId) {
        // Sleep briefly if no job
        await sleep(2000);
        continue;
      }
      const jobStr = await redis.get('jobs:data:' + jobId);
      if (!jobStr) continue;
      const job = JSON.parse(jobStr);
      await runJob(job);
    } catch (err) {
      console.error('Worker error:', err);
      // Sleep a bit before continuing to avoid tight error loop
      await sleep(2000);
    }
  }
}

// Middleware: authenticate using shared secret
function authenticate(req, res, next) {
  const secret = req.header('x-runner-secret');
  if (!secret || secret !== RUNNER_SHARED_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Create job
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
  return res.status(202).json({ jobId: id });
});

// Get job status
app.get('/jobs-status', authenticate, async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const jobStr = await redis.get('jobs:data:' + id);
  if (!jobStr) return res.status(404).json({ error: 'Job not found' });
  const job = JSON.parse(jobStr);
  // Limit logs to last 20 entries to avoid large payloads
  const logs = Array.isArray(job.logs)
    ? job.logs.slice(Math.max(0, job.logs.length - 20))
    : [];
  return res.json({ status: job.status, result: job.result, error: job.error, logs });
});

// Start server and worker
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Runner service listening on port ${port}`);
});

workerLoop().catch((err) => {
  console.error('Worker failed to start:', err);
});