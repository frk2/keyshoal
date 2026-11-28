# Desktop and Chrome visual verification

The **Build and verify** workflow publishes two evidence archives alongside the binaries. Open the relevant pull request’s latest run and download `keyshoal-linux-smoke-screens` or `keyshoal-windows-smoke-screens` under Artifacts. Each passing desktop job checks for the same 27 non-blank PNGs.

| Screenshot group | What it records |
| --- | --- |
| `desktop-01` to `desktop-10` | Vault setup, composing and generating a login, saved and masked login, copy confirmation, Devices and Chrome bridge, lock, search, edit, delete confirmation, and the empty vault. |
| `peer-01` to `peer-07` | Two peers caught up, a change made offline, the offline conflict picker, the choice persisting after locking and reopening offline, the choice arriving at another peer with the original device paused, an offline deletion, and that deletion reaching the original device. |
| `chrome-01` to `chrome-10` | The real Chrome extension popup choosing a login, fill confirmation, the actual form with its password masked, wrong-origin refusal, unsafe-target and registration-form refusal, a conflict blocking autofill, autofill after resolving the conflict, and refusal after deletion or lock. |

Those flows exercise the actual packaged Linux and Windows executables and the extension and native messaging host bundled with them. Chrome is Chrome for Testing with a disposable profile and an isolated HTTPS fixture. Add, edit, delete, and conflict resolution happen in the desktop app. The extension offers autofill and reports when it cannot fill.

Pairing tests decode the generated QR internally and use its setup code on another replica. No security key, setup QR, or revealed password is captured. The harness uses temporary vaults and Chromium’s loopback-only debugging channel to drive the packaged app. It does not alter packaging fuses or add a test interface to Keyshoal.

Each runner exercises multiple independent app processes and vault files using real Bonjour discovery and authenticated TCP exchange. Offline is simulated by pausing sync in the UI. This does not verify discovery across separate physical machines, Windows 11 firewall prompts, access-point isolation, or cross-platform Wi-Fi interoperability. Linux CI also starts the package with its OS renderer sandbox in place. See [Linux setup](linux.md) and [Windows setup and test commands](windows.md).
