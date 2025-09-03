// runner/domPatcher.js
// Minimal DOM patcher that only allows modifications inside a root container
// and refuses to touch protected selectors.

import { JSDOM } from 'jsdom';

function contains(rootEl, candidate) {
  if (rootEl === candidate) return true;
  let n = candidate;
  while (n) {
    if (n === rootEl) return true;
    n = n.parentElement;
  }
  return false;
}

function anyMatch(root, selector) {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

export function applyOps({ html, css, ops, root, protectedSelectors = [] }) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Determine root container(s)
  const roots = Array.from(doc.querySelectorAll(root));
  const safeRoots = roots.length ? roots : [doc.body];

  // Build protected node set
  const protectedNodes = new Set();
  for (const sel of protectedSelectors) {
    for (const node of doc.querySelectorAll(sel)) {
      protectedNodes.add(node);
    }
  }

  let changed = 0;

  const inProtected = (el) => {
    if (!el) return false;
    for (const p of protectedNodes) {
      if (contains(p, el)) return true;
    }
    return false;
  };

  for (const op of ops) {
    const { selector } = op;
    if (!selector || !op.op) continue;

    // Resolve elements inside allowed roots only
    let candidates = [];
    for (const r of safeRoots) {
      candidates.push(...anyMatch(r, selector));
    }
    if (!candidates.length) continue;

    for (const el of candidates) {
      if (inProtected(el)) continue;

      switch (op.op) {
        case 'replace_text':
          if (typeof op.text === 'string') {
            el.textContent = op.text;
            changed++;
          }
          break;
        case 'append_html':
          if (typeof op.html === 'string') {
            el.insertAdjacentHTML('beforeend', op.html);
            changed++;
          }
          break;
        case 'replace_html':
          if (typeof op.html === 'string') {
            el.innerHTML = op.html;
            changed++;
          }
          break;
        case 'set_attr':
          if (op.attr) {
            el.setAttribute(op.attr, op.value ?? '');
            changed++;
          }
          break;
        case 'add_class':
          if (op.value) {
            el.classList.add(...op.value.split(/\s+/).filter(Boolean));
            changed++;
          }
          break;
        case 'remove_class':
          if (op.value) {
            el.classList.remove(...op.value.split(/\s+/).filter(Boolean));
            changed++;
          }
          break;
        case 'upsert_style': {
          // Simple CSS append/update. We just append rules if not present.
          if (op.cssSelector && op.styleRules) {
            const block = `\n${op.cssSelector} { ${op.styleRules} }`;
            if (!css.includes(block.trim())) {
              css += block;
              changed++;
            }
          }
          break;
        }
        default:
          break;
      }
    }
  }

  return { html: dom.serialize(), css, changed };
}
