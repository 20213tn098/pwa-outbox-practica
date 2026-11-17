/*
 * sw.js — Service Worker: App Shell (Cache API) + Background Sync del Outbox.
 * Regla: solo Promesas explícitas. Todas las rutas son relativas (./) para GitHub Pages.
 */

// Importar el mini-wrapper de IndexedDB en el contexto del Service Worker
importScripts('./db-helper.js');

const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';
const CACHE_STATIC_NAME = 'static-outbox-v2';
const STATIC_FILES = [
  './',
  './index.html',
  './styles.css',
  './db-helper.js',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// ---------------------------------------------------------------------------
// Ciclo de vida: install / activate
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC_NAME)
      .then((cache) => cache.addAll(STATIC_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((nombres) => Promise.all(
        nombres
          .filter((nombre) => nombre !== CACHE_STATIC_NAME)
          .map((nombre) => caches.delete(nombre))
      ))
      .then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// fetch: Cache First para el App Shell (solo GET del mismo origen).
// Los POST a la API pasan directo a la red; si fallan, app.js los encola.
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true })
      .then((enCache) => enCache || fetch(req))
      .catch(() => caches.match('./index.html'))
  );
});

// ---------------------------------------------------------------------------
// Puente SW -> UI: avisar a todas las pestañas abiertas (postMessage)
// ---------------------------------------------------------------------------
function notificarClientesActualizacion() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((clientes) => {
      clientes.forEach((cliente) => {
        cliente.postMessage({
          tipo: 'OUTBOX_SINCRONIZADO',
          timestamp: Date.now()
        });
      });
    });
}

// ---------------------------------------------------------------------------
// Motor de sincronización en segundo plano
// ---------------------------------------------------------------------------
function sincronizarPendientesSW() {
  console.log('[SW-Sync] Ejecutando barrido de transacciones pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[SW-Sync] Cola limpia. Nada por sincronizar.');
        return;
      }

      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: item.titulo,
            body: item.descripcion
          })
        })
          .then((respuesta) => {
            if (!respuesta.ok) {
              throw new Error(`Error HTTP ${respuesta.status} al sincronizar ID ${item.id}`);
            }
            return actualizarEstadoRegistro(item.id, 'sincronizado');
          });
      });

      // Se retorna toda la cadena para que event.waitUntil() sepa cuándo terminó
      return Promise.all(promesasDeEnvio)
        .then(() => notificarClientesActualizacion());
    });
}

// ---------------------------------------------------------------------------
// Evento sync: el navegador lo dispara cuando detecta conectividad estable,
// aunque la pestaña de la PWA esté cerrada.
// ---------------------------------------------------------------------------
self.addEventListener('sync', (event) => {
  console.log('[SW-Sync] Evento sync disparado con etiqueta:', event.tag);

  if (event.tag === 'sync-reportes') {
    event.waitUntil(
      sincronizarPendientesSW()
        .catch((error) => {
          console.error('[SW-Sync] Falla en sincronización; el navegador reintentará luego:', error);
          // Relanzar el error rechaza waitUntil -> el navegador programa un reintento
          throw error;
        })
    );
  }
});
