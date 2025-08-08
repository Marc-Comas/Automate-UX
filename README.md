# Project Central — Assistant Ready (Netlify)

Este repo despliega la dashboard y una Function que llama a tu Assistant de OpenAI.

## Estructura
- `index.html` — Dashboard (usa Function si existe; fallback local si falla)
- `netlify/functions/generate.js` — Llama al Assistant y devuelve `{ files: { ... } }`
- `package.json` — Dependencias (OpenAI)
- `netlify.toml` — Config de Netlify

## Deploy rápido en Netlify
1. Crea un repo nuevo en GitHub y sube estos archivos.
2. En Netlify: **Add new site > Import from Git** y selecciona el repo.
3. En **Site settings > Build & deploy > Environment variables** añade:
   - `OPENAI_API_KEY` = tu `sk-...`
   - `OPENAI_ASSISTANT_ID` = tu `asst_...`
4. Deploy. Netlify instalará la lib `openai` y publicará la función en `/.netlify/functions/generate`.
5. Abre la web. En **New Project** escribe un prompt y pulsa **Generar**.
   - Si la Function responde OK → verás el proyecto con estado `generated`.
   - Si falla o no existe → usa el generador local (estado `local`).

## Notas
- Los tokens guardados en Settings se almacenan en `localStorage` y **no** se usan por la Function. Las keys reales van como **variables de entorno** en Netlify.
- El Assistant debe responder **exclusivamente JSON** con la forma:
```json
{
  "files": {
    "index.html": "<html>...</html>",
    "styles/style.css": "/* opcional */",
    "scripts/app.js": "// opcional"
  }
}
```
