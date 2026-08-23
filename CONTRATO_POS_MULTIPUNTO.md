# Contrato de arquitectura: POS multi-punto de venta

## Contexto y requisito

Evolución del POS estático `poscode` (sin backend, GitHub Pages, vanilla JS,
persistencia vía GitHub Contents API con locking optimista por SHA) para
soportar un evento con **2-3 puntos de venta**, cada uno con su propio
subconjunto de artículos (que pueden solaparse entre puntos), y **dos webs
separadas**:

- **`/venta/`** — POS + historial del punto de venta activo. Es la que usan
  los voluntarios.
- **`/caja/`** — cierres de caja, consolidados de todos los puntos. URL no
  enlazada desde `/venta/` y no compartida con los voluntarios (la
  separación de URL es suficiente control de acceso para este caso de uso;
  no se implementa autenticación real).

Requisito adicional: el punto de venta activo en un terminal es **dinámico**
— un mismo dispositivo puede cambiar de punto de venta varias veces a lo
largo del evento, no se fija una sola vez al inicio.

## Decisión: evolucionar el repo actual, no clonarlo

Clonar el repo por cada punto de venta generaría N catálogos y N copias de
código que mantener sincronizados a mano. En su lugar: mismo repo, mismo
código base compartido, parametrizado por punto de venta activo.

## Modelo de datos

```
data/
  puntos_venta.json       ← catálogo de puntos: [{ id, nombre }]
  articulos.json          ← catálogo ÚNICO compartido; cada artículo lleva
                             puntos_venta: ["puntoA", "puntoB"] (permite solape)
  ventas_puntoA.json      ← un archivo de ventas POR PUNTO
  ventas_puntoB.json
  ventas_puntoC.json
  cierres.json            ← único, compartido; cada cierre lleva punto_venta_id
                             y referencia solo venta_ids de su propio archivo
```

**Por qué un archivo de ventas por punto y no uno compartido**: el locking
optimista actual (SHA + reintento ante 409) funciona bien con pocos
dispositivos escribiendo al mismo archivo. Con 2-3 puntos escribiendo
simultáneamente sobre un único `ventas.json`, los conflictos y reintentos se
multiplicarían. Separando por punto, cada uno solo compite consigo mismo.

## Estructura del repo

```
/js/            ← módulos compartidos: api-github.js, articulos.js,
                   ventas.js, ui.js
/venta/
    index.html
    app.js
/caja/
    index.html
    app.js
/data/
```

## Punto de venta activo (dinámico)

- El punto de venta activo se guarda en `localStorage` del dispositivo, pero
  **no es fijo**: `/venta/` muestra un selector siempre visible (cabecera)
  para cambiarlo en cualquier momento del evento.
- Al cambiar de punto: se recarga en memoria el catálogo filtrado
  (`articulos.json` filtrado por `puntos_venta`) y el historial
  correspondiente a `ventas_puntoX.json` de ese punto — sin recargar la
  página completa.
- Cada venta se guarda en el archivo del punto que estaba activo en el
  momento de cobrar. No hay ambigüedad ni mezcla entre puntos.
- La cabecera de `/venta/` debe mostrar de forma visible y prominente qué
  punto está activo en cada momento, para evitar cobros en el punto
  equivocado tras un cambio.

## `/caja/` — cierres

- Lee y agrega los `ventas_puntoX.json` de todos los puntos.
- Cada cierre generado lleva `punto_venta_id` (se cierra por punto, no un
  cierre global mezclado) y aplica la misma lógica ya validada de
  `num_ventas` vs `venta_ids` (excluye anuladas del conteo, las incluye en
  la lista para poder archivarlas).
- Sin autenticación real. La protección es que la URL de `/caja/` no se
  enlaza desde `/venta/` ni se distribuye a los voluntarios.

## Lo que no cambia

- Lógica de guardado con reintento ante conflicto 409 (SHA).
- Modelo de cierres con anuladas (`num_ventas` excluye anuladas,
  `venta_ids` las incluye para archivarlas).
- UI y flujo de venta existentes.

## Pendiente de decidir en implementación

- Diseño exacto del selector de punto de venta en `/venta/` (dropdown vs
  botones, dónde en la cabecera).
- Si el selector de puntos_venta en el catálogo de artículos usa checkboxes
  múltiples o un `MultiSelect` similar al ya usado en el ERP.
