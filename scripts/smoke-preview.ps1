param(
  [Parameter(Mandatory)][ValidatePattern('^https://atmos-[a-z0-9-]+\.vercel\.app$')][string]$Preview,
  [Parameter(Mandatory)][string]$EvidencePath,
  [switch]$AfterRedeploy
)

$ErrorActionPreference = 'Stop'
if (!$env:ATMOS_PREVIEW_VIEWER_PASSWORD -or (!$AfterRedeploy -and !$env:ATMOS_PREVIEW_ADMIN_KEY)) {
  throw 'Set the preview viewer password and, for the initial run, the admin key in the environment.'
}

function Invoke-AtmosPreview {
  param([string]$Path, [int]$Status, [string]$Body, [string]$Bearer, [string]$Cookie)
  $atmosCurl = @('--silent', '--show-error', '--include')
  if ($Body) {
    $atmosCurl += @('--header', 'Content-Type: application/json', '--data-binary', '@-')
  }
  if ($Bearer) { $atmosCurl += @('--header', "Authorization: Bearer $Bearer") }
  if ($Cookie) { $atmosCurl += @('--header', "Cookie: $Cookie") }
  if ($Body) {
    $atmosRaw = $Body | & npx.cmd --yes vercel curl "$Preview/api/v1$Path" -- @atmosCurl
  } else {
    $atmosRaw = & npx.cmd --yes vercel curl "$Preview/api/v1$Path" -- @atmosCurl
  }
  $atmosResponse = $atmosRaw -join "`n"
  if ($LASTEXITCODE -ne 0 -or $atmosResponse -notmatch "(?m)^HTTP/\S+ $Status(?: |$)") {
    throw "Unexpected HTTP result from $Path. Expected $Status. Received $([regex]::Match($atmosResponse, '(?m)^HTTP/\S+ \d{3}').Value) $([regex]::Match($atmosResponse, '\{"error":"[a-z_]+"\}').Value)."
  }
  $atmosSections = $atmosResponse -split '\r?\n\r?\n', 2
  [pscustomobject]@{
    Body = $atmosSections[1] | ConvertFrom-Json -AsHashtable
    Cookie = [regex]::Match($atmosSections[0], '(?im)^set-cookie:\s*(__Host-atmos-preview=[^;]+);').Groups[1].Value
  }
}

if ($AfterRedeploy) {
  $atmosEvidence = Get-Content -LiteralPath $EvidencePath -Raw | ConvertFrom-Json -AsHashtable
  if ($atmosEvidence.initialPreview -eq $Preview) { throw 'Use the new deployment URL.' }
} else {
  if (Test-Path -LiteralPath $EvidencePath) { throw 'The evidence file already exists.' }
  $atmosDevice = (Invoke-AtmosPreview -Path '/devices' -Status 201 -Bearer $env:ATMOS_PREVIEW_ADMIN_KEY -Body '{"name":"Preview simulator"}').Body
  $atmosSample = '{"readingId":"preview-1","temperature":22.4,"humidity":48.3,"ageMs":120}'
  $atmosReceipt = (Invoke-AtmosPreview -Path '/readings' -Status 201 -Bearer $atmosDevice.deviceKey -Body $atmosSample).Body
  $atmosEvidence = [ordered]@{ initialPreview = $Preview; receipt = $atmosReceipt }
}

$atmosLogin = @{ password = $env:ATMOS_PREVIEW_VIEWER_PASSWORD } | ConvertTo-Json -Compress
$atmosSession = Invoke-AtmosPreview -Path '/session' -Status 200 -Body $atmosLogin
if (!$atmosSession.Cookie -or $atmosSession.Body.role -ne 'viewer') { throw 'Viewer sign-in failed.' }
$atmosHistory = '/devices/' + $atmosEvidence.receipt.deviceId + '/readings'
$null = Invoke-AtmosPreview -Path $atmosHistory -Status 401
$atmosRows = (Invoke-AtmosPreview -Path $atmosHistory -Status 200 -Cookie $atmosSession.Cookie).Body.readings
if ($atmosRows.Count -ne 1 -or (($atmosRows[0] | ConvertTo-Json -Compress) -cne ($atmosEvidence.receipt | ConvertTo-Json -Compress))) {
  throw 'Viewer history differs from the committed receipt.'
}
if ($AfterRedeploy) {
  $atmosEvidence.redeployedPreview = $Preview
  $atmosEvidence.afterRedeploy = $atmosRows[0]
} else {
  $atmosEvidence.beforeRedeploy = $atmosRows[0]
}
$atmosEvidence | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $EvidencePath -Encoding utf8
