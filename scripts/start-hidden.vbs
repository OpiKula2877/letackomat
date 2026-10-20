' Spustí Letáčkomat na pozadí bez okna (volá se z tlačítka "Spustit server" v aplikaci).
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = root
shell.Run "cmd /c node scripts\launcher.js start --no-open", 0, False
