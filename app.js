/*
 * app.js — Lógica de UI, envío resiliente (Patrón Outbox) y reconexión.
 * Regla: solo Promesas explícitas (new Promise / .then / .catch / Promise.all).
 */

const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';

const form = document.getElementById('form-incidencia');
const inputTitulo = document.getElementById('titulo');
const inputDescripcion = document.getElementById('descripcion');
const listaOutbox = document.getElementById('lista-outbox');
const btnPurgar = document.getElementById('btn-purgar');
const badgeRed = document.getElementById('badge-red');
const infoSync = document.getElementById('info-sync');

// ---------------------------------------------------------------------------
// Registro del Service Worker + puente de mensajes SW -> UI (postMessage)
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  // Mitad receptora del puente: el SW avisa cuando terminó de sincronizar
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.tipo === 'OUTBOX_SINCRONIZADO') {
      console.log('[UI] Confirmación recibida del Service Worker. Actualizando bandeja...');
      mostrarInfo('Sincronización en segundo plano completada.');
      renderizarColaOutbox();
    }
  });

  // Ruta RELATIVA para que el scope sea el subdirectorio de GitHub Pages
  navigator.serviceWorker.register('./sw.js')
    .then((reg) => console.log('[SW] Registrado con scope:', reg.scope))
    .catch((err) => console.error('[SW] Error al registrar:', err));
}

// ---------------------------------------------------------------------------
// Indicador de red
// ---------------------------------------------------------------------------
function actualizarIndicadorRed() {
  if (navigator.onLine) {
    badgeRed.textContent = 'En Línea';
    badgeRed.className = 'badge online';
  } else {
    badgeRed.textContent = 'Sin Conexión';
    badgeRed.className = 'badge offline';
  }
}

function mostrarInfo(texto) {
  infoSync.textContent = texto;
}

// ---------------------------------------------------------------------------
// READ: dibuja la cola de IndexedDB en pantalla
// ---------------------------------------------------------------------------
function formatearHora(ms) {
  return new Date(ms).toLocaleString('es-MX', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function renderizarColaOutbox() {
  return obtenerTodosLosRegistros()
    .then((registros) => {
      listaOutbox.innerHTML = '';

      if (registros.length === 0) {
        const vacio = document.createElement('li');
        vacio.className = 'vacio';
        vacio.textContent = 'La bandeja está vacía.';
        listaOutbox.appendChild(vacio);
        return;
      }

      // Más recientes primero
      registros
        .slice()
        .sort((a, b) => b.fechaCreacion - a.fechaCreacion)
        .forEach((item) => {
          const li = document.createElement('li');

          const info = document.createElement('div');
          const titulo = document.createElement('div');
          titulo.className = 'item-titulo';
          titulo.textContent = `#${item.id} · ${item.titulo}`;
          const hora = document.createElement('div');
          hora.className = 'item-hora';
          hora.textContent = 'Creado: ' + formatearHora(item.fechaCreacion) +
            (item.fechaSincronizacion ? ' · Sincronizado: ' + formatearHora(item.fechaSincronizacion) : '');
          info.appendChild(titulo);
          info.appendChild(hora);

          const estado = document.createElement('span');
          estado.className = 'estado ' + item.estado;
          estado.textContent = item.estado;

          li.appendChild(info);
          li.appendChild(estado);
          listaOutbox.appendChild(li);
        });
    })
    .catch((error) => {
      console.error('[UI] Error al leer IndexedDB:', error);
    });
}

// ---------------------------------------------------------------------------
// CREATE: envío resiliente con fallback a IndexedDB + registro de Background Sync
// ---------------------------------------------------------------------------
function procesarEnvioReporte(datosFormulario) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: datosFormulario.titulo, body: datosFormulario.descripcion })
  })
    .then((respuesta) => {
      if (!respuesta.ok) throw new Error('Error HTTP del servidor');
      return respuesta.json();
    })
    .then(() => {
      // Envío exitoso en vivo: bitácora local como 'sincronizado'
      mostrarInfo('Reporte enviado al servidor.');
      return guardarRegistro({
        ...datosFormulario,
        estado: 'sincronizado',
        fechaCreacion: Date.now(),
        fechaSincronizacion: Date.now()
      });
    })
    .catch(() => {
      console.warn('[Outbox] Sin conexión. Encolando en IndexedDB...');

      return guardarRegistro({
        ...datosFormulario,
        estado: 'pendiente',
        fechaCreacion: Date.now()
      })
        .then(() => {
          // Delegar el reenvío al Service Worker si hay soporte de Background Sync
          if ('serviceWorker' in navigator && 'SyncManager' in window) {
            return navigator.serviceWorker.ready
              .then((registro) => {
                console.log('[Outbox] Registrando etiqueta sync-reportes en el SW...');
                return registro.sync.register('sync-reportes');
              })
              .then(() => mostrarInfo('Sin red: reporte en cola. Se enviará en segundo plano al volver la conexión.'))
              .catch((err) => {
                // Ej. Background Sync deshabilitado por el usuario: el registro ya está a salvo en IndexedDB
                console.warn('[Outbox] No se pudo registrar sync-reportes:', err);
                mostrarInfo('Sin red: reporte en cola en IndexedDB.');
              });
          }
          mostrarInfo('Sin red: reporte en cola. Se enviará al volver la conexión.');
        });
    })
    .then(() => renderizarColaOutbox());
}

