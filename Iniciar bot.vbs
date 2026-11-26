' Abre el bot de stickers sin ventana de consola y muestra el panel en el navegador.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
carpeta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = carpeta

If sh.Run("cmd /c where node", 0, True) <> 0 Then
  MsgBox "No encontré Node.js. Instalalo desde https://nodejs.org (versión LTS) y probá de nuevo.", 48, "Bot de stickers"
  WScript.Quit
End If

If Not fso.FolderExists(carpeta & "\node_modules\@whiskeysockets") Then
  MsgBox "Es la primera vez: voy a instalar lo necesario. Se abre una ventana negra, esperá a que termine (1 o 2 minutos).", 64, "Bot de stickers"
  If sh.Run("cmd /c npm install", 1, True) <> 0 Then
    MsgBox "Falló la instalación. Abrí una terminal en esta carpeta y ejecutá: npm install", 16, "Bot de stickers"
    WScript.Quit
  End If
End If

sh.Run "node panel.js", 0, False
