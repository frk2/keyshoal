# Windows x64

Use the Windows x64 artifact from the current pull request’s **Build and verify** run. It is a portable, unsigned ZIP containing the desktop app, Chrome extension, Windows native messaging relay, and registration script. You do not need to provide a Windows machine to produce it. GitHub Actions provisions the `windows-2025` runner declared in `.github/workflows/verify.yml`.

## Install

1. Download the artifact, verify the SHA-256 of the nested `keyshoal-win32-x64.zip` against `SHA256SUMS` with PowerShell's `Get-FileHash`, and extract the entire ZIP to a folder you own. Keep the adjacent DLLs, `resources` and `chrome` folders in place.
2. Run `keyshoal.exe` as your normal account. The app stores its encrypted journal in `%LOCALAPPDATA%\Keyshoal\logins.vault`. Its directory has a protected current-user and SYSTEM ACL. Let Keyshoal create it on first launch before restoring a backup. Do not run Keyshoal or Chrome as administrator for everyday use.
3. To sync, create or join a vault with a setup code from any replica. When Windows asks about network access, choose only the private network you intend to use. No global firewall rule or cloud account is needed.

## Connect Chrome

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted `chrome\extension` folder. Copy the exact extension ID displayed there.
2. In PowerShell, from the extracted application directory, run:

   ```powershell
   .\chrome\install-chrome-host.ps1 -ExtensionId YOUR_EXTENSION_ID
   ```

   This registers the executable for that extension ID under your current user’s Chrome Native Messaging registry key. It does not require elevation. Run the same script with `-Uninstall` to remove the registration. Re-run it with the current extension ID if you move the extracted folder.
3. Open and unlock Keyshoal, visit the corresponding HTTPS site, and invoke the Keyshoal popup or press **Alt+Shift+K**. Pick the matching login and review the fields before submitting.

The current Windows build is an unsigned preview and is not listed in the Chrome Web Store. Windows may display an unsigned-app prompt. Verify the file’s source and checksum before running it.

## Build or reproduce checks

On Windows x64, use a Visual Studio x64 Developer PowerShell with the C++ build tools and Windows SDK installed, plus Node 22.22 or newer.

```powershell
npm ci
npm exec -- install-electron
npm run package:windows
npm exec -- playwright install chromium
$env:KEYSHOAL_TEST_PACKAGE = 'dist/keyshoal-win32-x64/keyshoal.exe'
$env:KEYSHOAL_EVIDENCE = 'build/windows-evidence'
$env:KEYSHOAL_TEST_POWERSHELL = 'pwsh.exe'
node tests/desktop-smoke.mjs
node tests/chrome-smoke.mjs
node tests/peer-smoke.mjs
node tests/check-evidence.mjs
node tests/windows-package-smoke.mjs dist/keyshoal-win32-x64/keyshoal.exe
```

Use a clean evidence directory for each run. The Chrome test needs OpenSSL. If it is not on your PATH, set `KEYSHOAL_TEST_OPENSSL` to the path of your OpenSSL executable, such as the one shipped by Git for Windows.

The tests use synthetic vaults and a disposable browser profile. The Chrome test installs and removes the current-user test registration, so run it in a disposable Windows account and not against an existing installed Keyshoal extension. Windows CI uses the packaged executable and its bundled extension, tests the vault ACL and hardened startup, and exercises three real Bonjour peers on the runner. See [verification coverage](verification.md) for the screenshot inventory and the limits of testing within one VM.
