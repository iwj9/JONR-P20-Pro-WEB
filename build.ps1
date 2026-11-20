# JONR P20 Pro — Windows portable (onedir) 빌드 스크립트
# 사용: powershell -ExecutionPolicy Bypass -File .\build.ps1
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$common = @(
    "--noconfirm",
    "--clean",
    "--onedir",
    "--console",
    "--workpath", "$root\build\_work",
    "--specpath", "$root\build\_spec",
    "--add-data", "$root\static;static",
    "--hidden-import", "flask",
    "--hidden-import", "miio",
    "--hidden-import", "PIL",
    "--hidden-import", "PIL.Image",
    "--hidden-import", "Crypto",
    "--hidden-import", "Crypto.Cipher.ARC4",
    "--hidden-import", "colorama",
    "--hidden-import", "requests",
    "--collect-all", "miio"
)

$tmp = "$root\build\_tmp"
$out = "$root\dist\JONR-P20-Pro"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp, $out
New-Item -ItemType Directory -Path $out | Out-Null

Write-Host "[빌드] Web.exe ..."
pyinstaller @common --distpath "$tmp\web" --name "JONR-P20-Pro-Web" app.py

Write-Host "[빌드] Configure.exe ..."
pyinstaller @common --distpath "$tmp\configure" --name "JONR-P20-Pro-Configure" setup_tool.py

Write-Host "[패키징] 한 폴더로 합치기 ..."
Copy-Item -Force "$tmp\web\JONR-P20-Pro-Web\JONR-P20-Pro-Web.exe" "$out\JONR-P20-Pro-Web.exe"
Copy-Item -Force "$tmp\configure\JONR-P20-Pro-Configure\JONR-P20-Pro-Configure.exe" "$out\JONR-P20-Pro-Configure.exe"
Copy-Item -Recurse -Force "$tmp\web\JONR-P20-Pro-Web\_internal" "$out\_internal"

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp

Write-Host "[완료] 결과물: $out"
