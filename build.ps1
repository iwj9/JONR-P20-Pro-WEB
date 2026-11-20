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
    "--distpath", "dist",
    "--workpath", "build",
    "--specpath", "build",
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

Write-Host "[빌드] JONR-P20-Pro-Web.exe ..."
pyinstaller @common --name "JONR-P20-Pro-Web" app.py

Write-Host "[빌드] JONR-P20-Pro-Configure.exe ..."
pyinstaller @common --name "JONR-P20-Pro-Configure" setup_tool.py

Write-Host "[완료] 결과물: $root\dist"
