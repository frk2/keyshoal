# Keyshoal

A local-first password manager for website logins. Keyshoal generates passwords, keeps them in a two-secret encrypted vault, and syncs encrypted changes between equal replicas over Wi-Fi. Every device keeps the whole vault and works offline. Chrome can fill a login from the unlocked desktop vault.

**Early preview.** The Linux binary and Chrome extension are the first tested clients. The Expo iOS app needs a native build and real-device verification. There is no Windows binary in this release. The application and protocol have not had an independent security review.

## Linux

Use the Linux archive from the review build, or build it with Node 22.22+, a C compiler, and the usual Electron GTK/NSS desktop libraries.

```sh
npm ci
npm exec -- install-electron
npm run package:linux
```

Extract `dist/keyshoal-linux-x64.tar.xz` (replace `x64` if building on another architecture), then run `./keyshoal` from the extracted folder. If Ubuntu refuses to start Electron’s sandbox, follow the [per-app AppArmor setup](docs/linux.md). Do not use `--no-sandbox` with a vault. The included build is a portable archive, not a signed package or auto-updater.

Create a vault, use a strong passphrase, and save the random security key offline **separately**. On desktop you need both to unlock. There is no account, reset service, or recovery if either is lost. Logins are saved in `${XDG_CONFIG_HOME:-~/.config}/keyshoal/logins.vault`. Copy this encrypted file while the app is closed for a backup and retain both secrets separately.

## Chrome extension

1. In Chrome, open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**. Select the extracted `chrome/extension` folder.
2. Copy the extension ID from Chrome. In the same extracted archive run `./chrome/install-chrome-host.sh YOUR_EXTENSION_ID`. The optional second argument is `chromium` or `google-chrome-for-testing` for those browser families. If Chrome starts with a custom `--user-data-dir`, pass that absolute path as the third argument. The installer uses Python 3.
3. Open and unlock Keyshoal. Open the extension on an exact matching HTTPS origin, or press **Alt+Shift+K**, then choose the login. Review the form before manually submitting it.

The desktop must run in a Linux session with a private `XDG_RUNTIME_DIR` for the browser bridge. Keep the extracted archive at the same location. If you move it, reload the unpacked extension and re-run the installer with its current ID. Keyshoal never fills HTTP, embedded frames, ambiguous forms, registration forms, or forms that explicitly post to another origin. Some custom or multi-step website forms do not fit these rules.

## iOS and sync

Create a vault on Linux or iOS. Open **Devices** on any unlocked replica and choose **Show setup QR** or **Copy setup code**. Join from the other device with that code and the same passphrase. Setup itself works offline. The new device receives existing records as soon as it discovers a peer with them over Bonjour. There is no master and no IP address to enter.

The sync indicator shows whether the local vault is offline, waiting for changes to reach peers, or synced with the authenticated peers it can currently see. **Pause sync** lets you work offline without turning off Wi-Fi. While paused, you can create, edit, delete, and review conflicts already on that device. If two devices edit the same login offline, both versions remain available. Choose a version from the vault’s conflict screen, then resume sync to share the decision. Delete removes the active login and syncs a tombstone, but does not securely erase the encrypted history.

If you used the prior unmerged hub preview, the local vault migrates its retained encrypted logins after a successful unlock. Use your intended source copy first, then enroll other devices fresh. The prior preview did not record tombstones or original edit ancestry, so it cannot reconstruct that history.

See [iOS build and device tests](docs/ios.md), [Windows handoff](docs/windows.md), and [Security design and limitations](docs/security.md).

## Development checks

```sh
npm test
npm run test:desktop
npm run test:chrome
npm run test:sync
npm run export:ios
```

Use isolated X11 for the UI tests. Screenshot evidence needs FFmpeg with X11 capture and xdotool. Chrome automation needs `xdotool`, OpenSSL, and `npm exec -- playwright install chromium`. On a machine with Xvfb, run the UI tests under `xvfb-run -a`. Set `KEYSHOAL_REQUIRE_LAN=1` to run the real Bonjour/TCP integration test. The peer UI test requires local multicast and TCP as well as X11.
