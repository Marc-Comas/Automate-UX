// runner/domPatcher.js
// Apply JSON ops *only inside* a root container and never through protected selectors.

import { JSDOM } from 'jsdom';

function contains(rootEl, candidate) {
  if (!rootEl || !candidate) return false;
  if (rootEl === candidate) return true;
  let n = candidate;
  while (n) {
    if (n === rootEl) return true;
    n = n.parentElement;
  }
  return false;
}

function queryAll(scope, selector) {
  try { return Array.from(scope.querySelectorAll(selector)); }
  catch { return []; }
}

export function applyOps({ html, css, ops, root, protectedSelectors = [] }) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const roots = queryAll(doc, root);
  const safeRoots = roots.length ? roots : [doc.body];

  // Build protected node set
  const protectedNodes = new Set();
  for (const sel of protectedSelectors) {
    for (const node of queryAll(doc, sel)) protectedNodes.add(node);
  }

  const isInProtected = (el) => {
    for (const p of protectedNodes) if (contains(p, el)) return true;
    return false;
  };

  const isInAnyRoot = (el) => safeRoots.some(r => contains(r, el));

  let changed = 0;

  for (const op of ops) {
    if (!op || !op.op || !op.selector) continue;

    // Find candidates only under allowed roots
    const candidates = safeRoots.flatMap(r => queryAll(r, op.selector));
    if (!candidates.length) continue;

    for (const el of candidates) {
      if (!isInAnyRoot(el) || isInProtected(el)) continue;

      switch (op.op) {
        case 'replace_text':
          if (typeof op.text === 'string') { el.textContent = op.text; changed++; }
          break;
        case 'append_html':
          if (typeof op.html === 'string') { el.insertAdjacentHTML('beforeend', op.html); changed++; }
          break;
        case 'replace_html':
          if (typeof op.html === 'string') { el.innerHTML = op.html; changed++; }
          break;
        case 'set_attr':
          if (op.attr) { el.setAttribute(op.attr, op.value ?? ''); changed++; }
          break;
        case 'add_class':
          if (op.value) { el.classList.add(...op.value.split(/\s+/).filter(Boolean)); changed++; }
          break;
        case 'remove_class':
          if (op.value) { el.classList.remove(...op.value.split(/\s+/).filter(Boolean)); changed++; }
          break;
        case 'upsert_style':
          if (op.cssSelector && op.styleRules) {
            const block = `\n${op.cssSelector} { ${op.styleRules} }`;
            if (!css.includes(block.strip ? block.strip() : block.trim())) {
              css += block;
              changed++;
            }
          }
          break;
        default: break;
      }
    }
  }

  return { html: dom.serialize(), css, changed };
}
