/* =========================================================
   CAJA EVENTO — POS sencillo con persistencia en GitHub
   ========================================================= */

import {
  config,
  guardarConfig,
  configCompleta,
  generarId,
  rutaVentas,
  RUTA_CIERRES,
  githubGetFile,
  guardarConReintento,
  validarConexion,
  pagosDeVenta,
  totalesPorMetodo,
  resumenPago,
  ventasPendientes,
  construirCierre,
} from "../js/api-github.js";

// Rutas de datos estáticos (puntos de venta y catálogo): relativas a esta
// página (/venta/), no a la raíz del repo como las rutas de la API de GitHub.
const RUTA_PUNTOS_VENTA = "../data/puntos_venta.json";
const RUTA_ARTICULOS = "../data/articulos.json";
const PUNTO_ACTIVO_KEY = "caja_evento_punto_activo";

let ticket = [];              // [{nombre, precio, cantidad}]
let cacheVentas = null;       // {sha, data:[...]}
let cacheCierres = null;      // {sha, data:[...]}
let puntoActivo = null;       // id del punto activo, resuelto en el arranque
let puntosVenta = [];         // [{id, nombre}], de data/puntos_venta.json
let catalogoArticulos = [];   // [{nombre, precio, puntos_venta}], de data/articulos.json

/* ---------------- Punto de venta activo ---------------- */

// puntos_venta.json y articulos.json son catálogo estático servido por
// GitHub Pages (no se escriben desde la app), así que se leen con fetch
// normal en vez de con la API de GitHub usada para ventas/cierres.
async function cargarDatosEstaticos() {
  const [resPuntos, resArticulos] = await Promise.all([
    fetch(RUTA_PUNTOS_VENTA, { cache: "no-store" }),
    fetch(RUTA_ARTICULOS, { cache: "no-store" }),
  ]);
  puntosVenta = await resPuntos.json();
  catalogoArticulos = await resArticulos.json();
}

function nombrePunto(id) {
  return puntosVenta.find((p) => p.id === id)?.nombre || id;
}

function resolverPuntoActivoInicial() {
  const guardado = localStorage.getItem(PUNTO_ACTIVO_KEY);
  if (guardado && puntosVenta.some((p) => p.id === guardado)) return guardado;
  return puntosVenta[0]?.id || null;
}

function renderSelectorPuntoVenta() {
  const select = document.getElementById("select-punto-venta");
  select.innerHTML = puntosVenta.map((p) => `<option value="${p.id}">${p.nombre}</option>`).join("");
  select.value = puntoActivo;
}

function renderProductosGrid() {
  const grid = document.getElementById("productos-grid");
  const articulos = catalogoArticulos.filter((a) => a.puntos_venta.includes(puntoActivo));
  grid.innerHTML = articulos
    .map(
      (a) => `
      <button class="producto-btn" data-nombre="${a.nombre}" data-precio="${a.precio}">
        <span class="p-nombre">${a.nombre}</span>
        <span class="p-precio">${a.precio} CHF</span>
      </button>`
    )
    .join("");
}

function cambiarPuntoActivo(nuevoPunto) {
  if (nuevoPunto === puntoActivo) return;
  puntoActivo = nuevoPunto;
  localStorage.setItem(PUNTO_ACTIVO_KEY, puntoActivo);

  // El catálogo cambia con el punto y un ticket a medias puede incluir
  // artículos que no se venden en el nuevo punto: se vacía para evitar
  // cobrar por error algo del punto anterior.
  ticket = [];
  renderTicket();
  renderProductosGrid();

  cacheVentas = null;
  const pantallaActual = document.querySelector(".pantalla.activa")?.id;
  if (pantallaActual === "pantalla-historial") refrescarHistorial();
  if (pantallaActual === "pantalla-cierre") refrescarCierre();

  mostrarToast(`Punto activo: ${nombrePunto(puntoActivo)}`);
}

