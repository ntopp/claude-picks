' Starts claude-picks (server + dashboard) with no console window.
' Run by the "Claude Picks dashboard" Windows scheduled task at logon; the supervisor
' (scripts\start-all.mjs) restarts either process if it exits. Logs: data\logs\.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\nrtop\Documents\claude-picks"
' Parentheses matter: without them cmd binds "&& node ..." inside the "if", and nothing runs once the folder exists.
sh.Run "cmd /c ""(if not exist data\logs mkdir data\logs) & node scripts\start-all.mjs >> data\logs\start-all.log 2>&1""", 0, False
