// Bot de WhatsApp para crear stickers (versión 2, con Baileys)
//   !s     imagen/GIF/video -> sticker (estático o animado)
//   !ss    video con sonido -> sticker con sonido (el nuevo de WhatsApp)
//   !audio video          -> solo el audio, como nota de voz
//   !ayuda                -> lista de comandos

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import makeWASocket, {
  Browsers, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion,
  normalizeMessageContent, useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { exec } from 'node:child_process';
import { agregarDatos, ErrorConversion, extraerAudio, FFMPEG, imagenASticker, videoASticker } from './media.js';
import { enviarStickerConSonido } from './sonido.js';
import { cargarConfig } from './config.js';

// La configuración está en config.json (se edita desde el panel).
const CONFIG = cargarConfig();

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CARPETA_SESION = path.join(DIR, 'sesion');
const P = CONFIG.prefijo;

// Si lo lanzó el panel, le avisa lo que pasa; si se corre solo, imprime en consola.
const conPanel = typeof process.send === 'function';
const avisar = (tipo, datos = {}) => { if (conPanel) try { process.send({ tipo, ...datos }); } catch {} };
const log = (...a) => {
  const texto = a.map((x) => (typeof x === 'string' ? x : x?.message || JSON.stringify(x))).join(' ');
  console.log(`[${new Date().toLocaleTimeString('es-AR')}]`, texto);
  avisar('log', { texto });
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const logger = pino({ level: 'silent' });

const AYUDA = [
  '*Bot de stickers* 🎨',
  '',
  `*${P}s*: mandalo junto con una imagen, GIF o video (o respondé con eso a uno) y te devuelvo el sticker.`,
  '',
  `*${P}ss*: mandalo con un video que tenga sonido y te devuelvo un *sticker con sonido* 🔊 (se escucha al tocarlo).`,
  '',
  `*${P}audio*: te devuelvo solo el audio de un video, como nota de voz.`,
  '',
  `Nombre y autor del sticker: *${P}s Nombre | Autor*`,
  `Límites: stickers animados de hasta ${CONFIG.segundosSticker} s, con sonido hasta ${CONFIG.segundosSonido} s, archivos de hasta ${CONFIG.maxMB} MB.`,
].join('\n');

const COMANDOS = {
  s: 'sticker', sticker: 'sticker', stiker: 'sticker', stk: 'sticker',
  ss: 'sonido', sonido: 'sonido', stickersonido: 'sonido', sa: 'sonido',
  audio: 'audio',
  ayuda: 'ayuda', help: 'ayuda', menu: 'ayuda',
};

// ---------- Lectura de mensajes ----------
function textoDe(c) {
  return (c?.conversation ?? c?.extendedTextMessage?.text ?? c?.imageMessage?.caption ??
    c?.videoMessage?.caption ?? c?.documentMessage?.caption ?? '').trim();
}

function mediaDe(c) {
  if (c?.videoMessage) return { tipo: 'video', peso: Number(c.videoMessage.fileLength ?? 0) };
  if (c?.imageMessage) return { tipo: 'imagen', peso: Number(c.imageMessage.fileLength ?? 0) };
  if (c?.stickerMessage && !c.stickerMessage.isAnimated) return { tipo: 'imagen', peso: Number(c.stickerMessage.fileLength ?? 0) };
  const doc = c?.documentMessage;
  const mime = doc?.mimetype ?? '';
  if (doc && (mime.startsWith('video/') || mime === 'image/gif')) return { tipo: 'video', peso: Number(doc.fileLength ?? 0) };
  if (doc && mime.startsWith('image/')) return { tipo: 'imagen', peso: Number(doc.fileLength ?? 0) };
  return null;
}

/** Busca el archivo en el mensaje o, si no tiene, en el mensaje citado */
function buscarMedia(msg) {
  const c = normalizeMessageContent(msg.message);
  const propia = mediaDe(c);
  if (propia) return { ...propia, msg };
  const ctx = c?.extendedTextMessage?.contextInfo ?? c?.imageMessage?.contextInfo ??
    c?.videoMessage?.contextInfo ?? c?.documentMessage?.contextInfo;
  const citado = normalizeMessageContent(ctx?.quotedMessage);
  const media = mediaDe(citado);
  if (!media || !ctx?.stanzaId) return null;
  return {
    ...media,
    msg: { key: { remoteJid: msg.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant ?? undefined }, message: citado },
  };
}

function leerComando(texto) {
  if (!texto.startsWith(P)) return { cmd: null, args: '' };
  const [primera, ...resto] = texto.slice(P.length).trim().split(/\s+/);
  return { cmd: (primera || '').toLowerCase(), args: resto.join(' ').trim() };
}

// ---------- Conexión ----------
let sock = null;
let intentosReconexion = 0;
let apagando = false;
const enviadosPorElBot = new Set();

async function conectar() {
  fs.mkdirSync(CARPETA_SESION, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(CARPETA_SESION);

  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* se usa la que trae Baileys */ }

  sock = makeWASocket({
    auth: state,
    logger,
    version,
    browser: Browsers.windows('Desktop'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  const telefono = String(CONFIG.telefono || '').replace(/\D/g, '');
  let codigoPedido = false;

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && telefono && !codigoPedido && !sock.authState.creds.registered) {
      codigoPedido = true;
      try {
        const codigo = await sock.requestPairingCode(telefono);
        avisar('codigo', { codigo: `${codigo.slice(0, 4)}-${codigo.slice(4)}` });
        log(`🔢 Código de vinculación: *** ${codigo.slice(0, 4)}-${codigo.slice(4)} ***`);
        log('En el celular: WhatsApp > Dispositivos vinculados > Vincular dispositivo > "Vincular con el número de teléfono" y escribí ese código.');
      } catch (e) {
        log('No pude pedir el código de vinculación:', e?.message || e, '— uso QR.');
      }
    }
    if (qr && !telefono) {
      avisar('estado', { estado: 'esperando-qr' });
      avisar('qr', { qr });
      if (!conPanel) {
        log('Escaneá el QR con WhatsApp > Dispositivos vinculados > Vincular dispositivo (se renueva cada ~20 s).');
        qrcode.generate(qr, { small: true });
        mostrarQrComoImagen(qr);
      }
    }
    if (connection === 'connecting') avisar('estado', { estado: 'conectando' });
    if (connection === 'open') {
      intentosReconexion = 0;
      borrarQrImagen();
      avisar('estado', { estado: 'conectado', numero: sock.user?.id?.split(':')[0]?.split('@')[0] || '' });
      log('✅ Bot listo y conectado. Mandá !ayuda en cualquier chat.');
    }
    if (connection === 'close') {
      if (apagando) return;
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (codigo === DisconnectReason.loggedOut) {
        log('⚠️ Se cerró la sesión (desde el celular o por WhatsApp). Borro la sesión vieja.');
        avisar('estado', { estado: 'sesion-cerrada' });
        fs.rmSync(CARPETA_SESION, { recursive: true, force: true });
        log('Volvé a correr npm start para escanear un QR nuevo.');
        process.exit(0);
      }
      if (codigo === DisconnectReason.connectionReplaced) {
        log('⚠️ Se abrió otra copia del bot con esta misma sesión. Cerrá una de las dos.');
        avisar('estado', { estado: 'reemplazado' });
        process.exit(1);
      }
      const espera = codigo === DisconnectReason.restartRequired ? 500 : Math.min(60000, 1000 * 2 ** Math.min(intentosReconexion++, 6));
      avisar('estado', { estado: 'reconectando' });
      log(`Conexión cerrada (código ${codigo ?? '?'}). Reconectando en ${Math.round(espera / 1000)} s...`);
      setTimeout(() => conectar().catch((e) => log('Error al reconectar:', e.message)), espera);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const m of messages) encolar(m);
  });
}

// ---------- QR como imagen ----------
const ARCHIVO_QR = path.join(DIR, 'qr.html');
let qrAbierto = false;

async function mostrarQrComoImagen(qr) {
  try {
    const dataUrl = await QRCode.toDataURL(qr, { width: 420, margin: 2 });
    const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<title>QR del bot</title><body style="font-family:sans-serif;text-align:center;background:#f4f4f4">
<h2>Escaneá con WhatsApp &gt; Dispositivos vinculados</h2><img src="${dataUrl}" alt="QR">
<p>La página se actualiza sola. Cuando el bot diga "Bot listo", cerrala.</p></body>`;
    fs.writeFileSync(ARCHIVO_QR, html);
    if (!qrAbierto) {
      qrAbierto = true;
      const cmd = process.platform === 'win32' ? `start "" "${ARCHIVO_QR}"` : process.platform === 'darwin' ? `open "${ARCHIVO_QR}"` : `xdg-open "${ARCHIVO_QR}"`;
      exec(cmd, () => {});
      log(`También abrí el QR en el navegador (${path.basename(ARCHIVO_QR)}).`);
    }
  } catch (e) {
    log('No pude guardar el QR como imagen:', e?.message || e);
  }
}

function borrarQrImagen() {
  try { fs.rmSync(ARCHIVO_QR, { force: true }); } catch {}
}

// ---------- Cola: de a un pedido por vez ----------
const INICIO = Math.floor(Date.now() / 1000);
const cola = [];
const vistos = new Set();
const ultimoUso = new Map();
let procesando = false;

function encolar(msg) {
  const id = msg.key?.id;
  const jid = msg.key?.remoteJid || '';
  if (!id || !msg.message || vistos.has(id) || enviadosPorElBot.has(id)) return;
  vistos.add(id);
  if (vistos.size > 3000) vistos.delete(vistos.values().next().value);

  const contenido = normalizeMessageContent(msg.message);
  const texto = textoDe(contenido);
  const media = mediaDe(contenido);

  let motivo = null;
  if (jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) motivo = 'estado/difusión';
  else if (Number(msg.messageTimestamp || 0) < INICIO - 10) motivo = 'mensaje viejo';
  else if (contenido?.stickerMessage || contenido?.protocolMessage || contenido?.reactionMessage) motivo = 'no es un pedido';
  else if (!texto.startsWith(P)) {
    const privado = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
    const suelta = CONFIG.imagenSueltaEnPrivado && privado && !msg.key.fromMe && texto === '' && media && !contenido?.stickerMessage;
    if (!suelta) motivo = 'sin comando';
  }

  if (CONFIG.diagnostico) {
    log('📩', JSON.stringify({ chat: jid, mio: !!msg.key.fromMe, texto: texto.slice(0, 40), media: media?.tipo ?? null }),
      motivo ? `-> se ignora (${motivo})` : '-> se procesa');
  }
  if (motivo) return;

  cola.push(msg);
  procesarCola();
}

async function procesarCola() {
  if (procesando) return;
  procesando = true;
  while (cola.length) {
    const msg = cola.shift();
    try {
      await manejar(msg);
    } catch (e) {
      log('Error inesperado:', e?.message || e);
    }
    await esperar(CONFIG.pausaEntreEnviosMs);
  }
  procesando = false;
}

// ---------- Envíos ----------
async function enviar(jid, contenido, citado) {
  const r = await sock.sendMessage(jid, contenido, citado ? { quoted: citado } : undefined);
  if (r?.key?.id) enviadosPorElBot.add(r.key.id);
  return r;
}

const responder = (msg, texto) =>
  enviar(msg.key.remoteJid, { text: texto }, msg).catch((e) => log('No pude responder:', e?.message || e));

const reaccionar = (msg, emoji) =>
  sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } }).catch(() => {});

async function descargar(origen, intentos = 3) {
  for (let i = 1; i <= intentos; i++) {
    try {
      return await downloadMediaMessage(origen, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    } catch (e) {
      log(`Falló la descarga (intento ${i}):`, e?.message || e);
      await esperar(1500 * i);
    }
  }
  return null;
}

// ---------- Lógica principal ----------
async function manejar(msg) {
  const jid = msg.key.remoteJid;
  const esGrupo = jid.endsWith('@g.us');
  if (CONFIG.soloChatsPrivados && esGrupo) return;

  const texto = textoDe(normalizeMessageContent(msg.message));
  const { cmd, args } = leerComando(texto);
  let accion = cmd ? COMANDOS[cmd] : 'sticker';
  if (!accion) return; // comando desconocido

  if (accion === 'ayuda') return responder(msg, AYUDA);

  // Antispam por persona
  const quien = msg.key.participant || jid;
  const restante = (ultimoUso.get(quien) || 0) + CONFIG.esperaEntreUsosSeg * 1000 - Date.now();
  if (restante > 0 && !msg.key.fromMe) return responder(msg, `Esperá ${Math.ceil(restante / 1000)} s antes de pedir otro 🙂`);
  ultimoUso.set(quien, Date.now());

  const fuente = buscarMedia(msg);
  if (!fuente) {
    return responder(msg, `Mandá una imagen o video junto con *${P}${cmd || 's'}*, o respondé a uno con el comando. Escribí *${P}ayuda* para ver cómo se usa.`);
  }
  if (fuente.peso > CONFIG.maxMB * 1024 * 1024) return responder(msg, `El archivo es muy pesado (máx. ${CONFIG.maxMB} MB).`);

  const esVideo = fuente.tipo === 'video';
  if ((accion === 'sonido' || accion === 'audio') && fuente.tipo !== 'video') {
    return responder(msg, accion === 'audio'
      ? 'Para sacar el audio necesito un video.'
      : `Para el sticker con sonido necesito un video que tenga audio. Para una imagen usá *${P}s*.`);
  }

  // Nombre y autor: !s Nombre | Autor
  let nombre = CONFIG.paquete;
  let autor = CONFIG.autor;
  if (args) {
    const [n, a] = args.split('|').map((x) => x.trim());
    if (n) nombre = n.slice(0, 60);
    if (a) autor = a.slice(0, 60);
  }

  await reaccionar(msg, '⏳');
  const buffer = await descargar(fuente.msg);
  if (!buffer) { await reaccionar(msg, '❌'); return responder(msg, 'No pude descargar el archivo 😕 Probá reenviarlo.'); }
  if (buffer.length > CONFIG.maxMB * 1024 * 1024) { await reaccionar(msg, '❌'); return responder(msg, `El archivo es muy pesado (máx. ${CONFIG.maxMB} MB).`); }

  try {
    if (accion === 'audio') {
      const r = await extraerAudio(buffer);
      if (!r) { await reaccionar(msg, '🔇'); return responder(msg, 'Ese video no tiene sonido 🔇'); }
      await enviar(jid, { audio: r.audio, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: r.segundos }, msg);
      await reaccionar(msg, '✅');
      avisar('hecho', { clase: 'audio', chat: jid });
      return;
    }

    if (!esVideo) {
      const webp = await agregarDatos(await imagenASticker(buffer), nombre, autor);
      await enviar(jid, { sticker: webp }, msg);
      await reaccionar(msg, '✅');
      log(`Sticker estático enviado (${jid})`);
      avisar('hecho', { clase: 'estático', chat: jid });
      return;
    }

    const conSonido = accion === 'sonido';
    const r = await videoASticker(buffer, {
      maxSegundos: conSonido ? CONFIG.segundosSonido : CONFIG.segundosSticker,
      conAudio: conSonido,
    });
    const webp = await agregarDatos(r.webp, nombre, autor);

    if (conSonido && r.audio) {
      try {
        const id = await enviarStickerConSonido(sock, jid, { webp, audio: r.audio, duracionMs: r.duracionMs, citado: msg });
        enviadosPorElBot.add(id);
        await reaccionar(msg, '🔊');
        log(`Sticker con sonido enviado (${jid})${r.recortado ? ' — video recortado' : ''}`);
        avisar('hecho', { clase: 'con sonido', chat: jid });
        if (r.recortado) await responder(msg, `El video era largo, usé los primeros ${CONFIG.segundosSonido} segundos.`);
        return;
      } catch (e) {
        // Si el formato nuevo falla, se manda el sticker y el audio por separado
        log('No se pudo enviar el sticker con sonido, mando sticker + audio:', e?.message || e);
        await enviar(jid, { sticker: webp }, msg);
        await esperar(400);
        await enviar(jid, { audio: r.audio, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: Math.ceil(r.duracionMs / 1000) });
        await reaccionar(msg, '✅');
        avisar('hecho', { clase: 'sticker + audio aparte', chat: jid });
        return;
      }
    }

    await enviar(jid, { sticker: webp }, msg);
    await reaccionar(msg, '✅');
    if (conSonido) await responder(msg, 'Listo el sticker, pero el video no tenía sonido 🔇');
    log(`Sticker animado enviado (${jid})`);
    avisar('hecho', { clase: 'animado', chat: jid });
  } catch (e) {
    await reaccionar(msg, '❌');
    avisar('hecho', { clase: 'error', chat: jid, detalle: e?.message || String(e) });
    if (e instanceof ErrorConversion) return responder(msg, e.message);
    log('Error procesando:', e?.message || e);
    if (e?.stderr) log(e.stderr.split('\n').filter(Boolean).slice(-3).join('\n'));
    responder(msg, 'Hubo un error al crear el sticker 😕' + (esVideo ? ' Probá con un video más corto.' : ''));
  }
}

// ---------- Errores globales y cierre ----------
process.on('unhandledRejection', (e) => log('Error no manejado:', e?.message || e));
process.on('uncaughtException', (e) => log('Error grave:', e?.stack || e));

function apagar() {
  if (apagando) return;
  apagando = true;
  log('Cerrando el bot...');
  try { sock?.end(undefined); } catch {}
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', apagar);
process.on('message', (m) => { if (m?.tipo === 'apagar') apagar(); });
process.on('SIGTERM', apagar);

avisar('estado', { estado: 'iniciando' });
log(`Iniciando bot... (ffmpeg ${FFMPEG === 'ffmpeg' ? 'del sistema' : 'incluido'})`);
conectar().catch((e) => { log('No se pudo iniciar:', e?.message || e); process.exit(1); });
