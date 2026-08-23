/* =========================================================
   Módulo compartido: config de conexión, API de GitHub con
   reintento por SHA, y ayudantes puros de venta/cierre.
   Usado por /venta/app.js y /caja/app.js.
   ========================================================= */

export const RUTA_CIERRES = "data/cierres.json";
const CONFIG_KEY = "caja_evento_config";

export function rutaVentas(punto) {
  return `data/ventas_${punto}.json`;
}

/* ---------------- Config ---------------- */

function cargarConfigInicial() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
  } catch (e) {
    return {};
  }
}

export let config = cargarConfigInicial();

export function guardarConfig(c) {
  config = c;
  localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
}

export function configCompleta() {
  return config.owner && config.repo && config.branch && config.token;
}

/* ---------------- Utilidades base64 (UTF-8 safe) ---------------- */

export function b64Encode(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (m, p1) =>
    String.fromCharCode("0x" + p1)
  ));
}

export function b64Decode(str) {
  return decodeURIComponent(
    atob(str)
      .split("")
      .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
      .join("")
  );
}

/* ---------------- Identificadores ---------------- */

export function generarId(prefijo) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefijo}_${crypto.randomUUID()}`;
  }
  return `${prefijo}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/* ---------------- GitHub API ---------------- */

function apiUrl(path) {
  return `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${path}`;
}

export async function validarConexion() {
  const resRepo = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}`, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (resRepo.status === 401) {
    throw new Error("Token inválido o caducado (401).");
  }
  if (resRepo.status === 404) {
    throw new Error("Repositorio no encontrado, o el token no tiene acceso a él (404). Revisa usuario y repositorio.");
  }
  if (!resRepo.ok) {
    throw new Error(`Error comprobando el repositorio (${resRepo.status}).`);
  }
  const repoJson = await resRepo.json();
  if (repoJson.permissions && repoJson.permissions.push === false) {
    throw new Error("El token no tiene permiso de escritura (push) en este repositorio.");
  }

  const resBranch = await fetch(
    `https://api.github.com/repos/${config.owner}/${config.repo}/branches/${encodeURIComponent(config.branch)}`,
    {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/vnd.github+json",
      },
    }
  );
  if (resBranch.status === 404) {
    throw new Error(`La rama "${config.branch}" no existe en este repositorio.`);
  }
  if (!resBranch.ok) {
    throw new Error(`Error comprobando la rama (${resBranch.status}).`);
  }

  // Comprobación real de escritura: el permiso "push" del repo (arriba) refleja el
  // rol de la cuenta, no lo que el token en sí tiene concedido. Un fine-grained PAT
  // puede leer perfectamente y aun así no tener permiso de Contents: Read and write,
  // lo cual solo se detecta intentando escribir de verdad.
  const RUTA_TEST = "data/.conexion_test.json";
  let shaTest = null;
  const resGetTest = await fetch(`${apiUrl(RUTA_TEST)}?ref=${encodeURIComponent(config.branch)}`, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (resGetTest.ok) {
    shaTest = (await resGetTest.json()).sha;
  }

  const bodyTest = {
    message: "Test de conexión (Probar conexión en Ajustes)",
    content: b64Encode(JSON.stringify({ ok: true, ts: new Date().toISOString() })),
    branch: config.branch,
  };
  if (shaTest) bodyTest.sha = shaTest;

  const resPutTest = await fetch(apiUrl(RUTA_TEST), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyTest),
  });
  if (resPutTest.status === 403) {
    throw new Error(
      'El token no tiene permiso de escritura en Contents (403 "Resource not accessible by personal access token"). ' +
        "Revisa en GitHub el token: Repository permissions → Contents debe estar en \"Read and write\"."
    );
  }
  if (!resPutTest.ok) {
    const texto = await resPutTest.text().catch(() => "");
    throw new Error(`Error probando escritura (${resPutTest.status}): ${texto}`);
  }
}

