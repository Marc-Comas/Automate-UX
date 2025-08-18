// ===============================
// file: netlify/functions/push-to-github.js
// Purpose: Read DATA repo config from env + tiny GitHub helper used by
//          projects-save / projects-list / projects-get / projects-delete
// ===============================

const GITHUB_API = "https://api.github.com";

/** Build config for the *DATA* repo, safely reading env names you use. */
export function buildDataConfig() {
  const cfg = {
    owner: process.env.GH_DATA_OWNER || process.env.GH_OWNER || "",
    repo: process.env.GH_DATA_REPO || process.env.GH_REPO || "",
    /** Prefer dedicated token for DATA; fallback to the normal GitHub token */
    token: process.env.GITHUB_DATA_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
    branch: process.env.GH_DATA_BRANCH || process.env.GH_BRANCH || "main",
  };
  return cfg;
}

/** Fail fast with a clear error instead of throwing reference errors */
export function validateDataConfig(cfg) {
  if (!cfg.owner) return { ok: false, error: "owner is not defined" };
  if (!cfg.repo) return { ok: false, error: "repo is not defined" };
  if (!cfg.token) return { ok: false, error: "token is not defined" };
  return { ok: true };
}

/**
 * PUT (create/update) a single file using GitHub Contents API.
 * It auto-fetches the file SHA if the file already exists.
 */
async function putFile({ owner, repo, branch, token }, path, content, message) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // Check if the file exists to include its SHA on update
  let sha = undefined;
  const getRes = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
  if (getRes.ok) {
    const existing = await getRes.json();
    // Only set SHA if response has it (i.e., file exists on that branch)
    if (existing && existing.sha) sha = existing.sha;
  }

  const body = {
    message: message || `Save ${path}`,
    content: Buffer.from(content ?? "").toString("base64"),
    branch,
    sha,
  };

  const putRes = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });

  if (!putRes.ok) {
    const err = await putRes.text();
    return { path, committed: false, error: `GitHub ${putRes.status}: ${err}` };
  }
  return { path, committed: true };
}

/** PUT a set of files; returns an array with per-file outcomes */
export async function putFiles(cfg, files, basePath = "") {
  const safe = validateDataConfig(cfg);
  if (!safe.ok) return { ok: false, results: [], error: safe.error };

  const results = [];
  for (const f of files) {
    // Skip undefined/empty optional files cleanly
    const content = typeof f.content === "string" ? f.content : "";
    if (!content.trim()) {
      results.push({ path: f.path, committed: false, error: "empty_file" });
      continue;
    }
    const path = basePath ? `${basePath.replace(/\/$/, "")}/${f.path}` : f.path;
    /* eslint-disable no-await-in-loop */
    const r = await putFile(cfg, path, content, f.message);
    results.push(r);
  }
  return { ok: true, results };
}

// Optional helper used by projects-list to provide a debug summary
export function publicConfigSummary(cfg) {
  return {
    ok: true,
    owner: cfg.owner || null,
    repo: cfg.repo || null,
    branch: cfg.branch || null,
    hasToken: Boolean(cfg.token),
  };
}


// ===============================
// file: netlify/functions/projects-save.js
// Purpose: Save a project to DATA repo under projects/<slug>/
// ===============================

import { buildDataConfig, validateDataConfig, putFiles } from "./push-to-github.js";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS,GET",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(code, obj) {
  return { statusCode: code, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method Not Allowed" });

  let payload;
  try { payload = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON" }); }

  const { project, files } = payload || {};
  if (!project || !project.slug) return json(400, { ok: false, error: "Missing project.slug" });
  if (!files || typeof files !== "object") return json(400, { ok: false, error: "Missing files" });

  const cfg = buildDataConfig();
  const valid = validateDataConfig(cfg);
  if (!valid.ok) return json(200, { ok: false, error: valid.error });

  const base = `projects/${project.slug}`;
  const set = [
    { path: "index.html", content: files["index.html"], message: `Save ${base}/index.html` },
    { path: "styles/style.css", content: files["styles/style.css"], message: `Save ${base}/styles/style.css` },
    { path: "scripts/app.js", content: files["scripts/app.js"], message: `Save ${base}/scripts/app.js` },
  ];

  const result = await putFiles(cfg, set, base);
  return json(200, result);
};


// ===============================
// file: netlify/functions/projects-list.js
// Purpose: list/diagnostics (returns config summary when ?debug=1)
// ===============================

import { buildDataConfig, publicConfigSummary } from "./push-to-github.js";

export const handler = async (event) => {
  const debug = (event.queryStringParameters || {}).debug;
  const cfg = buildDataConfig();
  if (debug) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(publicConfigSummary(cfg)),
    };
  }
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ ok: true }),
  };
};


// ===============================
// file: netlify/functions/projects-get.js
// (kept minimal; uses the same config builder if later you fetch files)
// ===============================

import { buildDataConfig, validateDataConfig } from "./push-to-github.js";

export const handler = async () => {
  const cfg = buildDataConfig();
  const v = validateDataConfig(cfg);
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(v.ok ? { ok: true } : { ok: false, error: v.error }),
  };
};


// ===============================
// file: netlify/functions/projects-delete.js
// (optional) demonstrates the same config usage; implement when needed
// ===============================

import { buildDataConfig, validateDataConfig } from "./push-to-github.js";

export const handler = async () => {
  const cfg = buildDataConfig();
  const v = validateDataConfig(cfg);
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(v.ok ? { ok: true } : { ok: false, error: v.error }),
  };
};
