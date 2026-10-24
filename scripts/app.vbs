' Zastupce "Letackomat" ve Start menu: spusti aplikaci na pozadi (bez okna) a otevre ji v prohlizeci.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = root
If fso.FileExists(root & "\node.exe") Then
  node = Chr(34) & root & "\node.exe" & Chr(34)
Else
  node = "node"
End If
shell.Run node & " scripts\launcher.js start", 0, False
