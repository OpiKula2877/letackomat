' Spusti Letackomat na pozadi bez okna (tlacitko "Spustit server" v aplikaci, po prihlaseni do Windows).
' Pouzije node.exe z instalatoru (vedle aplikace), jinak node z PATH.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = root
If fso.FileExists(root & "\node.exe") Then
  node = Chr(34) & root & "\node.exe" & Chr(34)
Else
  node = "node"
End If
shell.Run node & " scripts\launcher.js start --no-open", 0, False
