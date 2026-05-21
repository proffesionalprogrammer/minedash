Set WshShell = CreateObject("WScript.Shell")

' Start backend silently
WshShell.Run "cmd /c cd backend && node index.js", 0, False

' Start frontend silently
WshShell.Run "cmd /c cd frontend && npm run dev", 0, False

' Wait 3 seconds for the servers to spin up
WScript.Sleep 3000

' Automatically open the website in the user's default browser
WshShell.Run "http://localhost:5173/"
