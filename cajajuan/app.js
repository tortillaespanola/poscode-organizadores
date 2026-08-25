/* =========================================================
   CAJA · JUAN — cierre de un único punto de venta independiente.
   URL propia, no enlazada desde /venta/, /caja/ ni desde ningún sitio.
   ========================================================= */

import {
  config,
  guardarConfig,
  configCompleta,
  rutaVentas,
  RUTA_CIERRES,
  githubGetFile,
  guardarConReintento,
  validarConexion,
  pagosDeVenta,
  totalesPorMetodo,
  ventasPendientes,
  construirCierre,
} from "../js/api-github.js";

// Único punto de venta de esta caja: no hay fetch de puntos_venta.json,
// "Juan" no forma parte del catálogo general de puntos.
const puntosVenta = [{ id: "juan", nombre: "Juan" }];

let ventasPorPunto = {};   // { [puntoId]: {sha, data:[...]} }
let cacheCierres = null;   // {sha, data:[...]}, único y compartido entre puntos

function nombrePunto(id) {
  return puntosVenta.find((p) => p.id === id)?.nombre || id;
}

const cacheCierresApi = {
  get: () => cacheCierres,
  set: (v) => (cacheCierres = v),
};

function ventasApiPara(puntoId) {
  return {
    get: () => ventasPorPunto[puntoId],
    set: (v) => (ventasPorPunto[puntoId] = v),
  };
}

async function asegurarCacheCierres() {
  if (!cacheCierres) cacheCierres = await githubGetFile(RUTA_CIERRES);
  return cacheCierres;
}

async function asegurarVentasPunto(puntoId) {
  if (!ventasPorPunto[puntoId]) {
    ventasPorPunto[puntoId] = await githubGetFile(rutaVentas(puntoId));
  }
  return ventasPorPunto[puntoId];
}

/* ---------------- UI: navegación de pantallas ---------------- */

const pantallas = ["cierre", "ajustes"];

function mostrarPantalla(nombre) {
  pantallas.forEach((p) => {
    document.getElementById(`pantalla-${p}`).classList.toggle("activa", p === nombre);
  });
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("activa", btn.dataset.pantalla === nombre);
  });
  if (nombre === "cierre") refrescarTodo();
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => mostrarPantalla(btn.dataset.pantalla));
});
document.getElementById("btn-ajustes").addEventListener("click", () => mostrarPantalla("ajustes"));

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

/* ---------------- Pantalla: Cierre ---------------- */