document.getElementById("select-punto-venta").addEventListener("change", (e) => {
  cambiarPuntoActivo(e.target.value);
});

const cacheVentasApi = {
  get: () => cacheVentas,
  set: (v) => (cacheVentas = v),
};
const cacheCierresApi = {
  get: () => cacheCierres,
  set: (v) => (cacheCierres = v),
};

async function asegurarCacheVentas() {
  if (!cacheVentas) cacheVentas = await githubGetFile(rutaVentas(puntoActivo));
  return cacheVentas;
}
async function asegurarCacheCierres() {
  if (!cacheCierres) cacheCierres = await githubGetFile(RUTA_CIERRES);
  return cacheCierres;
}

/* ---------------- UI: navegación de pantallas ---------------- */

const pantallas = ["venta", "historial", "cierre", "ajustes"];

function mostrarPantalla(nombre) {
  pantallas.forEach((p) => {
    document.getElementById(`pantalla-${p}`).classList.toggle("activa", p === nombre);
  });
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("activa", btn.dataset.pantalla === nombre);
  });
  document.getElementById("pago-fija").classList.toggle("activa", nombre === "venta");
  if (nombre === "historial") refrescarHistorial();
  if (nombre === "cierre") refrescarCierre();
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => mostrarPantalla(btn.dataset.pantalla));
});
document.getElementById("btn-logo").addEventListener("click", () => mostrarPantalla("venta"));
document.getElementById("btn-ajustes").addEventListener("click", () => {
  document.querySelectorAll(".pantalla").forEach((p) => p.classList.remove("activa"));
  document.getElementById("pantalla-ajustes").classList.add("activa");
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("activa"));
  document.getElementById("pago-fija").classList.remove("activa");
});

/* ---------------- Toast / loading ---------------- */

let toastTimeout;
function mostrarToast(mensaje, esError = false) {
  const el = document.getElementById("toast");
  el.textContent = mensaje;
  el.classList.toggle("error", esError);
  el.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove("visible"), 3200);
}

function setCargando(activo) {
  document.getElementById("loading-overlay").classList.toggle("visible", activo);
}

/* ---------------- Pantalla: Venta ---------------- */

function totalTicket() {
  return ticket.reduce((s, i) => s + i.precio * i.cantidad, 0);
}

function renderTicket() {
  const lista = document.getElementById("ticket-lista");
  lista.innerHTML = "";

  if (ticket.length === 0) {
    lista.innerHTML = `<li class="ticket-vacio">Toca un artículo para empezar</li>`;
  } else {
    ticket.forEach((item, idx) => {
      const li = document.createElement("li");
      li.className = "ticket-item";
      li.innerHTML = `
        <span class="ticket-item-nombre">${item.nombre}</span>
        <div class="ticket-item-controles">
          <button class="qty-btn" data-idx="${idx}" data-accion="restar">−</button>
          <span class="qty-valor">${item.cantidad}</span>
          <button class="qty-btn" data-idx="${idx}" data-accion="sumar">+</button>
        </div>
        <span class="ticket-item-subtotal">${item.precio * item.cantidad} CHF</span>
      `;
      lista.appendChild(li);
    });
  }

  const total = totalTicket();
  document.getElementById("ticket-total-valor").textContent = `${total} CHF`;
  document.getElementById("btn-pago-cash").disabled = total === 0;
  document.getElementById("btn-pago-twint").disabled = total === 0;
  document.getElementById("btn-pago-tarjeta").disabled = total === 0;
  document.getElementById("btn-pago-dividir").disabled = total === 0;
  if (total === 0) {
    ocultarModalCash();
    ocultarModalDividir();
  }
}

document.getElementById("productos-grid").addEventListener("click", (e) => {
  const btn = e.target.closest(".producto-btn");
  if (!btn) return;
  const nombre = btn.dataset.nombre;
  const precio = Number(btn.dataset.precio);
  const existente = ticket.find((i) => i.nombre === nombre);
  if (existente) {
    existente.cantidad += 1;
  } else {
    ticket.push({ nombre, precio, cantidad: 1 });
  }
  renderTicket();
});

