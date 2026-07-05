' Double-click this to start the Clawd dev widget with no terminal window.
' Requires Node.js installed. First run installs dependencies (shows a window
' once); after that it launches silently. Lives in scripts/, so it targets the
' PROJECT ROOT (the parent of this script's folder).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = here

If Not fso.FolderExists(fso.BuildPath(here, "node_modules")) Then
  MsgBox "First-time setup: installing the widget. This window will close when done.", 64, "Clawd widget"
  sh.Run "cmd /c npm install", 1, True
End If

' 0 = hidden window; widget runs in the background
sh.Run "cmd /c npx electron .", 0, False
