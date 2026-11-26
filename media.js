// Conversión de imágenes y videos a stickers, y extracción de audio.
// Usa el ffmpeg que viene con el paquete ffmpeg-static: no hace falta instalar nada aparte.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let ffmpegPath = 'ffmpeg';
try { ffmpegPath = require('ffmpeg-static') || 'ffmpeg'; } catch { /* se usa el del sistema */ }
export const FFMPEG = ffmpegPath;

// Límites de WhatsApp
export const MAX_ESTATICO = 100 * 1024;   // 100 KB
export const MAX_ANIMADO = 500 * 1024;    // 500 KB
export const MAX_AUDIO = 256 * 1024;      // 256 KB

export class ErrorConversion extends Error {}

function correr(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, ['-hide_banner', '-y', ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') return reject(new Error('No se encontró ffmpeg. Ejecutá "npm install" de nuevo.'));
          err.stderr = String(stderr || '');
          return reject(err);
        }
        resolve(String(stderr || ''));
      });
  });
}

async function conCarpeta(fn) {
  const dir = path.join(os.tmpdir(), 'bot-stickers-' + crypto.randomBytes(6).toString('hex'));
  await fs.mkdir(dir, { recursive: true });
  try { return await fn(dir); } finally { fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/** Duración en segundos y si tiene pista de audio */
async function analizar(archivo) {
  let salida = '';
  try {
    salida = await correr(['-i', archivo, '-f', 'null', '-t', '0', '-'], 30000);
  } catch (e) {
    salida = e.stderr || '';
  }
  const m = salida.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duracion = m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null;
  const tieneAudio = /Stream #\d+:\d+[^\n]*Audio:/.test(salida);
  const tieneVideo = /Stream #\d+:\d+[^\n]*Video:/.test(salida);
  return { duracion, tieneAudio, tieneVideo };
}

// Arma los filtros de ffmpeg: encuadre en 512x512 transparente y, si hay, el texto encima.
//   llenar=false: entra la imagen completa (con bordes transparentes)
//   llenar=true:  recorta al cuadrado para llenar todo el sticker
// Devuelve los argumentos de filtro y de salida para ffmpeg.
function filtros({ lado, fps, llenar, conTexto }) {
  const ajuste = llenar
    ? `scale=${lado}:${lado}:force_original_aspect_ratio=increase,crop=${lado}:${lado}`
    : `scale=${lado}:${lado}:force_original_aspect_ratio=decrease`;
  const base = `${fps ? `fps=${fps},` : ''}${ajuste},format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1`;
  if (!conTexto) return ['-vf', base];
  return ['-filter_complex',
    `[0:v]${base}[b];[1:v]scale=512:512,format=rgba[t];[b][t]overlay=0:0:format=auto:eof_action=repeat,format=rgba[v]`,
    '-map', '[v]'];
}

/**
 * Imagen (jpg, png, webp...) -> sticker estático 512x512 de menos de 100 KB.
 * Opciones: llenar (recortar al cuadrado), texto (PNG 512x512 transparente para poner encima).
 */
export async function imagenASticker(buffer, { llenar = false, texto = null } = {}) {
  return conCarpeta(async (dir) => {
    const entrada = path.join(dir, 'entrada');
    const capa = path.join(dir, 'texto.png');
    const salida = path.join(dir, 'sticker.webp');
    await fs.writeFile(entrada, buffer);
    if (texto) await fs.writeFile(capa, texto);
    let ultimo = null;
    for (const [q, lado] of [[85, 512], [70, 512], [55, 512], [40, 448], [30, 384]]) {
      await correr(['-i', entrada, ...(texto ? ['-i', capa] : []), ...filtros({ lado, llenar, conTexto: !!texto }),
        '-frames:v', '1', '-c:v', 'libwebp', '-lossless', '0', '-q:v', String(q), '-compression_level', '6', salida]);
      ultimo = await fs.readFile(salida);
      if (ultimo.length <= MAX_ESTATICO) return ultimo;
    }
    return ultimo;
  });
}

/**
 * Video o GIF -> sticker animado (y opcionalmente su audio, del mismo tramo).
 * Opciones: maxSegundos, conAudio, inicio (segundo desde donde empieza), llenar, texto (PNG).
 * Devuelve { webp, audio, duracionMs, recortado, duracionVideo }.
 */
export async function videoASticker(buffer, { maxSegundos = 8, conAudio = false, inicio = 0, llenar = false, texto = null } = {}) {
  return conCarpeta(async (dir) => {
    const entrada = path.join(dir, 'entrada');
    const capa = path.join(dir, 'texto.png');
    await fs.writeFile(entrada, buffer);
    if (texto) await fs.writeFile(capa, texto);
    const info = await analizar(entrada);
    if (!info.tieneVideo) throw new ErrorConversion('El archivo no tiene imagen de video.');

    const desde = Math.max(0, Math.min(Number(inicio) || 0, info.duracion ? Math.max(0, info.duracion - 0.5) : 0));
    const restante = info.duracion ? info.duracion - desde : maxSegundos;
    const segundos = Math.max(0.5, Math.min(maxSegundos, restante));
    const salida = path.join(dir, 'sticker.webp');
    const tramo = ['-ss', desde.toFixed(3), '-t', segundos.toFixed(3)];

    // De mejor a peor calidad hasta entrar en 500 KB
    const intentos = [
      [15, 60, 512], [12, 50, 512], [10, 40, 512], [10, 30, 448], [8, 25, 384], [8, 15, 320], [6, 10, 256],
    ];
    let webp = null;
    for (const [fps, q, lado] of intentos) {
      await correr([...tramo, '-i', entrada, ...(texto ? ['-i', capa] : []),
        ...filtros({ lado, fps, llenar, conTexto: !!texto }),
        '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', String(q), '-compression_level', '4',
        '-loop', '0', '-an', salida]);
      webp = await fs.readFile(salida);
      if (webp.length <= MAX_ANIMADO) break;
    }
    if (webp.length > MAX_ANIMADO) throw new ErrorConversion('El video es demasiado complejo para un sticker. Probá con uno más corto.');

    let audio = null;
    if (conAudio && info.tieneAudio) audio = await extraerDe(entrada, dir, segundos, desde);

    return {
      webp,
      audio,
      duracionMs: Math.round(segundos * 1000),
      recortado: !!info.duracion && restante > maxSegundos + 0.05,
      duracionVideo: info.duracion,
    };
  });
}

async function extraerDe(entrada, dir, segundos, desde = 0) {
  const salida = path.join(dir, 'audio.ogg');
  const finFundido = Math.max(0, segundos - 0.15).toFixed(3);
  for (const kbps of [64, 48, 32]) {
    try {
      await correr(['-ss', desde.toFixed(3), '-t', segundos.toFixed(3), '-i', entrada, '-vn', '-map', '0:a:0',
        '-af', `afade=t=out:st=${finFundido}:d=0.15`,
        '-c:a', 'libopus', '-b:a', `${kbps}k`, '-ac', '1', '-ar', '48000',
        '-application', 'audio', '-map_metadata', '-1', '-f', 'ogg', salida]);
    } catch (e) {
      if (/matches no streams|does not contain any stream/i.test(e.stderr || '')) return null;
      throw e;
    }
    const audio = await fs.readFile(salida);
    if (audio.length < 500) return null;
    if (audio.length <= MAX_AUDIO) return audio;
  }
  return null;
}

/** Saca solo el audio de un video, como nota de voz */
export async function extraerAudio(buffer, maxSegundos = 30) {
  return conCarpeta(async (dir) => {
    const entrada = path.join(dir, 'entrada');
    await fs.writeFile(entrada, buffer);
    const info = await analizar(entrada);
    if (!info.tieneAudio) return null;
    const segundos = Math.max(0.5, Math.min(maxSegundos, info.duracion || maxSegundos));
    const salida = path.join(dir, 'audio.ogg');
    await correr(['-t', segundos.toFixed(3), '-i', entrada, '-vn', '-map', '0:a:0',
      '-c:a', 'libopus', '-b:a', '64k', '-ac', '1', '-ar', '48000', '-f', 'ogg', salida]);
    return { audio: await fs.readFile(salida), segundos: Math.ceil(segundos) };
  });
}

/**
 * Agrega el nombre del paquete y el autor al sticker (metadatos EXIF de WhatsApp).
 *
 * Se arma a mano, sin librerías, para no tocar nada más del archivo. Una versión anterior
 * usaba node-webpmux, que al guardar borraba la marca de "tiene transparencia" (VP8X alpha)
 * en los stickers animados: el celular lo ignoraba, pero WhatsApp para Windows los dibujaba mal.
 */
export function agregarDatos(webp, nombre, autor) {
  try {
    if (webp.toString('ascii', 0, 4) !== 'RIFF' || webp.toString('ascii', 8, 12) !== 'WEBP') return webp;

    // Separar los bloques del archivo
    const bloques = [];
    for (let i = 12; i + 8 <= webp.length;) {
      const tipo = webp.toString('ascii', i, i + 4);
      const largo = webp.readUInt32LE(i + 4);
      bloques.push({ tipo, datos: webp.subarray(i + 8, i + 8 + largo) });
      i += 8 + largo + (largo & 1);
    }

    // Armar el bloque EXIF con el JSON que lee WhatsApp
    const json = Buffer.from(JSON.stringify({
      'sticker-pack-id': crypto.randomBytes(16).toString('hex'),
      'sticker-pack-name': nombre,
      'sticker-pack-publisher': autor,
      emojis: [''],
    }), 'utf8');
    const cabecera = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
      0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
    const exif = Buffer.concat([cabecera, json]);
    exif.writeUInt32LE(json.length, 14);

    // ¿Tiene transparencia? (bloque ALPH suelto o dentro de algún cuadro, o un VP8L con alfa)
    const tieneAlfa = webp.includes(Buffer.from('ALPH')) ||
      bloques.some((b) => b.tipo === 'VP8L' && b.datos.length > 4 && (b.datos[4] & 0x10));

    let vp8x = bloques.find((b) => b.tipo === 'VP8X');
    if (!vp8x) {
      // Imagen simple: hay que crear la cabecera extendida con el tamaño del lienzo
      const img = bloques.find((b) => b.tipo === 'VP8 ' || b.tipo === 'VP8L');
      if (!img) return webp;
      let ancho, alto;
      if (img.tipo === 'VP8 ') { ancho = img.datos.readUInt16LE(6) & 0x3fff; alto = img.datos.readUInt16LE(8) & 0x3fff; }
      else { const v = img.datos.readUInt32LE(1); ancho = (v & 0x3fff) + 1; alto = ((v >> 14) & 0x3fff) + 1; }
      const d = Buffer.alloc(10);
      d.writeUIntLE(ancho - 1, 4, 3); d.writeUIntLE(alto - 1, 7, 3);
      vp8x = { tipo: 'VP8X', datos: d };
      bloques.unshift(vp8x);
    }
    const cab = Buffer.from(vp8x.datos);
    cab[0] |= 0x08;                 // tiene EXIF
    if (tieneAlfa) cab[0] |= 0x10;  // tiene transparencia (lo importante para WhatsApp de Windows)
    vp8x.datos = cab;

    // Fondo del lienzo animado: transparente en vez de blanco
    const anim = bloques.find((b) => b.tipo === 'ANIM');
    if (anim) { const a2 = Buffer.from(anim.datos); a2.writeUInt32LE(0, 0); anim.datos = a2; }

    const salida = bloques.filter((b) => b.tipo !== 'EXIF');
    salida.push({ tipo: 'EXIF', datos: exif });

    const partes = [];
    for (const b of salida) {
      const h = Buffer.alloc(8);
      h.write(b.tipo, 0, 'ascii'); h.writeUInt32LE(b.datos.length, 4);
      partes.push(h, b.datos);
      if (b.datos.length & 1) partes.push(Buffer.alloc(1));
    }
    const cuerpo = Buffer.concat(partes);
    const riff = Buffer.alloc(12);
    riff.write('RIFF', 0, 'ascii'); riff.writeUInt32LE(cuerpo.length + 4, 4); riff.write('WEBP', 8, 'ascii');
    return Buffer.concat([riff, cuerpo]);
  } catch {
    return webp; // si algo sale mal, se manda sin nombre/autor
  }
}
