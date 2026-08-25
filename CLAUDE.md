# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es esto

POS ("Caja Evento") para un evento con varios puntos de venta. App web estática
en vanilla JS (sin build, sin dependencias, sin backend) pensada para
desplegarse en GitHub Pages y usarse desde el móvil. No hay `npm install`,
compilación, linter ni tests: se edita directamente HTML/CSS/JS y se
comprueba abriendo el archivo o la Page desplegada.

Cada venta y cada cierre de caja se guarda como un **commit en este mismo
repositorio**, escrito desde el navegador vía la API de contenidos de GitHub
(`api.github.com/repos/.../contents/...`), autenticada con un fine-grained
PAT que el usuario pega en Ajustes y que se guarda solo en `localStorage`
(nunca en el repo).

## Dos webs independientes (más silos por punto)

- **`/venta/`** — la usan los voluntarios en cada punto de venta: registrar
  ventas y consultar su propio historial.
- **`/caja/`** — cierre consolidado de todos los puntos, exportación CSV. No
  está enlazada desde `/venta/` ni se reparte a los voluntarios; la propia
  URL sin publicitar es el único control de acceso (no hay autenticación
  real).
- **`/ventajuan/` + `/cajajuan/`** — mismo patrón que `/venta/` + `/caja/`
  pero para un punto de venta que debe quedar fuera del sistema
  multipunto general (no aparece en `puntos_venta.json` ni en el selector
  de `/venta/`, ni en el consolidado de `/caja/`): son copias reducidas a
  un único punto fijo, sin selector ni fetch de `puntos_venta.json`, con
  su propio catálogo (`data/articulos_<punto>.json`, sin `puntos_venta:
  [...]` porque no hay que filtrar). Es el mecanismo a seguir si hace
  falta aislar otro punto de venta del resto: duplicar `venta/` y `caja/`
  bajo `/venta<id>/` y `/caja<id>/`, fijar el punto activo como constante
  en vez de leerlo de un selector, y darle su propio
  `data/articulos_<id>.json`. Ambas siguen importando la lógica
  compartida de `js/api-github.js` igual que las webs generales.

Ambas importan la lógica compartida desde `js/api-github.js` (config de
conexión, wrapper de la API de GitHub con reintento por SHA, y helpers puros
de pagos/cierres). No dupliques esa lógica en `venta/app.js` o `caja/app.js`.

## Modelo de datos (`data/`)

- `puntos_venta.json` — catálogo de puntos: `[{ id, nombre }]`.
- `articulos.json` — catálogo **único** compartido entre puntos; cada
  artículo lleva `puntos_venta: ["idA", "idB"]` (permite que un artículo se
  venda en varios puntos).
- `ventas_<punto_id>.json` — **un archivo de ventas por punto** (p. ej.
  `ventas_carpa_estrella.json`), no uno compartido. Esto es deliberado: con
  varios dispositivos escribiendo a la vez, separar por punto evita que
  compitan entre sí por el mismo SHA. Al añadir un punto de venta nuevo en
  `puntos_venta.json`, su archivo de ventas se crea solo al registrar la
  primera venta (`githubGetFile` devuelve `{sha:null, data:[]}` en un 404).
- `cierres.json` — único y compartido; cada cierre lleva `punto_venta_id` y
  referencia solo `venta_ids` de su propio punto.

Los precios están en CHF (así se etiquetan en toda la UI, incluidos los
tickets y el catálogo).

## Puntos importantes al tocar el código

- **Escritura optimista con reintento**: toda escritura a GitHub pasa por
  `guardarConReintento` en `js/api-github.js`, que relee el archivo y
  reintenta ante un 409 (conflicto de SHA), hasta 3 intentos. Si añades una
  nueva operación que escribe en `data/*.json`, reutiliza esta función en
  vez de hacer el PUT a mano.
- **Ventas anuladas, nunca borradas**: anular una venta la marca
  `anulada: true` pero no la elimina, para mantener trazabilidad. Los
  cierres excluyen las anuladas del total y de `num_ventas`, pero sí las
  incluyen en `venta_ids` para que queden archivadas en su sesión de cierre.
  Anular una venta ya incluida en un cierre no recalcula ese cierre (el
  cierre es un registro histórico fijo).
- **Ventas antiguas sin `pagos`**: el campo `pagos` (array de
  `{metodo, importe}`, para soportar pago dividido) es posterior a
  `metodo_pago`/`total`. `pagosDeVenta()` en `js/api-github.js` deriva
  `pagos` a partir de los campos antiguos cuando no existe, para que el
  resto del código (historial, cierre, CSV) pueda asumir siempre que
  `pagos` existe sin migrar el JSON histórico.
- **Punto de venta activo es dinámico**: en `/venta/` se guarda en
  `localStorage` pero se puede cambiar en cualquier momento desde el
  selector de la cabecera; cambiar de punto vacía el ticket en curso (puede
  incluir artículos que no se venden en el nuevo punto) y recarga catálogo e
  historial filtrados por punto, sin recargar la página.
- **Render por delegación de eventos**: `productos-grid` y `ticket-lista` se
  regeneran enteros con `innerHTML` en cada cambio; los listeners de clic
  están en el contenedor padre (delegación), no en los botones individuales,
  precisamente porque estos se destruyen y recrean. Al añadir un botón
  dentro de una zona que se re-renderiza así, engánchalo por delegación en
  el contenedor, no con `getElementById(...).addEventListener(...)` directo.
- **Artículo libre**: en `/venta/`, el tile "+ Artículo libre" (precio y
  nombre a mano, para imprevistos) se genera junto al resto del catálogo
  dentro de `productos-grid` y se ve como un artículo más — no está
  diferenciado en la UI a propósito.
