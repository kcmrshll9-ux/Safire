Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
AppDir = FSO.GetParentFolderName(WScript.ScriptFullName)
Desktop = WshShell.SpecialFolders("Desktop")
ShortcutPath = Desktop & "\Safire.lnk"
If FSO.FileExists(ShortcutPath) Then FSO.DeleteFile ShortcutPath, True
Set Shortcut = WshShell.CreateShortcut(ShortcutPath)
Shortcut.TargetPath = AppDir & "\Launch Safire.bat"
Shortcut.WorkingDirectory = AppDir
Shortcut.IconLocation = AppDir & "\public\app-icon.ico,0"
Shortcut.Description = "Launch the Safire privacy-focused Markdown knowledge forge"
Shortcut.Save
WScript.Echo "Created desktop shortcut: " & ShortcutPath