document.getElementById("ticket-lista").addEventListener("click", (e) => {
  const btn = e.target.closest(".qty-btn");
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  const item = ticket[idx];
  if (btn.dataset.accion === "sumar") item.cantidad += 1;
  if (btn.dataset.accion === "restar") item.cantidad -= 1;
  if (item.cantidad <= 0) ticket.splice(idx, 1);
  renderTicket();
});

document.getElementById("btn-vaciar-ticket").addEventListener("click", () => {
  ticket = [];
  renderTicket();
});

async function registrarVenta(pagos, botonOrigen) {
  if (!configCompleta()) {
    mostrarToast("Configura primero la conexión en Ajustes", true);
    mostrarPantalla("ajustes");
    return;
  }
  if (ticket.length === 0) return;

  const total = totalTicket();
  const metodoPago = pagos.length === 1 ? pagos[0].metodo : "Mixto";
  const venta = {
    id: generarId("v"),
    fecha: new Date().toISOString(),
    items: ticket.map((i) => ({ ...i })),
    total,
    metodo_pago: metodoPago,
    pagos,
    anulada: false,
    cierre_id: null,
  };

  const textoBotonOriginal = botonOrigen ? botonOrigen.textContent : null;

  setCargando(true);
  if (botonOrigen) {
    botonOrigen.disabled = true;
    botonOrigen.textContent = "Guardando…";
  }
  try {
    await asegurarCacheVentas();
    await guardarConReintento(
      rutaVentas(puntoActivo),
      (data) => {
        // Si un intento anterior sí llegó a guardarse en GitHub (pero el
        // cliente no recibió la respuesta a tiempo y reintentó), no la
        // dupliquemos: mismo id de venta ya presente, no hay nada que hacer.
        if (data.some((v) => v.id === venta.id)) return null;
        data.push(venta);
        return data;
      },
      `Venta ${venta.id} (${metodoPago}, ${total} CHF)`,
      cacheVentasApi,
      () => {
        if (botonOrigen) botonOrigen.textContent = "Reintentando…";
      }
    );
    ticket = [];
    renderTicket();
    ocultarModalCash();
    ocultarModalDividir();
    mostrarToast(`✓ Venta registrada: ${total} CHF (${metodoPago})`);
  } catch (e) {
    console.error(e);
    mostrarToast(`No se pudo guardar la venta: ${e.message}`, true);
  } finally {
    setCargando(false);
    if (botonOrigen) {
      botonOrigen.textContent = textoBotonOriginal;
      botonOrigen.disabled = totalTicket() === 0;
    }
  }
}

/* ---------------- Cobro en Cash (con cambio) ---------------- */

function ocultarModalCash() {
  document.getElementById("modal-cash").classList.add("oculto");
}

function mostrarModalCash() {
  document.getElementById("cash-total-valor").textContent = `${totalTicket()} CHF`;
  document.getElementById("input-cash-recibido").value = "";
  document.getElementById("modal-cash").classList.remove("oculto");
  actualizarCambioCash();
}

document.getElementById("btn-pago-cash").addEventListener("click", mostrarModalCash);
document.getElementById("btn-cash-cancelar").addEventListener("click", ocultarModalCash);

