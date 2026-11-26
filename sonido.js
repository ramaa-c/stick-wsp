// Envío de stickers con sonido.
//
// WhatsApp todavía no publicó este formato. Esta estructura sale de la ingeniería inversa
// que hizo la comunidad (noviembre de 2026), basada en el proyecto MIT
// github.com/coelhobugado/whatsapp-figurinhas-com-som:
//
//   Message
//    └─ campo 134: FutureProofMessage
//         └─ campo 1: Message
//              └─ campo 26: StickerMessage (WebP animado)
//                   └─ campo 26: AudioMessage (Ogg/Opus + streamingSidecar)
//
// Baileys no conoce los campos 134 ni StickerMessage.26, así que los bytes se arman acá
// y se agregan al codificar el mensaje. Si WhatsApp cambia el formato, esto puede dejar de andar.

import { createCipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { generateWAMessageFromContent, getMediaKeys, prepareWAMessageMedia, proto } from '@whiskeysockets/baileys';

const CAMPO_STICKER = 26;
const CAMPO_AUDIO_DEL_STICKER = 26;
const CAMPO_ENVOLTORIO = 134;
const CAMPO_FUTURE_PROOF = 1;
const BLOQUE_SIDECAR = 64 * 1024;

// Marca que indica qué mensaje hay que codificar con el formato de sonido.
// Es un Symbol enumerable para que sobreviva a las copias { ...mensaje } que hace Baileys.
export const MARCA = Symbol.for('bot-stickers.sticker-con-sonido');

function varint(valor) {
  const bytes = [];
  do {
    let b = valor % 128;
    valor = Math.floor(valor / 128);
    if (valor) b |= 0x80;
    bytes.push(b);
  } while (valor);
  return Buffer.from(bytes);
}

const campo = (numero, contenido) =>
  Buffer.concat([varint(numero * 8 + 2), varint(contenido.length), contenido]);

export function armarEnvoltorio(sticker, audio) {
  const bytesSticker = Buffer.concat([
    proto.Message.StickerMessage.encode(sticker).finish(),
    campo(CAMPO_AUDIO_DEL_STICKER, proto.Message.AudioMessage.encode(audio).finish()),
  ]);
  return campo(CAMPO_FUTURE_PROOF, campo(CAMPO_STICKER, bytesSticker));
}

let instalado = false;
export function instalarCodificador() {
  if (instalado) return;
  const original = proto.Message.encode;
  proto.Message.encode = function (mensaje, writer) {
    const envoltorio = mensaje?.[MARCA];
    if (!envoltorio) return original.call(proto.Message, mensaje, writer);
    // stickerMessage queda en el objeto solo para que Baileys marque el envío como sticker
    const { stickerMessage: _soloParaBaileys, ...resto } = mensaje;
    const out = original.call(proto.Message, resto, writer);
    out.uint32(CAMPO_ENVOLTORIO * 8 + 2).bytes(envoltorio);
    return out;
  };
  instalado = true;
}

// HMAC de cada bloque de 64 KB del audio cifrado (lo pide WhatsApp para reproducirlo)
async function crearSidecar(audio, mediaKey, fileEncSha256) {
  const { iv, cipherKey, macKey } = await getMediaKeys(Buffer.from(mediaKey), 'audio');
  const cifrador = createCipheriv('aes-256-cbc', cipherKey, iv);
  const cifrado = Buffer.concat([cifrador.update(audio), cifrador.final()]);
  const mac = createHmac('sha256', macKey).update(iv).update(cifrado).digest().subarray(0, 10);
  const hash = createHash('sha256').update(cifrado).update(mac).digest();
  if (hash.length !== fileEncSha256.length || !timingSafeEqual(hash, Buffer.from(fileEncSha256))) {
    throw new Error('El audio cifrado no coincide con el que se subió.');
  }
  const partes = [];
  for (let i = 0; i < cifrado.length; i += BLOQUE_SIDECAR) {
    const anterior = i === 0 ? iv : cifrado.subarray(i - 16, i);
    partes.push(createHmac('sha256', macKey).update(anterior).update(cifrado.subarray(i, i + BLOQUE_SIDECAR)).digest().subarray(0, 10));
  }
  return Buffer.concat(partes);
}

/** Sube el sticker y el audio, arma el mensaje con sonido y lo envía. Devuelve el id. */
export async function enviarStickerConSonido(sock, jid, { webp, audio, duracionMs, citado }) {
  if (!sock.user?.id) throw new Error('El bot todavía no está conectado.');
  const opciones = { upload: sock.waUploadToServer, mediaUploadTimeoutMs: 60000 };

  const visual = await prepareWAMessageMedia({ sticker: webp, isAnimated: true, width: 512, height: 512 }, opciones);
  const sonido = await prepareWAMessageMedia({
    audio, mimetype: 'audio/ogg; codecs=opus', seconds: Math.max(1, Math.ceil(duracionMs / 1000)),
  }, opciones);

  const audioMessage = sonido.audioMessage;
  if (!visual.stickerMessage || !audioMessage?.mediaKey || !audioMessage.fileEncSha256) {
    throw new Error('No se pudieron preparar los archivos del sticker.');
  }
  audioMessage.streamingSidecar = await crearSidecar(audio, audioMessage.mediaKey, audioMessage.fileEncSha256);

  const msg = generateWAMessageFromContent(jid, visual, { userJid: sock.user.id, quoted: citado });
  const contenido = msg.message;
  if (!contenido?.stickerMessage || !msg.key.id) throw new Error('No se pudo armar el mensaje.');
  contenido.stickerMessage.isAnimated = true;
  contenido[MARCA] = armarEnvoltorio(contenido.stickerMessage, audioMessage);

  instalarCodificador();
  await sock.relayMessage(jid, contenido, { messageId: msg.key.id });
  return msg.key.id;
}
