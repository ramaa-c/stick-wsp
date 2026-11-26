# ChupeteBot: bot de WhatsApp para stickers

Convierte imágenes, GIFs y videos en stickers, **incluidos los stickers con sonido** 🔊.
Usa la librería Baileys: se conecta directo a WhatsApp, sin abrir Chrome.

## Instalación rápida (Windows)
1. Instalá **Node.js** (versión LTS) desde https://nodejs.org. Siguiente, siguiente, finalizar.
2. En esta página tocá el botón verde **Code → Download ZIP** y descomprimí el archivo donde quieras.
3. Entrá a la carpeta y hacé doble clic en **`Iniciar bot.vbs`**.
   - Si Windows avisa que el archivo viene de internet: clic derecho en `Iniciar bot.vbs` → Propiedades → marcá **Desbloquear** → Aceptar, y probá de nuevo.
   - La primera vez instala lo necesario (1 o 2 minutos, se ve una ventana negra).
4. Se abre el panel en el navegador con un QR. Escanealo desde tu celular:
   **WhatsApp → Dispositivos vinculados → Vincular dispositivo**.
5. ¡Listo! Mandá un video con `!ss` a cualquier chat (incluso a vos mismo).

El bot queda vinculado a **tu** WhatsApp. ffmpeg ya viene incluido, no hace falta instalar nada más.

## Cómo abrirlo
- **Doble clic en `Iniciar bot.vbs`.** La primera vez instala lo necesario (1 o 2 minutos).
  Después abre el **panel** en el navegador (http://localhost:3210) y el bot queda corriendo en segundo plano, sin consola.
- Si querés ver la consola para buscar errores, usá `Iniciar con consola.bat`.
- Si el panel ya estaba abierto, el doble clic solo vuelve a abrir la pestaña.

## El panel
- **Conexión:** muestra el QR (o el código de vinculación) y el estado del bot.
- **Actividad:** cuántos stickers se hicieron y para quién.
- **Fábrica de stickers:** soltás una foto o video, elegís encuadre (completo o llenar), le ponés texto,
  elegís el tramo del video y si va con sonido. Ves cómo queda y con **📲 Mandármelo** el bot te lo manda
  a tu chat "Mensaje para mí". Desde ahí lo mantenés apretado → ⭐ Favoritos y lo tenés en todos tus chats.
  También podés pegar una imagen con Ctrl+V.
- **Registro:** lo que va haciendo el bot (también se guarda en `bot.log`).
- **Configuración:** prefijo, autor, duraciones, antispam, etc. Al guardar, el bot se reinicia solo.
- **Sistema:** iniciar con Windows, desvincular WhatsApp, apagar todo.
- Si el bot se cae, el panel lo vuelve a levantar solo.

## Comandos
| Comando | Qué hace |
|---|---|
| `!s` | Con una imagen, GIF o video: devuelve el sticker (estático o animado) |
| `!ss` | Con un video con sonido: devuelve un **sticker con sonido** (se escucha al tocarlo) |
| `!audio` | Con un video: devuelve solo el audio como nota de voz |
| `!s Nombre \| Autor` | Personaliza el nombre y el autor del sticker |
| `!ayuda` | Muestra la ayuda |

- Podés mandar el comando junto con el archivo o respondiendo a un mensaje que ya lo tenga.
- Funciona también en tu propio chat ("Mensaje para mí").
- En chat privado, una imagen o video sin texto también se convierte en sticker.
- El bot reacciona al mensaje: ⏳ procesando, ✅ listo, 🔊 con sonido, ❌ error.

## Sobre los stickers con sonido
WhatsApp lanzó este formato a fines de noviembre de 2026 y **no lo documentó**. El bot lo arma
siguiendo la ingeniería inversa de la comunidad (archivo `sonido.js`). Puede dejar de andar
si WhatsApp lo cambia; en ese caso el bot manda el sticker y el audio por separado.
Para escuchar el sonido, la persona que lo recibe necesita una versión de WhatsApp que ya tenga la función.

## Configuración
Se cambia desde el panel y se guarda en `config.json`.

## Importante
- Usa WhatsApp de forma no oficial. **Conviene usar un número secundario**: WhatsApp puede bloquear números que usan bots.
- La PC tiene que estar prendida y el bot corriendo para que responda.
- Para cerrar la sesión, usá "Desvincular WhatsApp" en el panel (o desvinculá el dispositivo desde el celular).
- Créditos: el formato del sticker con sonido está basado en
  [coelhobugado/whatsapp-figurinhas-com-som](https://github.com/coelhobugado/whatsapp-figurinhas-com-som) (licencia MIT).
