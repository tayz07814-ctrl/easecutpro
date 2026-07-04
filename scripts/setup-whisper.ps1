# Downloads a prebuilt whisper.cpp Windows binary + a ggml model so EaseCutPro
# can do real offline transcription. Run from the project root:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-whisper.ps1
# Optional: -Model small.en   (default: base.en)

param(
  [string]$Model = "base.en",
  [string]$WhisperVersion = "v1.9.0"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $root "resources\bin"
$modelDir = Join-Path $root "resources\models"
New-Item -ItemType Directory -Force $binDir | Out-Null
New-Item -ItemType Directory -Force $modelDir | Out-Null

$ProgressPreference = "SilentlyContinue"  # faster downloads

# 1) Binary --------------------------------------------------------------
$cli = Join-Path $binDir "whisper-cli.exe"
if (Test-Path $cli) {
  Write-Host "whisper-cli.exe already present, skipping binary download."
} else {
  $zipUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/$WhisperVersion/whisper-bin-x64.zip"
  $zip = Join-Path $env:TEMP "whisper-bin-x64.zip"
  Write-Host "Downloading whisper.cpp $WhisperVersion binary..."
  Invoke-WebRequest -Uri $zipUrl -OutFile $zip
  $tmp = Join-Path $env:TEMP ("whisper-extract-" + [System.Guid]::NewGuid().ToString())
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  # Copy the CLI exe (whisper-cli.exe or main.exe) plus all DLLs next to it.
  $exe = Get-ChildItem $tmp -Recurse -Include "whisper-cli.exe","main.exe" | Select-Object -First 1
  if (-not $exe) { throw "No whisper-cli.exe/main.exe found in the zip." }
  Copy-Item (Join-Path $exe.DirectoryName "*") -Destination $binDir -Recurse -Force
  if (-not (Test-Path $cli) -and (Test-Path (Join-Path $binDir "main.exe"))) {
    Copy-Item (Join-Path $binDir "main.exe") $cli -Force
  }
  Remove-Item $zip,$tmp -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Binary installed to $binDir"
}

# 2) Model ---------------------------------------------------------------
$modelFile = Join-Path $modelDir ("ggml-$Model.bin")
if (Test-Path $modelFile) {
  Write-Host "Model ggml-$Model.bin already present, skipping."
} else {
  $modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin"
  Write-Host "Downloading model ggml-$Model.bin (this can take a few minutes)..."
  Invoke-WebRequest -Uri $modelUrl -OutFile $modelFile
  Write-Host "Model installed to $modelFile"
}

Write-Host ""
Write-Host "Done. whisper-cli.exe: $(Test-Path $cli)  | model: $(Test-Path $modelFile)"
Write-Host "Restart EaseCutPro - the toolbar badge should read 'Whisper OK'."
