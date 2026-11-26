// Panel del bot: lo prende, lo vigila y lo vuelve a levantar si se cae.
// Se abre en el navegador en http://localhost:3210 (el puerto se cambia en la configuración).
//   node panel.js                  -> abre el panel en el navegador
//   node panel.js --sin-navegador  -> arranca sin abrir el navegador (autoarranque con Windows)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fork, exec } from 'node:child_process';
import QRCode from 'qrcode';
import { DIR, cargarConfig, guardarConfig, PREDETERMINADA } from './config.js';
import crypto from 'node:crypto';
import { imagenASticker, videoASticker, agregarDatos, ErrorConversion } from './media.js';

const ABRIR_NAVEGADOR = !process.argv.includes('--sin-navegador');
const ARCHIVO_LOG = path.join(DIR, 'bot.log');
const ARCHIVO_HISTORIAL = path.join(DIR, 'historial.json');
const CARPETA_SESION = path.join(DIR, 'sesion');
const ES_WINDOWS = process.platform === 'win32';
const ACCESO_INICIO = ES_WINDOWS && process.env.APPDATA
  ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Bot de stickers.vbs')
  : null;

let config = cargarConfig();
const URL_PANEL = () => `http://localhost:${config.puertoPanel}`;

// ---------- Estado compartido con la página ----------
const estado = {
  bot: 'detenido',     // detenido | iniciando | conectando | esperando-qr | conectado | reconectando | sesion-cerrada | reemplazado | error
  numero: '',
  qr: null,            // imagen del QR (data URL)
  codigo: null,        // código de vinculación
  desde: null,
  reinicios: 0,
};
const registro = [];
let historial = [];
try { historial = JSON.parse(fs.readFileSync(ARCHIVO_HISTORIAL, 'utf8')); } catch { historial = []; }

const clientes = new Set();
function emitir(evento, datos) {
  const linea = `event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`;
  for (const res of clientes) res.write(linea);
}
const publicarEstado = () => emitir('estado', estado);

function anotar(texto, nivel = 'info') {
  const hora = new Date().toLocaleTimeString('es-AR');
  const entrada = { hora, texto: String(texto).trimEnd(), nivel };
  registro.push(entrada);
  if (registro.length > 400) registro.shift();
  emitir('log', entrada);
  try {
    if (fs.existsSync(ARCHIVO_LOG) && fs.statSync(ARCHIVO_LOG).size > 2 * 1024 * 1024) {
      fs.renameSync(ARCHIVO_LOG, ARCHIVO_LOG + '.viejo');
    }
    fs.appendFileSync(ARCHIVO_LOG, `[${new Date().toISOString()}] ${entrada.texto}\n`);
  } catch {}
}

// ---------- Proceso del bot ----------
let hijo = null;
let detenidoAPropósito = false;
const caidas = [];

