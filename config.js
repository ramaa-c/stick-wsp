// Configuración del bot. Se guarda en config.json y se edita desde el panel.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const ARCHIVO_CONFIG = path.join(DIR, 'config.json');

export const PREDETERMINADA = {
  prefijo: '!',
  autor: 'ChupeteBot',             // autor por defecto del sticker
  paquete: 'baquete 1',         // nombre del paquete por defecto
  soloChatsPrivados: false,     // true = no responde en grupos
  imagenSueltaEnPrivado: true,  // en privado, una imagen/video sin texto también se convierte
  maxMB: 16,                    // tamaño máximo del archivo recibido
  segundosSticker: 8,           // duración máxima del sticker animado común
  segundosSonido: 10,           // duración máxima del sticker con sonido
  esperaEntreUsosSeg: 5,        // cada persona puede pedir uno cada X segundos
  pausaEntreEnviosMs: 1500,     // pausa entre respuestas
  diagnostico: false,           // muestra en el registro cada mensaje que llega
  telefono: '',                 // vacío = QR; con número = código de vinculación
  puertoPanel: 3210,            // puerto del panel (http://localhost:3210)
};

// Límites para que nadie ponga valores que rompan el bot
const LIMITES = {
  maxMB: [1, 64], segundosSticker: [1, 10], segundosSonido: [1, 10],
  esperaEntreUsosSeg: [0, 600], pausaEntreEnviosMs: [0, 10000], puertoPanel: [1024, 65535],
};

export function normalizar(entrada = {}) {
  const c = { ...PREDETERMINADA };
  for (const [clave, base] of Object.entries(PREDETERMINADA)) {
    if (!(clave in entrada)) continue;
    const v = entrada[clave];
    if (typeof base === 'boolean') c[clave] = v === true || v === 'true' || v === 'on';
    else if (typeof base === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) {
        const [min, max] = LIMITES[clave] || [-Infinity, Infinity];
        c[clave] = Math.min(max, Math.max(min, Math.round(n)));
      }
    } else c[clave] = String(v ?? '').slice(0, 80);
  }
  c.prefijo = c.prefijo.trim().slice(0, 3) || '!';
  c.telefono = c.telefono.replace(/\D/g, '');
  return c;
}

export function cargarConfig() {
  try {
    return normalizar(JSON.parse(fs.readFileSync(ARCHIVO_CONFIG, 'utf8')));
  } catch {
    return { ...PREDETERMINADA };
  }
}

export function guardarConfig(nueva) {
  const c = normalizar(nueva);
  fs.writeFileSync(ARCHIVO_CONFIG, JSON.stringify(c, null, 2));
  return c;
}
