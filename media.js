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

const encuadre = (lado, fps) =>
  `${fps ? `fps=${fps},` : ''}scale=${lado}:${lado}:force_original_aspect_ratio=decrease,` +
  `format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1`;

/** Imagen (jpg, png, webp...) -> sticker estático 512x512 de menos de 100 KB */
export async function imagenASticker(buffer) {
  return conCarpeta(async (dir) => {
    const entrada = path.join(dir, 'entrada');
    const salida = path.join(dir, 'sticker.webp');
    await fs.writeFile(entrada, buffer);
    let ultimo = null;
    for (const [q, lado] of [[85, 512], [70, 512], [55, 512], [40, 448], [30, 384]]) {
      await correr(['-i', entrada, '-frames:v', '1', '-vf', encuadre(lado),
        '-c:v', 'libwebp', '-lossless', '0', '-q:v', String(q), '-compression_level', '6', salida]);
      ultimo = await fs.readFile(salida);
      if (ultimo.length <= MAX_ESTATICO) return ultimo;
    }
    return ultimo;
  });
}

/**
 * Video o GIF -> sticker animado (y opcionalmente su audio, de la misma duración).
 * Devuelve { webp, audio, duracionMs, recortado }.
 */
export async function videoASticker(buffer, { maxSegundos = 8, conAudio = false } = {}) {
  return conCarpeta(async (dir) => {
    const entrada = path.join(dir, 'entrada');
    await fs.writeFile(entrada, buffer);
    const info = await analizar(entrada);
    if (!info.tieneVideo) throw new ErrorConversion('El archivo no tiene imagen de video.');

    const segundos = Math.max(0.5, Math.min(maxSegundos, info.duracion || maxSegundos));
    const salida = path.join(dir, 'sticker.webp');

    // De mejor a peor calidad hasta entrar en 500 KB
    const intentos = [
      [15, 60, 512], [12, 50, 512], [10, 40, 512], [10, 30, 448], [8, 25, 384], [8, 15, 320], [6, 10, 256],
    ];
    let webp = null;
    for (const [fps, q, lado] of intentos) {
      await correr(['-t', segundos.toFixed(3), '-i', entrada, '-vf', encuadre(lado, fps),
        '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', String(q), '-compression_level', '4',
        '-loop', '0', '-an', salida]);
      webp = await fs.readFile(salida);
      if (webp.length <= MAX_ANIMADO) break;
    }
    if (webp.length > MAX_ANIMADO) throw new ErrorConversion('El video es demasiado complejo para un sticker. Probá con uno más corto.');

    let audio = null;
    if (conAudio && info.tieneAudio) audio = await extraerDe(entrada, dir, segundos);

    return {
      webp,
      audio,
      duracionMs: Math.round(segundos * 1000),
      recortado: !!info.duracion && info.duracion > maxSegundos + 0.05,
    };
  });
}

async function extraerDe(entrada, dir, segundos) {
  const salida = path.join(dir, 'audio.ogg');
  const finFundido = Math.max(0, segundos - 0.15).toFixed(3);
  for (const kbps of [64, 48, 32]) {
    try {
      await correr(['-t', segundos.toFixed(3), '-i', entrada, '-vn', '-map', '0:a:0',
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

/** Agrega el nombre del paquete y el autor al sticker (metadatos EXIF de WhatsApp) */
export async function agregarDatos(webp, nombre, autor) {
  try {
    const { default: webpmux } = await import('node-webpmux');
    const img = new webpmux.Image();
    await img.load(webp);
    const json = {
      'sticker-pack-id': crypto.randomBytes(16).toString('hex'),
      'sticker-pack-name': nombre,
      'sticker-pack-publisher': autor,
      emojis: [''],
    };
    const cabecera = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
      0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
    const datos = Buffer.from(JSON.stringify(json), 'utf8');
    const exif = Buffer.concat([cabecera, datos]);
    exif.writeUIntLE(datos.length, 14, 4);
    img.exif = exif;
    return await img.save(null);
  } catch {
    return webp; // si falla, se manda sin nombre/autor
  }
}