function iniciarBot() {
  if (hijo) return;
  detenidoAPropósito = false;
  estado.bot = 'iniciando';
  estado.qr = null;
  estado.codigo = null;
  estado.desde = Date.now();
  publicarEstado();

  hijo = fork(path.join(DIR, 'index.js'), [], { cwd: DIR, silent: true });

  // Solo los errores crudos van por stderr; el registro normal llega por mensajes
  hijo.stderr.on('data', (d) => anotar(d.toString(), 'error'));
  hijo.stdout.on('data', () => {});

  hijo.on('message', async (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.tipo === 'log') anotar(m.texto);
    if (m.tipo === 'estado') {
      estado.bot = m.estado;
      if (m.numero !== undefined) estado.numero = m.numero;
      if (m.estado === 'conectado') { estado.qr = null; estado.codigo = null; }
      publicarEstado();
    }
    if (m.tipo === 'qr') {
      estado.qr = await QRCode.toDataURL(m.qr, { width: 360, margin: 2 }).catch(() => null);
      publicarEstado();
    }
    if (m.tipo === 'codigo') { estado.codigo = m.codigo; publicarEstado(); }
    if (m.tipo === 'enviado') { const p = esperandoEnvio.get(m.id); if (p) { esperandoEnvio.delete(m.id); p(m); } }
    if (m.tipo === 'hecho') {
      const item = { cuando: Date.now(), clase: m.clase, chat: String(m.chat || '').split('@')[0], detalle: m.detalle || '' };
      historial.unshift(item);
      historial = historial.slice(0, 300);
      fs.writeFile(ARCHIVO_HISTORIAL, JSON.stringify(historial), () => {});
      emitir('hecho', item);
    }
  });

  hijo.on('exit', (codigo) => {
    hijo = null;
    const ultimo = estado.bot;
    if (detenidoAPropósito) {
      estado.bot = 'detenido';
      publicarEstado();
      anotar('Bot detenido.');
      return;
    }
    if (ultimo === 'reemplazado') {
      estado.bot = 'reemplazado';
      publicarEstado();
      anotar('El bot se detuvo porque hay otra copia abierta con la misma sesión.', 'error');
      return;
    }
    // Se cayó o cerró la sesión: se vuelve a levantar solo (salvo que se caiga muchas veces seguidas)
    const ahora = Date.now();
    caidas.push(ahora);
    while (caidas.length && caidas[0] < ahora - 2 * 60 * 1000) caidas.shift();
    if (caidas.length > 5) {
      estado.bot = 'error';
      publicarEstado();
      anotar('El bot se cayó muchas veces seguidas. Lo dejo detenido: revisá el registro y tocá "Iniciar".', 'error');
      return;
    }
    estado.reinicios++;
    anotar(`El bot se cerró (código ${codigo}). Lo vuelvo a iniciar...`, ultimo === 'sesion-cerrada' ? 'info' : 'error');
    setTimeout(iniciarBot, ultimo === 'sesion-cerrada' ? 1000 : 3000);
  });
}

function detenerBot() {
  return new Promise((resolve) => {
    if (!hijo) return resolve();
    detenidoAPropósito = true;
    const h = hijo;
    const matar = setTimeout(() => { try { h.kill(); } catch {} }, 5000);
    h.once('exit', () => { clearTimeout(matar); resolve(); });
    try { h.send({ tipo: 'apagar' }); } catch { h.kill(); }
  });
}

async function reiniciarBot() {
  await detenerBot();
  iniciarBot();
}

// ---------- Autoarranque con Windows ----------
const autoarranqueActivo = () => !!ACCESO_INICIO && fs.existsSync(ACCESO_INICIO);

function ponerAutoarranque(activar) {
  if (!ACCESO_INICIO) throw new Error('El autoarranque solo está disponible en Windows.');
  if (!activar) { fs.rmSync(ACCESO_INICIO, { force: true }); return false; }
  const comillas = (s) => s.replace(/"/g, '""');
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${comillas(DIR)}"`,
    `sh.Run """${comillas(process.execPath)}"" ""${comillas(path.join(DIR, 'panel.js'))}"" --sin-navegador", 0, False`,
  ].join('\r\n');
  fs.writeFileSync(ACCESO_INICIO, vbs);
  return true;
}

// ---------- Estudio: archivos subidos y stickers creados ----------
const subidos = new Map();     // id -> { buffer, mime, cuando }
const creados = new Map();     // id -> { webp, audio, duracionMs, cuando }
const esperandoEnvio = new Map();
const nuevoId = () => crypto.randomBytes(8).toString('hex');

function limpiarViejos(mapa, max) {
  const limite = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of mapa) if (v.cuando < limite) mapa.delete(k);
  while (mapa.size > max) mapa.delete(mapa.keys().next().value);
}

function mandarAlBot(datos) {
  return new Promise((resolve) => {
    if (!hijo || estado.bot !== 'conectado') return resolve({ ok: false, error: 'El bot no está conectado a WhatsApp.' });
    const id = nuevoId();
    const t = setTimeout(() => { esperandoEnvio.delete(id); resolve({ ok: false, error: 'WhatsApp tardó demasiado en responder.' }); }, 90000);
    esperandoEnvio.set(id, (r) => { clearTimeout(t); resolve(r); });
    try { hijo.send({ tipo: 'enviar', id, ...datos }); } catch (e) { clearTimeout(t); esperandoEnvio.delete(id); resolve({ ok: false, error: e.message }); }
  });
}