// ---------------------------------------------------------------------------
// UPDATE (fallback): reenvío desde la UI para navegadores sin SyncManager (Safari/iOS, Firefox)
// ---------------------------------------------------------------------------
function sincronizarPendientesFallback() {
  console.log('[Outbox] Buscando registros pendientes (fallback)...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[Outbox] No hay transacciones pendientes por sincronizar.');
        return;
      }

      // Arreglo de objetos -> arreglo de promesas (envío HTTP + update en IndexedDB)
      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: item.titulo, body: item.descripcion })
        })
          .then((res) => {
            if (!res.ok) throw new Error('Falla al reintentar envío');
            return actualizarEstadoRegistro(item.id, 'sincronizado');
          });
      });

      return Promise.all(promesasDeEnvio)
        .then(() => mostrarInfo(`${pendientes.length} reporte(s) sincronizado(s).`));
    })
    .then(() => renderizarColaOutbox())
    .catch((error) => {
      console.error('[Outbox] Error durante la sincronización masiva:', error);
    });
}

// ---------------------------------------------------------------------------
// Eventos de red
// ---------------------------------------------------------------------------
window.addEventListener('online', () => {
  actualizarIndicadorRed();

  // Degradación elegante: solo sincroniza desde la UI si NO hay Background Sync.
  // En Chrome lo hace sw.js; si ambos lo hicieran se enviarían POST duplicados.
  if (!('SyncManager' in window)) {
    console.log('[Outbox] Navegador sin SyncManager. Ejecutando fallback por evento online...');
    sincronizarPendientesFallback();
  }
});

window.addEventListener('offline', actualizarIndicadorRed);

// ---------------------------------------------------------------------------
// Formulario (submit)
// ---------------------------------------------------------------------------
form.addEventListener('submit', (e) => {
  e.preventDefault();

  const datos = {
    titulo: inputTitulo.value.trim(),
    descripcion: inputDescripcion.value.trim()
  };
  if (!datos.titulo || !datos.descripcion) return;

  form.reset();
  procesarEnvioReporte(datos)
    .catch((error) => console.error('[Outbox] No se pudo procesar el reporte:', error));
});

// ---------------------------------------------------------------------------
// DELETE: purgar registros ya sincronizados
// ---------------------------------------------------------------------------
btnPurgar.addEventListener('click', () => {
  obtenerTodosLosRegistros()
    .then((registros) => {
      const sincronizados = registros.filter((item) => item.estado === 'sincronizado');
      return Promise.all(sincronizados.map((item) => eliminarRegistro(item.id)))
        .then(() => mostrarInfo(`${sincronizados.length} registro(s) purgado(s).`));
    })
    .then(() => renderizarColaOutbox())
    .catch((error) => console.error('[Outbox] Error al purgar:', error));
});

// ---------------------------------------------------------------------------
// Arranque: esta promesa rescata la cola guardada en IndexedDB al abrir la página
// ---------------------------------------------------------------------------
actualizarIndicadorRed();
renderizarColaOutbox();

// Si se abre la página ya con red y quedaron pendientes en un navegador sin SyncManager
if (navigator.onLine && !('SyncManager' in window)) {
  sincronizarPendientesFallback();
}
