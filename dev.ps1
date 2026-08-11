# 本機開發一鍵啟動：Supabase + Go API + Vite，後兩者各開獨立視窗方便分別讀 log 與 Ctrl+C。
#
#   .\dev.ps1        桌機開發。Vite 自動開啟 HTTPS 網址。
#   .\dev.ps1 -Lan   手機同網段測試。印出 Wi-Fi 區網 HTTPS 網址，桌機不自動開瀏覽器。
#
# 機密不在這裡：Go 的環境變數放 server/.env（godotenv 讀取，已 gitignore）。
# 瀏覽器只連 Vite；/api 與 /supabase 由 dev server proxy，因此本機不必覆寫 WEB_ORIGIN。
param([switch]$Lan)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if ($Lan) {
    # ponytail: 寫死 Wi-Fi 介面，這台機器另外那幾個 IP 都是 VMware/WSL/VPN 的虛擬網段，手機連不到。
    # 改用有線網路的話把 InterfaceAlias 換成 'Ethernet'。
    $ip = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias 'Wi-Fi' | Select-Object -First 1).IPAddress
    if (-not $ip) { throw "找不到 Wi-Fi 介面的 IPv4 位址，請確認已連上無線網路" }
    $url = "https://${ip}:5173"
    $viteArgs = 'run dev -- --no-open'
    Write-Host ""
    Write-Host "  手機請開：$url" -ForegroundColor Cyan
    Write-Host "  首次開啟請點「進階」→「繼續前往」，接受本機自簽憑證。" -ForegroundColor DarkGray
    Write-Host "  首次使用需以系統管理員身分開放防火牆：" -ForegroundColor DarkGray
    Write-Host "  New-NetFirewallRule -DisplayName 'app dev LAN' -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Private" -ForegroundColor DarkGray
    Write-Host ""
}
else {
    $viteArgs = 'run dev'
}

supabase start

Start-Process powershell -ArgumentList '-NoExit', '-Command',
    "`$host.UI.RawUI.WindowTitle = 'go api :8787'; Set-Location '$root\server'; go run ."

Start-Process powershell -ArgumentList '-NoExit', '-Command',
    "`$host.UI.RawUI.WindowTitle = 'vite :5173'; Set-Location '$root\web'; npm $viteArgs"