// ---------- Servidor ----------
const pagina = () => fs.readFileSync(path.join(DIR, 'panel.html'));

function json(res, codigo, datos) {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(datos));
}

function leerCuerpo(req, max = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > max) { reject(new Error('El archivo es muy pesado (máx. 20 MB).')); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ruta = `${req.method} ${url.pathname}`;

  // Solo se aceptan pedidos desde esta misma PC
  const origen = req.headers.origin;
  if (req.method !== 'GET' && origen && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origen)) {
    return json(res, 403, { error: 'Origen no permitido' });
  }

  try {
    switch (ruta) {
      case 'GET /':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(pagina());

      case 'GET /eventos':
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`event: inicio\ndata: ${JSON.stringify({ estado, registro, historial: historial.slice(0, 100), config, predeterminada: PREDETERMINADA, autoarranque: autoarranqueActivo(), esWindows: ES_WINDOWS })}\n\n`);
        clientes.add(res);
        req.on('close', () => clientes.delete(res));
        return;

      case 'POST /api/iniciar': iniciarBot(); return json(res, 200, { ok: true });
      case 'POST /api/detener': await detenerBot(); return json(res, 200, { ok: true });
      case 'POST /api/reiniciar': await reiniciarBot(); return json(res, 200, { ok: true });

      case 'POST /api/cerrar-sesion':
        await detenerBot();
        fs.rmSync(CARPETA_SESION, { recursive: true, force: true });
        estado.numero = '';
        anotar('Sesión borrada. Vas a tener que vincular de nuevo.');
        iniciarBot();
        return json(res, 200, { ok: true });

      case 'POST /api/config': {
        const datos = JSON.parse((await leerCuerpo(req, 64 * 1024)).toString() || '{}');
        const puertoAntes = config.puertoPanel;
        config = guardarConfig({ ...config, ...datos });
        anotar('Configuración guardada. Reinicio el bot para aplicarla.');
        emitir('config', config);
        if (hijo || estado.bot !== 'detenido') reiniciarBot();
        return json(res, 200, { ok: true, config, cambioPuerto: config.puertoPanel !== puertoAntes });
      }

      case 'POST /api/autoarranque': {
        const { activar } = JSON.parse((await leerCuerpo(req, 1024)).toString() || '{}');
        const activo = ponerAutoarranque(!!activar);
        anotar(activo ? 'Autoarranque con Windows activado.' : 'Autoarranque con Windows desactivado.');
        return json(res, 200, { ok: true, autoarranque: activo });
      }

      case 'POST /api/historial/borrar':
        historial = [];
        fs.writeFile(ARCHIVO_HISTORIAL, '[]', () => {});
        return json(res, 200, { ok: true });

      case 'POST /api/subir': {
        // Paso 1 del estudio: se sube la foto o el video una sola vez
        const mime = String(req.headers['content-type'] || '').split(';')[0];
        const esVideo = mime.startsWith('video/') || mime === 'image/gif';
        if (!esVideo && !mime.startsWith('image/')) return json(res, 400, { error: 'Elegí una imagen, un GIF o un video.' });
        const buffer = await leerCuerpo(req);
        if (!buffer.length) return json(res, 400, { error: 'No llegó ningún archivo.' });
        const id = nuevoId();
        subidos.set(id, { buffer, mime, cuando: Date.now() });
        limpiarViejos(subidos, 5);
        return json(res, 200, { id, tipo: esVideo ? 'video' : 'imagen' });
      }

      case 'POST /api/crear': {
        // Paso 2: arma el sticker con las opciones elegidas (se puede repetir cambiando opciones)
        const o = JSON.parse((await leerCuerpo(req, 4 * 1024 * 1024)).toString() || '{}');
        const subido = subidos.get(o.id);
        if (!subido) return json(res, 400, { error: 'El archivo ya no está, volvé a elegirlo.' });
        subido.cuando = Date.now();
        const texto = o.texto ? Buffer.from(String(o.texto).replace(/^data:image\/png;base64,/, ''), 'base64') : null;
        const esVideo = subido.mime.startsWith('video/') || subido.mime === 'image/gif';
        let r;
        if (esVideo) {
          const tope = o.sonido ? config.segundosSonido : config.segundosSticker;
          r = await videoASticker(subido.buffer, {
            maxSegundos: Math.max(1, Math.min(tope, Number(o.segundos) || tope)),
            conAudio: !!o.sonido, inicio: Number(o.inicio) || 0, llenar: !!o.llenar, texto,
            volumen: o.volumen === undefined ? 1 : Number(o.volumen),
          });
        } else {
          r = { webp: await imagenASticker(subido.buffer, { llenar: !!o.llenar, texto }), audio: null, duracionMs: 0 };
        }
        const webp = agregarDatos(r.webp, config.paquete, config.autor);
        const id = nuevoId();
        creados.set(id, { webp, audio: r.audio, duracionMs: r.duracionMs, cuando: Date.now() });
        limpiarViejos(creados, 20);
        return json(res, 200, {
          id, webp: webp.toString('base64'), kb: Math.round(webp.length / 1024),
          audio: r.audio ? r.audio.toString('base64') : null, segundos: r.duracionMs / 1000,
          sinSonido: !!o.sonido && esVideo && !r.audio, animado: esVideo,
        });
      }

      case 'POST /api/enviar': {
        // Paso 3: el bot lo manda a tu propio chat de WhatsApp
        const { id } = JSON.parse((await leerCuerpo(req, 1024)).toString() || '{}');
        const c = creados.get(id);
        if (!c) return json(res, 400, { error: 'Ese sticker ya no está, volvé a crearlo.' });
        const r = await mandarAlBot({ webp: c.webp.toString('base64'), audio: c.audio ? c.audio.toString('base64') : null, duracionMs: c.duracionMs });
        return json(res, r.ok ? 200 : 409, r.ok ? { ok: true, conSonido: !!r.conSonido } : { error: r.error });
      }

      case 'POST /api/apagar':
        json(res, 200, { ok: true });
        anotar('Apagando el panel y el bot...');
        setTimeout(salir, 300);
        return;

      default:
        res.writeHead(404); res.end('No encontrado');
    }
  } catch (e) {
    const mensaje = e instanceof ErrorConversion ? e.message : (e?.message || String(e));
    anotar('Error en el panel: ' + mensaje, 'error');
    if (!res.headersSent) json(res, 500, { error: mensaje });
  }
});