function actualizarCambioCash() {
  const total = totalTicket();
  const recibidoStr = document.getElementById("input-cash-recibido").value;
  const cambioEl = document.getElementById("cash-cambio");
  const btnConfirmar = document.getElementById("btn-cash-confirmar");

  if (recibidoStr === "") {
    cambioEl.textContent = "";
    cambioEl.className = "cobro-cambio";
    btnConfirmar.disabled = false;
    return;
  }

  const recibido = Number(recibidoStr) || 0;
  if (recibido < total) {
    cambioEl.textContent = `Falta importe: ${(total - recibido).toFixed(2)} CHF.`;
    cambioEl.className = "cobro-cambio error";
    btnConfirmar.disabled = true;
  } else {
    const cambio = Math.round((recibido - total) * 100) / 100;
    cambioEl.textContent = `Cambio: ${cambio} CHF`;
    cambioEl.className = "cobro-cambio ok";
    btnConfirmar.disabled = false;
  }
}

document.getElementById("input-cash-recibido").addEventListener("input", actualizarCambioCash);

document.querySelectorAll('.importes-rapidos[data-target="cash"] .importe-rapido-btn').forEach((btn) => {
  btn.addEventListener("click", () => {
    document.getElementById("input-cash-recibido").value = btn.dataset.importe;
    actualizarCambioCash();
  });
});

document.getElementById("btn-cash-confirmar").addEventListener("click", (e) => {
  registrarVenta([{ metodo: "Cash", importe: totalTicket() }], e.currentTarget);
});

document.getElementById("btn-pago-twint").addEventListener("click", (e) => {
  registrarVenta([{ metodo: "Twint", importe: totalTicket() }], e.currentTarget);
});

document.getElementById("btn-pago-tarjeta").addEventListener("click", (e) => {
  registrarVenta([{ metodo: "Tarjeta", importe: totalTicket() }], e.currentTarget);
});

/* ---------------- Pago dividido ---------------- */

function ocultarModalDividir() {
  document.getElementById("modal-dividir").classList.add("oculto");
}

function mostrarModalDividir() {
  const total = totalTicket();
  document.getElementById("dividir-total-valor").textContent = `${total} CHF`;
  document.getElementById("input-dividir-cash").value = 0;
  document.getElementById("input-dividir-twint").value = 0;
  document.getElementById("input-dividir-tarjeta").value = 0;
  document.getElementById("modal-dividir").classList.remove("oculto");
  validarDividir();
}

document.getElementById("btn-pago-dividir").addEventListener("click", mostrarModalDividir);
document.getElementById("btn-dividir-cancelar").addEventListener("click", ocultarModalDividir);

function importesDividir() {
  return {
    cash: Number(document.getElementById("input-dividir-cash").value) || 0,
    twint: Number(document.getElementById("input-dividir-twint").value) || 0,
    tarjeta: Number(document.getElementById("input-dividir-tarjeta").value) || 0,
  };
}

function validarDividir() {
  const { cash, twint, tarjeta } = importesDividir();
  const suma = Math.round((cash + twint + tarjeta) * 100) / 100;
  const total = totalTicket();
  const estado = document.getElementById("dividir-estado");
  const btnConfirmar = document.getElementById("btn-dividir-confirmar");

  if (suma !== total) {
    if (suma < total) {
      estado.textContent = `Falta por repartir: ${(total - suma).toFixed(2)} CHF.`;
    } else {
      estado.textContent = `Importe superior al total en ${(suma - total).toFixed(2)} CHF.`;
    }
    estado.className = "dividir-estado error";
    btnConfirmar.disabled = true;
    return;
  }

  estado.textContent = "Correcto: la suma coincide con el total.";
  estado.className = "dividir-estado ok";
  btnConfirmar.disabled = false;
}

document.getElementById("input-dividir-cash").addEventListener("input", validarDividir);
document.getElementById("input-dividir-twint").addEventListener("input", validarDividir);
document.getElementById("input-dividir-tarjeta").addEventListener("input", validarDividir);

