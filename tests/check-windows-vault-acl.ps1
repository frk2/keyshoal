param([Parameter(Mandatory=$true)][string] $Vault)
$ErrorActionPreference = 'Stop'
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$directory = Get-Acl -LiteralPath (Split-Path -Parent $Vault)
$contents = Get-Acl -LiteralPath $Vault
if (!$directory.AreAccessRulesProtected -or $directory.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner) {
    throw 'Vault directory owner or inheritance is unsafe.'
}
foreach ($acl in @($directory, $contents)) {
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (!$rules.Count -or !($rules | Where-Object { $_.IdentityReference.Value -eq $owner })) {
        throw 'Current user does not have an explicit or inherited vault grant.'
    }
    foreach ($rule in $rules) {
        if ($rule.IdentityReference.Value -notin @($owner, 'S-1-5-18')) {
            throw 'Unexpected principal appears in the vault ACL.'
        }
    }
}
Write-Output 'Windows vault verification passed: protected current-user directory and no third-party ACL grants on its encrypted file.'