export async function githubGetFile(path) {
  const res = await fetch(`${apiUrl(path)}?ref=${encodeURIComponent(config.branch)}`, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (res.status === 404) {
    return { sha: null, data: [] };
  }
  if (!res.ok) {
    throw new Error(`Error leyendo ${path}: ${res.status}`);
  }
  const json = await res.json();
  const contenido = b64Decode(json.content.replace(/\n/g, ""));
  let data;
  try {
    data = JSON.parse(contenido);
  } catch (e) {
    data = [];
  }
  return { sha: json.sha, data };
}

export async function githubPutFile(path, data, sha, mensaje) {
  const body = {
    message: mensaje,
    content: b64Encode(JSON.stringify(data, null, 2)),
    branch: config.branch,
  };
  if (sha) body.sha = sha;

  const res = await fetch(apiUrl(path), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const texto = await res.text().catch(() => "");
    throw new Error(`Error guardando ${path}: ${res.status} ${texto}`);
  }
  const json = await res.json();
  return json.content.sha;
}

/* Guarda con reintento si el sha ha cambiado entre-tanto (409).
   mutarFn puede devolver null para indicar "nada que escribir" (p. ej. un
   intento anterior ya se aplicó de verdad aunque el cliente no lo supiera),
   en cuyo caso se trata como éxito sin llamar a la API. */
export async function guardarConReintento(path, mutarFn, mensaje, cache, onReintento) {
  for (let intento = 0; intento < 3; intento++) {
    const actual = cache.get();
    const nuevoData = mutarFn(JSON.parse(JSON.stringify(actual.data)));
    if (nuevoData === null) return actual.data;
    try {
      const nuevoSha = await githubPutFile(path, nuevoData, actual.sha, mensaje);
      cache.set({ sha: nuevoSha, data: nuevoData });
      return nuevoData;
    } catch (e) {
      if (String(e.message).includes("409") && intento < 2) {
        if (onReintento) onReintento(intento + 1);
        const fresco = await githubGetFile(path);
        cache.set(fresco);
        continue;
      }
      throw e;
    }
  }
}

/* ---------------- Modelo: pagos por venta ---------------- */

// Ventas antiguas no tienen "pagos"; se derivan de metodo_pago/total para
// que todo el código de arriba (historial, cierre, CSV) pueda asumir siempre
// que existe el array "pagos", sin migrar el JSON histórico.
export function pagosDeVenta(v) {
  if (Array.isArray(v.pagos) && v.pagos.length > 0) return v.pagos;
  return [{ metodo: v.metodo_pago, importe: v.total }];
}

export function totalesPorMetodo(ventas) {
  let cash = 0;
  let twint = 0;
  let tarjeta = 0;
  ventas.forEach((v) => {
    pagosDeVenta(v).forEach((p) => {
      if (p.metodo === "Cash") cash += p.importe;
      else if (p.metodo === "Twint") twint += p.importe;
      else if (p.metodo === "Tarjeta") tarjeta += p.importe;
    });
  });
  return { cash, twint, tarjeta };
}

export function resumenPago(v) {
  const pagos = pagosDeVenta(v);
  if (pagos.length <= 1) return pagos[0].metodo;
  return pagos.map((p) => `${p.metodo} ${p.importe}`).join(" / ");
}

export function ventasPendientes(ventas) {
  return ventas.filter((v) => !v.anulada && !v.cierre_id);
}

// Construye el objeto de cierre para un punto de venta a partir de SUS
// ventas. Centralizado aquí para que /venta/ (que puede cerrar su propio
// punto activo) y /caja/ (que cierra cualquier punto desde la vista
// consolidada) generen cierres con exactamente la misma forma y el mismo
// punto_venta_id, y para no repetir la regla de num_ventas/venta_ids en
// dos sitios que podrían divergir.
export function construirCierre(puntoId, ventasDelPunto) {
  const pendientes = ventasPendientes(ventasDelPunto);
  const { cash, twint, tarjeta } = totalesPorMetodo(pendientes);
  // El cierre incluye también las ventas anuladas sin cierre_id (aunque no
  // sumen en los totales) para que queden agrupadas en su sesión y no se
  // muestren como "sesión actual" para siempre en el Historial.
  const sinCerrar = ventasDelPunto.filter((v) => !v.cierre_id);
  return {
    id: generarId("c"),
    punto_venta_id: puntoId,
    fecha: new Date().toISOString(),
    total_cash: cash,
    total_twint: twint,
    total_tarjeta: tarjeta,
    total: cash + twint + tarjeta,
    num_ventas: pendientes.length,
    venta_ids: sinCerrar.map((v) => v.id),
  };
}