// Evita el "0" pegado a la izquierda al escribir en un input que arranca en
// 0 (p. ej. 0 + "25" tecleado queda como "025" aunque el valor numérico ya
// fuera correcto): al enfocar se vacía si estaba en 0, y si se deja vacío
// al perder el foco vuelve a mostrar 0 por defecto.
function evitarCeroInicial(input) {
  input.addEventListener("focus", () => {
    if (input.value === "0") input.value = "";
  });
  input.addEventListener("blur", () => {
    if (input.value.trim() === "") input.value = "0";
  });
}
[
  document.getElementById("input-dividir-cash"),
  document.getElementById("input-dividir-twint"),
  document.getElementById("input-dividir-tarjeta"),
].forEach(evitarCeroInicial);

// Botón "Resto": rellena ese campo con lo que falta para llegar al total,
// para no tener que calcular a mano ni dejar el reparto desincronizado
// (p. ej. al anotar el efectivo recibido sin actualizar el campo Cash de arriba).
document.querySelectorAll(".resto-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const objetivo = btn.dataset.target;
    const { cash, twint, tarjeta } = importesDividir();
    const otros = { cash: twint + tarjeta, twint: cash + tarjeta, tarjeta: cash + twint }[objetivo];
    const resto = Math.max(0, Math.round((totalTicket() - otros) * 100) / 100);
    document.getElementById(`input-dividir-${objetivo}`).value = resto;
    validarDividir();
  });
});

document.getElementById("btn-dividir-confirmar").addEventListener("click", (e) => {
  const { cash, twint, tarjeta } = importesDividir();
  const pagos = [];
  if (cash > 0) pagos.push({ metodo: "Cash", importe: cash });
  if (twint > 0) pagos.push({ metodo: "Twint", importe: twint });
  if (tarjeta > 0) pagos.push({ metodo: "Tarjeta", importe: tarjeta });
  if (pagos.length === 0) return;
  registrarVenta(pagos, e.currentTarget);
});

/* ---------------- Pantalla: Historial ---------------- */

