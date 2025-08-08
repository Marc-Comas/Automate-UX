# Project Central — Prod Ready

Dashboard local-first para generar y modificar landings con OpenAI Assistant + despliegue GitHub/Netlify.

## Variables de entorno (Netlify)

- `OPENAI_API_KEY`
- `OPENAI_ASSISTANT_ID`
- `GITHUB_TOKEN`
- `GH_OWNER`
- `GH_REPO`
- `GH_BRANCH` (opcional, por defecto `main`)
- `NETLIFY_BUILD_HOOK`

## Desarrollo local

1. Abre `index.html` en el navegador.
2. En **Settings**, rellena claves locales (solo visibles en `localhost`).
3. Crea proyecto y usa **Preview → Aplicar cambios (IA)**.
4. Push/Deploy requieren levantar en Netlify o un servidor que sirva `/.netlify/functions/*`.

## Producción (Netlify)

1. Sube esta carpeta a Netlify.
2. Añade las variables de entorno arriba.
3. Deploy.
4. En producción, los campos de claves se ocultan y las funciones usan las credenciales del servidor.
