$ErrorActionPreference = 'Stop'
$dashboardRoot = $PSScriptRoot
$dashboardUrl = 'http://127.0.0.1:3000'
try {
    $dashboardStatus = Invoke-RestMethod "$dashboardUrl/api/status" -TimeoutSec 2
    if ($dashboardStatus.application -eq 'paper-monitor') {
        Write-Output "Paper Monitor is already running at $dashboardUrl"
        exit 0
    }
    throw 'Port 3000 is occupied by a different application.'
} catch {
    if ($_.Exception.Message -eq 'Port 3000 is occupied by a different application.') { throw }
}
if (!(Test-Path -LiteralPath (Join-Path $dashboardRoot 'dist/index.html'))) {
    throw 'Build the dashboard first: npm.cmd run build'
}
$dashboardState = Join-Path $dashboardRoot '.state'
New-Item -ItemType Directory -Path $dashboardState -Force | Out-Null
$dashboardNode = (Get-Command node.exe -ErrorAction Stop).Source
$dashboardProcess = Start-Process -FilePath $dashboardNode -ArgumentList @('--import', 'tsx', 'src/server.ts') -WorkingDirectory $dashboardRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dashboardState 'dashboard.stdout.log') -RedirectStandardError (Join-Path $dashboardState 'dashboard.stderr.log')
Set-Content -LiteralPath (Join-Path $dashboardState 'dashboard.pid') -Value $dashboardProcess.Id
for ($dashboardAttempt = 0; $dashboardAttempt -lt 20; $dashboardAttempt++) {
    Start-Sleep -Milliseconds 250
    try {
        $dashboardStatus = Invoke-RestMethod "$dashboardUrl/api/status" -TimeoutSec 1
        if ($dashboardStatus.application -eq 'paper-monitor') {
            Write-Output "Paper Monitor is running in the background at $dashboardUrl (PID $($dashboardProcess.Id))."
            exit 0
        }
    } catch { }
    if ($dashboardProcess.HasExited) { break }
}
throw 'The dashboard did not start. Inspect .state/dashboard.stderr.log; no existing process was stopped.'