function formatoHora(iso) {
  const d = new Date(iso);
  return d.toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function resumenItems(items) {
  return items.map((i) => `${i.cantidad}× ${i.nombre}`).join(", ");
}

function itemHistorial(v) {
  const li = document.createElement("li");
  li.className = "historial-item" + (v.anulada ? " anulada" : "");
  li.innerHTML = `
    <div class="historial-item-top">
      <span>${formatoHora(v.fecha)}</span>
      <span class="badge">${resumenPago(v)}</span>
    </div>
    <div class="historial-item-items">${resumenItems(v.items)}</div>
    <div class="historial-item-bottom">
      <span class="historial-item-total">${v.total} CHF</span>
      ${
        v.anulada
          ? `<span class="badge badge-anulada">Anulada</span>`
          : v.cierre_id
          ? `<span class="badge badge-cerrada">Cerrada</span>`
          : `<button class="btn-anular" data-id="${v.id}">Anular</button>`
      }
    </div>
  `;
  return li;
}

// Agrupa las ventas por cierre_id para poder marcar en Historial dónde
// se hizo cada corte de caja, reutilizando los totales ya guardados en
// data/cierres.json en vez de recalcularlos aquí.
function agruparPorCierre(ventas, cierres) {
  const cierrePorId = new Map(cierres.map((c) => [c.id, c]));
  const pendientes = ventas
    .filter((v) => !v.cierre_id)
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

  const porCierre = new Map();
  ventas
    .filter((v) => v.cierre_id)
    .forEach((v) => {
      if (!porCierre.has(v.cierre_id)) porCierre.set(v.cierre_id, []);
      porCierre.get(v.cierre_id).push(v);
    });

  const gruposCerrados = [...porCierre.entries()]
    .map(([id, vs]) => ({
      cierre: cierrePorId.get(id) || null,
      id,
      ventas: vs.sort((a, b) => new Date(b.fecha) - new Date(a.fecha)),
    }))
    .sort((a, b) => {
      const fa = a.cierre ? new Date(a.cierre.fecha) : 0;
      const fb = b.cierre ? new Date(b.cierre.fecha) : 0;
      return fb - fa;
    });

  return { pendientes, gruposCerrados };
}

async function refrescarHistorial() {
  if (!configCompleta()) return;
  const lista = document.getElementById("historial-lista");
  setCargando(true);
  try {
    cacheVentas = await githubGetFile(rutaVentas(puntoActivo));
    cacheCierres = await githubGetFile(RUTA_CIERRES);

    lista.innerHTML = "";
    if (cacheVentas.data.length === 0) {
      lista.innerHTML = `<li class="vacio-nota">Todavía no hay ventas registradas</li>`;
      return;
    }

    const { pendientes, gruposCerrados } = agruparPorCierre(cacheVentas.data, cacheCierres.data);

    if (pendientes.length > 0) {
      const marcador = document.createElement("li");
      marcador.className = "corte-sesion-actual";
      marcador.textContent = "Sesión actual (sin cerrar)";
      lista.appendChild(marcador);
      pendientes.forEach((v) => lista.appendChild(itemHistorial(v)));
    }

    gruposCerrados.forEach((grupo) => {
      const corte = document.createElement("li");
      corte.className = "corte-cierre";
      if (grupo.cierre) {
        corte.innerHTML = `
          <span class="corte-cierre-titulo">Cierre de caja — ${formatoHora(grupo.cierre.fecha)}</span>
          <span class="corte-cierre-detalle">Cash ${grupo.cierre.total_cash} CHF · Twint ${grupo.cierre.total_twint} CHF · Total ${grupo.cierre.total} CHF · ${grupo.cierre.num_ventas} ventas</span>
        `;
      } else {
        corte.innerHTML = `<span class="corte-cierre-titulo">Cierre de caja (${grupo.id})</span>`;
      }
      lista.appendChild(corte);
      grupo.ventas.forEach((v) => lista.appendChild(itemHistorial(v)));
    });
  } catch (e) {
    console.error(e);
    mostrarToast("No se pudo cargar el historial.", true);
  } finally {
    setCargando(false);
  }
}

document.getElementById("historial-lista").addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn-anular");
  if (!btn) return;
  const id = btn.dataset.id;
  if (!confirm("¿Anular esta venta? Quedará marcada como anulada en el historial.")) return;

  setCargando(true);
  try {
    await asegurarCacheVentas();
    await guardarConReintento(
      rutaVentas(puntoActivo),
      (data) => {
        const v = data.find((x) => x.id === id);
        if (v) v.anulada = true;
        return data;
      },
      `Anular venta ${id}`,
      cacheVentasApi
    );
    mostrarToast("Venta anulada");
    refrescarHistorial();
  } catch (err) {
    console.error(err);
    mostrarToast(`No se pudo anular la venta: ${err.message}`, true);
  } finally {
    setCargando(false);
  }
});

document.getElementById("btn-refrescar-historial").addEventListener("click", refrescarHistorial);

/* ---------------- Pantalla: Cierre de caja ---------------- */

