[CmdletBinding(DefaultParameterSetName='Install')]
param(
    [Parameter(Mandatory=$true, Position=0, ParameterSetName='Install')]
    [ValidatePattern('^[a-p]{32}$')]
    [string] $ExtensionId,

    [Parameter(Mandatory=$true, ParameterSetName='Uninstall')]
    [switch] $Uninstall,

    [string] $ManifestDirectory = (Join-Path $env:LOCALAPPDATA 'KeyshoalChrome')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
$nativeName = 'com.keyshoal.desktop'
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $nativeName
$manifest = Join-Path ([IO.Path]::GetFullPath($ManifestDirectory)) ($nativeName + '.json')
if ($Uninstall) {
    if (Test-Path -LiteralPath $registryPath) {
        $registered = (Get-Item -LiteralPath $registryPath).GetValue('')
        if ($registered -eq $manifest) { Remove-Item -LiteralPath $registryPath }
    }
    if (Test-Path -LiteralPath $manifest) { Remove-Item -LiteralPath $manifest }
    return
}
if ($ExtensionId -cnotmatch '^[a-p]{32}$') { throw 'Use the exact Chrome extension ID.' }
$exe = Join-Path $PSScriptRoot 'keyshoal-chrome-host.exe'
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw 'The Windows Chrome relay must be beside this script in the extracted package.'
}
$null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($manifest)) -Force
$registration = @{
    name = $nativeName
    description = 'Keyshoal local vault bridge'
    path = $exe
    type = 'stdio'
    allowed_origins = @('chrome-extension://' + $ExtensionId + '/')
} | ConvertTo-Json
[IO.File]::WriteAllText($manifest, $registration, [Text.UTF8Encoding]::new($false))
$relativeKey = 'Software\Google\Chrome\NativeMessagingHosts\' + $nativeName
$entry = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($relativeKey)
try { $entry.SetValue('', $manifest, [Microsoft.Win32.RegistryValueKind]::String) }
finally { $entry.Dispose() }
Write-Output $manifest
