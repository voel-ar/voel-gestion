# VOËL Gestión

App instalable (PWA) de gestión mayorista de VOËL: ventas, producción y talleres, proveedores, gastos, personal, costos y resumen.

- `index.html`: la app (misma app que el artifact de Claude).
- `platform.js`: conecta la app con Supabase (tabla `docs` + `miembros`), sincroniza en tiempo real, al volver a la app, al recuperar internet y cada 30 s.
- `sw.js`: service worker. **Subir la versión** (`VERSION`) en cada cambio para que los celulares se actualicen.
- `supabase/schema.sql`: estructura y permisos de la base (roles `dueño` / `equipo`).

La clave de Supabase que figura en `platform.js` es la pública (anon); los permisos los aplica la base. Las claves secretas nunca van en este repositorio.

Netlify publica automáticamente cada cambio en `main` (sin build, carpeta raíz).
