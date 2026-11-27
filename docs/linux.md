# Linux installation

The archive contains a portable, unsigned Linux executable and Chrome companion. Use the artifact from a successful review build and check its SHA-256 digest. Keep the application up to date because Electron security fixes are delivered with each new build.

## Ubuntu with restricted user namespaces

Ubuntu hosts that restrict unprivileged user namespaces may refuse to start an extracted Electron app. For admins who choose to install Keyshoal system-wide, the included AppArmor profile grants Chromium's user namespace sandbox to exactly the root-owned `/opt/keyshoal/keyshoal` executable. It does not change the global kernel restriction and does not require a setuid executable.

Run from the extracted Linux distribution folder on a host with AppArmor enabled. Ensure `/opt/keyshoal` is a fresh installation path and not a symlink.

```sh
sudo install -d -o root -g root -m 0755 /opt/keyshoal
sudo cp -a . /opt/keyshoal/
sudo chown -R root:root /opt/keyshoal
sudo chmod -R go-w /opt/keyshoal
sudo install -m 0644 /opt/keyshoal/docs/keyshoal.apparmor /etc/apparmor.d/keyshoal
sudo apparmor_parser -r -T /etc/apparmor.d/keyshoal
/opt/keyshoal/keyshoal
```

Ubuntu's policy controls the ability to start the sandbox. The app itself enforces sandboxed Electron renderers. Never use a password vault with the sandbox disabled. Use the Chrome extension and installer under `/opt/keyshoal/chrome` after a system-wide install so their paths are stable. Other distributions that allow Chromium’s unprivileged sandbox do not need this AppArmor profile.
