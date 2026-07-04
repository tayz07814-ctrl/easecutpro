# Sets up the GPU/ML tiers for Fast Cut.
#
# The heuristic core already works on your Python 3.14 (numpy + rapidfuzz). This
# script builds a SEPARATE venv on a torch-compatible Python (3.12/3.11) and
# installs torch (CUDA), sentence-transformers, transformers, etc. — for the
# semantic, audio, and classifier tiers.
#
# Run from the repo root:   powershell -ExecutionPolicy Bypass -File fastcut\setup_ml.ps1
#
# Then point EaseCutPro at it:  set EC_FASTCUT_PYTHON to the printed python path
# (or it is auto-detected at fastcut\.venv-ml\Scripts\python.exe).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path   # ...\fastcut
$venv = Join-Path $root ".venv-ml"

function Find-Py312 {
    # prefer the py launcher; fall back to a python3.12 on PATH
    $cands = @("3.12", "3.11")
    foreach ($v in $cands) {
        try {
            $p = (& py "-$v" -c "import sys;print(sys.executable)") 2>$null
            if ($LASTEXITCODE -eq 0 -and $p) { return $p.Trim() }
        } catch {}
    }
    $g = Get-Command python3.12 -ErrorAction SilentlyContinue
    if ($g) { return $g.Source }
    return $null
}

$py = Find-Py312
if (-not $py) {
    Write-Host "No Python 3.12/3.11 found. PyTorch has no 3.14 wheels, so the GPU" -ForegroundColor Yellow
    Write-Host "tiers need 3.12. Install it (winget install Python.Python.3.12) and re-run." -ForegroundColor Yellow
    Write-Host "The heuristic Fast Cut still works without this." -ForegroundColor Yellow
    exit 1
}

Write-Host "Using interpreter: $py"
& $py -m venv $venv
$vpy = Join-Path $venv "Scripts\python.exe"

& $vpy -m pip install --upgrade pip
Write-Host "Installing PyTorch (CUDA 12.4) for the RTX 4060 Ti..."
& $vpy -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
& $vpy -m pip install -r (Join-Path $root "requirements-ml.txt")

$ok = & $vpy -c "import torch;print('cuda', torch.cuda.is_available())"
Write-Host "torch reports: $ok"
Write-Host ""
Write-Host "Done. ML venv python:" -ForegroundColor Green
Write-Host "  $vpy" -ForegroundColor Green
Write-Host "EaseCutPro auto-detects fastcut\.venv-ml; or set EC_FASTCUT_PYTHON to the path above."
