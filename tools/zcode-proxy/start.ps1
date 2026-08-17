# zcode-proxy launcher
param(
  [int]$Port = 8788,
  [string]$Provider = "zai",   # zai | bigmodel
  [string]$DefaultModel = "glm-5.3"
)
$env:ZCODE_PROXY_PORT = "$Port"
$env:ZCODE_PROVIDER = $Provider
$env:ZCODE_DEFAULT_MODEL = $DefaultModel
node "$PSScriptRoot\proxy.mjs"