function formatoHora(iso) {
  const d = new Date(iso);
  return d.toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function resumenItems(items) {
  return items.map((i) => `${i.cantidad}× ${i.nombre}`).join(", ");
}

async function refrescarTodo() {
  if (!configCompleta()) return;
  setCargando(true);
  try {
    await asegurarCacheCierres();
    await Promise.all(puntosVenta.map((p) => asegurarVentasPunto(p.id)));
    renderPuntosCierre();
  } catch (e) {
    console.error(e);
    mostrarToast("No se pudo cargar el cierre.", true);
  } finally {
    setCargando(false);
  }
}

function renderPuntosCierre() {
  const cont = document.getElementById("puntos-cierre-lista");
  cont.innerHTML = "";

  puntosVenta.forEach((p) => {
    const ventas = ventasPorPunto[p.id]?.data || [];
    const pendientes = ventasPendientes(ventas);
    const { cash, twint, tarjeta } = totalesPorMetodo(pendientes);
    const total = cash + twint + tarjeta;

    const cierresDelPunto = (cacheCierres?.data || [])
      .filter((c) => c.punto_venta_id === p.id)
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    const card = document.createElement("div");
    card.className = "punto-cierre-card";
    card.innerHTML = `
      <div class="punto-cierre-titulo">
        <h3>${p.nombre}</h3>
        <button class="btn-secundario btn-cerrar-punto" data-punto="${p.id}" ${pendientes.length === 0 ? "disabled" : ""}>Cerrar caja</button>
      </div>
      <div class="resumen-cierre">
        <div class="resumen-fila">
          <span>Ventas pendientes de cierre</span>
          <span>${pendientes.length}</span>
        </div>
        <div class="resumen-fila">
          <span>Total Cash</span>
          <span>${cash} CHF</span>
        </div>
        <div class="resumen-fila">
          <span>Total Twint</span>
          <span>${twint} CHF</span>
        </div>
        <div class="resumen-fila">
          <span>Total Tarjeta</span>
          <span>${tarjeta} CHF</span>
        </div>
        <div class="resumen-fila resumen-fila--total">
          <span>Total caja</span>
          <span>${total} CHF</span>
        </div>
      </div>
      <ul class="historial-lista">
        ${
          cierresDelPunto.length === 0
            ? `<li class="vacio-nota">Todavía no hay cierres</li>`
            : cierresDelPunto
                .map(
                  (c) => `
              <li class="historial-item">
                <div class="historial-item-top">
                  <span>${formatoHora(c.fecha)}</span>
                  <span>${c.num_ventas} ventas</span>
                </div>
                <div class="historial-item-items">Cash ${c.total_cash} CHF · Twint ${c.total_twint} CHF · Tarjeta ${c.total_tarjeta || 0} CHF</div>
                <div class="historial-item-bottom">
                  <span class="historial-item-total">${c.total} CHF</span>
                  <button class="btn-exportar-csv" data-id="${c.id}" data-punto="${p.id}">Exportar CSV</button>
                </div>
              </li>`
                )
                .join("")
        }
      </ul>
    `;
    cont.appendChild(card);
  });
}

document.getElementById("btn-refrescar-todo").addEventListener("click", refrescarTodo);

document.getElementById("puntos-cierre-lista").addEventListener("click", async (e) => {
  const btnCerrar = e.target.closest(".btn-cerrar-punto");
  if (btnCerrar) {
    await cerrarCajaDePunto(btnCerrar.dataset.punto);
    return;
  }
  const btnCsv = e.target.closest(".btn-exportar-csv");
  if (btnCsv) {
    await exportarCierreCSV(btnCsv.dataset.id, btnCsv.dataset.punto);
  }
});

async function cerrarCajaDePunto(puntoId) {
  await asegurarVentasPunto(puntoId);
  const ventas = ventasPorPunto[puntoId].data;
  const pendientes = ventasPendientes(ventas);
  if (pendientes.length === 0) return;

  const { cash, twint, tarjeta } = totalesPorMetodo(pendientes);
  const total = cash + twint + tarjeta;
  const nombre = nombrePunto(puntoId);

  if (!confirm(`¿Cerrar caja de ${nombre} con ${pendientes.length} ventas (${total} CHF)? Esto pondrá el contador a cero.`)) return;

  setCargando(true);
  try {
    const cierre = construirCierre(puntoId, ventas);

    await asegurarCacheCierres();
    await guardarConReintento(
      RUTA_CIERRES,
      (data) => {
        if (data.some((c) => c.id === cierre.id)) return null;
        data.push(cierre);
        return data;
      },
      `Cierre de caja ${cierre.id} — ${nombre} (${total} CHF)`,
      cacheCierresApi
    );

    await guardarConReintento(
      rutaVentas(puntoId),
      (data) => {
        data.forEach((v) => {
          if (cierre.venta_ids.includes(v.id)) v.cierre_id = cierre.id;
        });
        return data;
      },
      `Marcar ventas del cierre ${cierre.id}`,
      ventasApiPara(puntoId)
    );

    mostrarToast(`Caja de ${nombre} cerrada y puesta a cero`);
    renderPuntosCierre();
  } catch (e) {
    console.error(e);
    mostrarToast(`No se pudo cerrar la caja: ${e.message}`, true);
  } finally {
    setCargando(false);
  }
}

/* ---------------- Exportar CSV de un cierre ---------------- */

function csvEscape(valor) {
  const s = String(valor === undefined || valor === null ? "" : valor);
  if (/[;"\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function exportarCierreCSV(cierreId, puntoId) {
  setCargando(true);
  try {
    await asegurarCacheCierres();
    const cierre = cacheCierres.data.find((c) => c.id === cierreId);
    if (!cierre) throw new Error("Cierre no encontrado en la caché local.");

    await asegurarVentasPunto(puntoId);
    const ventasDelPunto = ventasPorPunto[puntoId].data;
    const ventasDelCierre = cierre.venta_ids
      .map((id) => ventasDelPunto.find((v) => v.id === id))
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
    const nombreArchivo = `cierre_${nombrePunto(puntoId)}_${cierre.fecha.slice(0, 10)}_${cierre.id}.csv`;

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
  cacheCierres = null;
  ventasPorPunto = {};
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

rellenarFormularioAjustes();

if (!configCompleta()) {
  mostrarPantalla("ajustes");
} else {
  mostrarPantalla("cierre");
}