async function refrescarCierre() {
  if (!configCompleta()) return;
  setCargando(true);
  try {
    cacheVentas = await githubGetFile(rutaVentas(puntoActivo));
    cacheCierres = await githubGetFile(RUTA_CIERRES);

    const pendientes = ventasPendientes(cacheVentas.data);
    const { cash: totalCash, twint: totalTwint, tarjeta: totalTarjeta } = totalesPorMetodo(pendientes);

    document.getElementById("cierre-num-ventas").textContent = pendientes.length;
    document.getElementById("cierre-total-cash").textContent = `${totalCash} CHF`;
    document.getElementById("cierre-total-twint").textContent = `${totalTwint} CHF`;
    document.getElementById("cierre-total-tarjeta").textContent = `${totalTarjeta} CHF`;
    document.getElementById("cierre-total").textContent = `${totalCash + totalTwint + totalTarjeta} CHF`;
    document.getElementById("btn-cerrar-caja").disabled = pendientes.length === 0;

    const lista = document.getElementById("cierres-lista");
    const cierresOrdenados = [...cacheCierres.data].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    lista.innerHTML = "";
    if (cierresOrdenados.length === 0) {
      lista.innerHTML = `<li class="vacio-nota">Todavía no hay cierres</li>`;
    } else {
      cierresOrdenados.forEach((c) => {
        const li = document.createElement("li");
        li.className = "historial-item";
        li.innerHTML = `
          <div class="historial-item-top">
            <span>${formatoHora(c.fecha)}</span>
            <span>${c.num_ventas} ventas</span>
          </div>
          <div class="historial-item-items">Cash ${c.total_cash} CHF · Twint ${c.total_twint} CHF · Tarjeta ${c.total_tarjeta || 0} CHF</div>
          <div class="historial-item-bottom">
            <span class="historial-item-total">${c.total} CHF</span>
            <button class="btn-exportar-csv" data-id="${c.id}">Exportar CSV</button>
          </div>
        `;
        lista.appendChild(li);
      });
    }
  } catch (e) {
    console.error(e);
    mostrarToast("No se pudo cargar el cierre.", true);
  } finally {
    setCargando(false);
  }
}

document.getElementById("btn-refrescar-cierre").addEventListener("click", refrescarCierre);

document.getElementById("btn-cerrar-caja").addEventListener("click", async () => {
  await asegurarCacheVentas();
  const pendientes = ventasPendientes(cacheVentas.data);
  if (pendientes.length === 0) return;

  const { cash, twint, tarjeta } = totalesPorMetodo(pendientes);
  const total = cash + twint + tarjeta;

  if (!confirm(`¿Cerrar caja con ${pendientes.length} ventas (${total} CHF)? Esto pondrá el contador a cero.`)) return;

  setCargando(true);
  try {
    const cierre = construirCierre(puntoActivo, cacheVentas.data);

    await asegurarCacheCierres();
    await guardarConReintento(
      RUTA_CIERRES,
      (data) => {
        if (data.some((c) => c.id === cierre.id)) return null;
        data.push(cierre);
        return data;
      },
      `Cierre de caja ${cierre.id} (${total} CHF)`,
      cacheCierresApi
    );

    await guardarConReintento(
      rutaVentas(puntoActivo),
      (data) => {
        data.forEach((v) => {
          if (cierre.venta_ids.includes(v.id)) v.cierre_id = cierre.id;
        });
        return data;
      },
      `Marcar ventas del cierre ${cierre.id}`,
      cacheVentasApi
    );

    mostrarToast("Caja cerrada y puesta a cero");
    refrescarCierre();
  } catch (e) {
    console.error(e);
    mostrarToast(`No se pudo cerrar la caja: ${e.message}`, true);
  } finally {
    setCargando(false);
  }
});

/* ---------------- Exportar CSV de un cierre ---------------- */

