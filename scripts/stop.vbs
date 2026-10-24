' Zastupce "Vypnout Letackomat" ve Start menu: vypne server na pozadi.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = root
If fso.FileExists(root & "\node.exe") Then
  node = Chr(34) & root & "\node.exe" & Chr(34)
Else
  node = "node"
End If
shell.Run node & " scripts\launcher.js stop", 0, True
