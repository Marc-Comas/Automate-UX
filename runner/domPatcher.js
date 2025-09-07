// runner/domPatcher.js — audited & hardened (2025-09-07)
// - Keeps edits strictly scoped to a root selector (or <body> if missing).
// - Respects "protectedSelectors" (cannot modify or descend into these nodes).
// - Deduplicates candidate elements across overlapping roots.
// - Adds simple but effective HTML sanitization (no <script>, <iframe>, event handlers, or javascript: URIs).
// - Adds an optional "maxOps" budget and returns an "applied" log for observability.
// - Makes CSS "upsert_style" idempotent by merging rules for an existing selector instead of naive string-includes.
//
// NOTE: This module intentionally supports only a small, safe set of operations.
//       Extend with care. Prefer *data/props generation* by LLMs over raw HTML.
//
// API:
//   applyOps({
//     html,           // string (required)
//     css,            // string (required)
//     ops,            // Array<{op:string, selector:string, ...}> (required)
//     root,           // CSS selector that defines scope (recommended)
//     protectedSelectors = [], // Array<string>
//     maxOps = 200    // soft budget to avoid runaway edits
//   }) -> { html, css, changed, applied }
//
import { JSDOM } from 'jsdom';

/** ancestor containment check */
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

/** safe query within a root */
function anyMatch(root, selector) {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

/** very small, conservative sanitizer */
function sanitizeHtmlFragment(win, html) {
  const frag = win.document.createElement('template');
  frag.innerHTML = String(html || '');

  // Remove dangerous elements completely
  const dangerous = frag.content.querySelectorAll('script, iframe, object, embed, link[rel="stylesheet"], meta');
  dangerous.forEach((el) => el.remove());

  // Strip event handlers and javascript: URLs
  const all = frag.content.querySelectorAll('*');
  all.forEach((el) => {
    // remove on* attributes
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value || '')) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return frag.innerHTML;
}

/** merge or append CSS rules for a selector (idempotent) */
function upsertCssRule(cssText, selector, styleRules) {
  const sel = String(selector || '').trim();
  const rules = String(styleRules || '').trim();
  if (!sel || !rules) return cssText || '';

  // crude parser: find existing block: selector { ... }
  const pattern = new RegExp(`(^|\\})\\s*${sel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`, 'm');
  const m = pattern.exec(cssText || '');
  if (!m) {
    return (cssText || '') + `\n${sel} { ${rules} }`;
  }
  // merge properties (last one wins)
  const existing = m[2].trim();
  const map = Object.create(null);
  for (const prop of existing.split(';')) {
    const [k, v] = prop.split(':');
    if (!k || v === undefined) continue;
    map[k.trim()] = v.trim();
  }
  for (const prop of rules.split(';')) {
    const [k, v] = prop.split(':');
    if (!k || v === undefined) continue;
    map[k.trim()] = v.trim();
  }
  const merged = Object.entries(map).map(([k, v]) => `${k}: ${v}`).join('; ');
  const replacement = `${m[1]} ${sel} { ${merged} }`;
  return (cssText || '').slice(0, m.index) + replacement + (cssText || '').slice(m.index + m[0].length);
}

export function applyOps({ html, css, ops, root, protectedSelectors = [], maxOps = 200 }) {
  const dom = new JSDOM(String(html || ''));
  const doc = dom.window.document;

  // Determine root container(s) — scope edits tightly
  const roots = root ? Array.from(doc.querySelectorAll(root)) : [];
  const safeRoots = roots.length ? roots : [doc.body];
  const isRootEl = (el) => safeRoots.some(r => r === el);


  // Build protected node set with defaults (defense-in-depth)
  const DEFAULT_PROTECTED = ['header', 'footer role="contentinfo"', 'script', 'link', 'meta', 'style'];
  const protectedNodes = new Set();
  for (const sel of [...DEFAULT_PROTECTED, ...protectedSelectors]) {
    try {
      for (const node of doc.querySelectorAll(sel)) protectedNodes.add(node);
    } catch { /* ignore bad selector */ }
  }

  const inProtected = (el) => {
    if (!el) return false;
    for (const p of protectedNodes) {
      if (contains(p, el)) return true;
    }
    return false;
  };

  let changed = 0;
  const applied = [];
  const seen = new Set(); // dedupe elements across roots/selectors

  const budgetLeft = () => (maxOps <= 0 ? Infinity : Math.max(0, maxOps - changed));

  for (const op of Array.isArray(ops) ? ops : []) {
    if (!budgetLeft()) break;

    const { selector } = op || {};
    if (!selector || !op.op) continue;

    // Resolve elements inside allowed roots only
    let candidates = [];
    for (const r of safeRoots) {
      try {
        for (const el of r.querySelectorAll(selector)) {
          // de-dup via unique path
          const key = `${selector}@@${el.tagName}#${el.id}.${el.className}`;
          if (!seen.has(key)) {
            candidates.append ? candidates.append(el) : candidates.push(el);
            seen.add(key);
          }
        }
      } catch { /* bad selector; ignore */ }
    }
    if (!candidates.length) continue;

    for (const el of candidates) {
      if (!budgetLeft()) break;
      if (inProtected(el)) continue;

      switch (op.op) {
        case 'replace_text':
          if (typeof op.text === 'string') {
            el.textContent = op.text;
            changed++;
            applied.push({ op: op.op, selector });
          }
          break;

        case 'append_html': {
          if (typeof op.html === 'string') {
            const safe = sanitizeHtmlFragment(dom.window, op.html);
            el.insertAdjacentHTML('beforeend', safe);
            changed++;
            applied.push({ op: op.op, selector });
          }
          break;
        }

        case 'replace_html': {
          if (isRootEl(el)) { break; }
          if (typeof op.html === 'string') {
            const safe = sanitizeHtmlFragment(dom.window, op.html);
            el.innerHTML = safe;
            changed++;
            applied.push({ op: op.op, selector });
          }
          break;
        }

        case 'set_attr': {
          if (op.attr) {
            const name = String(op.attr).toLowerCase();
            if (!name.startsWith('on')) { // no event handlers
              const value = (op.value ?? '').toString();
              if (!(/^javascript:/i.test(value) && (name === 'href' || name === 'src'))) {
                el.setAttribute(op.attr, value);
                changed++;
                applied.push({ op: op.op, selector, attr: op.attr });
              }
            }
          }
          break;
        }

        case 'add_class': {
          if (op.value) {
            const list = String(op.value).split(/\s+/).filter(Boolean);
            if (list.length) {
              el.classList.add(...list);
              changed++;
              applied.push({ op: op.op, selector, value: list.join(' ') });
            }
          }
          break;
        }

        case 'remove_class': {
          if (op.value) {
            const list = String(op.value).split(/\s+/).filter(Boolean);
            if (list.length) {
              el.classList.remove(...list);
              changed++;
              applied.push({ op: op.op, selector, value: list.join(' ') });
            }
          }
          break;
        }

        case 'upsert_style': {
          if (op.cssSelector && op.styleRules) {
            css = upsertCssRule(css || '', op.cssSelector, op.styleRules);
            changed++;
            applied.push({ op: op.op, selector: op.cssSelector });
          }
          break;
        }

        default:
          // ignore unknown ops (safer than erroring in production)
          break;
      }
    }
  }

  return { html: dom.serialize(), css: String(css || ''), changed, applied };
}