function csvEscape(valor) {
  const s = String(valor === undefined || valor === null ? "" : valor);
  if (/[;"\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

document.getElementById("cierres-lista").addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn-exportar-csv");
  if (!btn) return;
  await exportarCierreCSV(btn.dataset.id);
});

async function exportarCierreCSV(cierreId) {
  setCargando(true);
  try {
    await asegurarCacheCierres();
    const cierre = cacheCierres.data.find((c) => c.id === cierreId);
    if (!cierre) throw new Error("Cierre no encontrado en la caché local.");

    await asegurarCacheVentas();
    const ventasDelCierre = cierre.venta_ids
      .map((id) => cacheVentas.data.find((v) => v.id === id))
      .filter(Boolean);

    const filas = [["Fecha", "Hora", "Artículos", "Total", "Cash", "Twint", "Tarjeta", "Anulada"]];
    ventasDelCierre.forEach((v) => {
      const d = new Date(v.fecha);
      const fecha = d.toLocaleDateString("es-ES");
      const hora = d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
      const pagos = pagosDeVenta(v);
      const cash = pagos.filter((p) => p.metodo === "Cash").reduce((s, p) => s + p.importe, 0);
      const twint = pagos.filter((p) => p.metodo === "Twint").reduce((s, p) => s + p.importe, 0);
      const tarjeta = pagos.filter((p) => p.metodo === "Tarjeta").reduce((s, p) => s + p.importe, 0);
      filas.push([fecha, hora, resumenItems(v.items), v.total, cash, twint, tarjeta, v.anulada ? "Sí" : "No"]);
    });

    filas.push([]);
    filas.push([
      "TOTALES",
      "",
      `${cierre.num_ventas} ventas`,
      cierre.total,
      cierre.total_cash,
      cierre.total_twint,
      cierre.total_tarjeta || 0,
      "",
    ]);

    const csv = filas.map((fila) => fila.map(csvEscape).join(";")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const nombreArchivo = `cierre_${cierre.fecha.slice(0, 10)}_${cierre.id}.csv`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nombreArchivo;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error(e);
    mostrarToast(`No se pudo exportar el CSV: ${e.message}`, true);
  } finally {
    setCargando(false);
  }
}

/* ---------------- Pantalla: Ajustes ---------------- */

function rellenarFormularioAjustes() {
  document.getElementById("input-owner").value = config.owner || "";
  document.getElementById("input-repo").value = config.repo || "";
  document.getElementById("input-branch").value = config.branch || "main";
  document.getElementById("input-token").value = config.token || "";
}

function limpiarOwnerRepo(ownerRaw, repoRaw) {
  let owner = ownerRaw.trim();
  let repo = repoRaw.trim();
  const match = owner.match(/github\.com\/([^\/\s]+)\/([^\/\s]+)/i) || repo.match(/github\.com\/([^\/\s]+)\/([^\/\s]+)/i);
  if (match) {
    owner = match[1];
    repo = match[2];
  }
  owner = owner.replace(/^@/, "");
  repo = repo.replace(/\.git$/i, "").replace(/^\//, "");
  return { owner, repo };
}

document.getElementById("btn-guardar-ajustes").addEventListener("click", () => {
  const { owner, repo } = limpiarOwnerRepo(
    document.getElementById("input-owner").value,
    document.getElementById("input-repo").value
  );
  const nuevo = {
    owner,
    repo,
    branch: document.getElementById("input-branch").value.trim() || "main",
    token: document.getElementById("input-token").value.trim(),
  };
  guardarConfig(nuevo);
  cacheVentas = null;
  cacheCierres = null;
  document.getElementById("ajustes-estado").textContent = "Guardado.";
  document.getElementById("ajustes-estado").className = "ajustes-estado ok";
  mostrarToast("Ajustes guardados");
});

document.getElementById("btn-probar-conexion").addEventListener("click", async () => {
  const estado = document.getElementById("ajustes-estado");
  estado.textContent = "Probando...";
  estado.className = "ajustes-estado";
  setCargando(true);
  try {
    await validarConexion();
    estado.textContent = "Conexión correcta.";
    estado.className = "ajustes-estado ok";
  } catch (e) {
    console.error(e);
    estado.textContent = e.message || "No se pudo conectar. Revisa usuario, repo, rama y token.";
    estado.className = "ajustes-estado error";
  } finally {
    setCargando(false);
  }
});

/* ---------------- Inicio ---------------- */

(async function iniciar() {
  try {
    await cargarDatosEstaticos();
    puntoActivo = resolverPuntoActivoInicial();
    renderSelectorPuntoVenta();
    renderProductosGrid();
  } catch (e) {
    console.error(e);
    mostrarToast("No se pudo cargar el catálogo de artículos o los puntos de venta.", true);
  }
  rellenarFormularioAjustes();
  renderTicket();
})();

if (!configCompleta()) {
  mostrarPantalla("ajustes");
} else {
  mostrarPantalla("venta");
}
