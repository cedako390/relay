' Starts the desktop app without a console window (double-click or pin a shortcut to this file).
' Requires a prior `pnpm build`.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir & "\packages\desktop"
sh.Run """" & dir & "\packages\desktop\node_modules\electron\dist\electron.exe"" .", 0, False
