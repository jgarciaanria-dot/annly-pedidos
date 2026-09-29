# Annly Pedidos

Pedidos en línea para negocios que venden productos bajo pedido (floristerías, pastelerías, regalos).
Producto independiente de Annly Agenda: comparte el proyecto de Supabase, con tablas y RLS propias.

## Archivos
- `config.js`: URL y clave pública de Supabase. **No se reemplaza** al subir versiones nuevas.
- `pedidos.js`: capa de datos (sesión, negocio, catálogo, pedidos).
- `admin.html`: panel del negocio (`/admin`).
- `tienda.html`: sitio público (`/slug-del-negocio`).
- `vercel.json`: rutas limpias (`/admin` y `/slug`).

## Flujo de trabajo
- Cambios en la rama `develop`; `main` es producción.
- Al subir una versión nueva de `pedidos.js`, subir también el número `?v=` en `admin.html` y `tienda.html`.
- El registro de negocios vive en Annly (`annly.app/registro.html`), con la pregunta "¿Qué ofrece tu negocio?".
