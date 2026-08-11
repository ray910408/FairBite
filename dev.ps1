# 本機開發一鍵啟動：Supabase + Go API + Vite，後兩者各開獨立視窗方便分別讀 log 與 Ctrl+C。
#
#   .\dev.ps1        桌機開發。WEB_ORIGIN=localhost:5173，Vite 自動開瀏覽器。
#   .\dev.ps1 -Lan   手機同網段測試。WEB_ORIGIN 改為 Wi-Fi 區網 IP 並印出手機要開的網址；
#                    此時桌機不自動開瀏覽器（localhost 來源會被 CORS 擋掉，要開也得用同一個 IP）。
#
# 機密不在這裡：Go 的四個環境變數放 server/.env（godotenv 讀取，已 gitignore）。
# 本腳本只覆寫 WEB_ORIGIN — 真環境變數優先於 .env，所以這裡設的值會贏。
param([switch]$Lan)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if ($Lan) {
    # ponytail: 寫死 Wi-Fi 介面，這台機器另外那幾個 IP 都是 VMware/WSL/VPN 的虛擬網段，手機連不到。
    # 改用有線網路的話把 InterfaceAlias 換成 'Ethernet'。
    $ip = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias 'Wi-Fi' | Select-Object -First 1).IPAddress
    if (-not $ip) { throw "找不到 Wi-Fi 介面的 IPv4 位址，請確認已連上無線網路" }
    $origin = "http://${ip}:5173"
    $viteArgs = 'run dev -- --no-open'
    Write-Host ""
    Write-Host "  手機請開：$origin" -ForegroundColor Cyan
    Write-Host "  （桌機瀏覽器也要用同一個網址，localhost 會被 CORS 擋掉）" -ForegroundColor DarkGray
    Write-Host "  首次使用需以系統管理員身分開放防火牆：" -ForegroundColor DarkGray
    Write-Host "  New-NetFirewallRule -DisplayName 'app dev LAN' -Direction Inbound -Protocol TCP -LocalPort 5173,8787,54321 -Action Allow -Profile Private" -ForegroundColor DarkGray
    Write-Host ""
}
else {
    $origin = 'http://localhost:5173'
    $viteArgs = 'run dev'
}

supabase start

Start-Process powershell -ArgumentList '-NoExit', '-Command',
    "`$host.UI.RawUI.WindowTitle = 'go api :8787'; `$env:WEB_ORIGIN = '$origin'; Set-Location '$root\server'; go run ."

Start-Process powershell -ArgumentList '-NoExit', '-Command',
    "`$host.UI.RawUI.WindowTitle = 'vite :5173'; Set-Location '$root\web'; npm $viteArgs"
