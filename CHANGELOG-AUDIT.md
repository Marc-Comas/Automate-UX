# CHANGELOG — Audit Automate-UX-audited.zip
Date: 2025-09-07

Updated:
- runner/domPatcher.js (audited & hardened)

Highlights:
- Scoped edits to root selector; default body.
- Protected selectors include script/link/meta/style by default + user list.
- HTML sanitization (no <script>, <iframe>, event handlers, or javascript: URLs).
- Idempotent CSS upsert that merges properties per selector.
- Dedup of elements across overlapping roots/selectors.
- Soft budget via maxOps + applied log for observability.

Compatibility:
- Keeps the same `applyOps({{ html, css, ops, root, protectedSelectors, maxOps }})` signature.