function abrirNavegador() {
  const u = URL_PANEL();
  const cmd = ES_WINDOWS ? `start "" "${u}"` : process.platform === 'darwin' ? `open "${u}"` : `xdg-open "${u}"`;
  exec(cmd, () => {});
}

async function salir() {
  await detenerBot();
  for (const c of clientes) try { c.end(); } catch {}
  process.exit(0);
}
process.on('SIGINT', salir);
process.on('SIGTERM', salir);
process.on('uncaughtException', (e) => anotar('Error grave en el panel: ' + (e?.stack || e), 'error'));
process.on('unhandledRejection', (e) => anotar('Error no manejado en el panel: ' + (e?.message || e), 'error'));

// Si el panel ya está abierto (puerto ocupado), solo se abre el navegador
servidor.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    if (ABRIR_NAVEGADOR) abrirNavegador();
    console.log(`El panel ya estaba abierto en ${URL_PANEL()}`);
    process.exit(0);
  }
  console.error('No se pudo abrir el panel:', e.message);
  process.exit(1);
});

servidor.listen(config.puertoPanel, '127.0.0.1', () => {
  console.log(`Panel abierto en ${URL_PANEL()}`);
  anotar(`Panel iniciado en ${URL_PANEL()}`);
  iniciarBot();
  if (ABRIR_NAVEGADOR) abrirNavegador();
});
