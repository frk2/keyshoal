# Build and verify iOS

The app uses Expo SDK 58, an in-app camera scanner, Secure Store, and a small Swift Expo module for pinned TLS and atomic local storage. Expo Go cannot load the Swift module. No signing keys, credentials, EAS project ID or provisioning profile are checked in.

## Verified from Linux

Run from the repository root.

```sh
npm ci
EXPO_NO_TELEMETRY=1 npm run export:ios
EXPO_NO_TELEMETRY=1 npm exec --workspace @keyshoal/mobile -- expo prebuild --platform ios --no-install
npm exec --workspace @keyshoal/mobile -- expo-modules-autolinking resolve --platform apple
```

Metro produces an iOS Hermes JavaScript bundle under `mobile/dist`. Prebuild generates the native project, and the resolver must include `KeyshoalNative` / `KeyshoalNativeModule`. None of these compile Swift, run on iOS, or produce a signed IPA. GitHub’s macOS review job compiles and archives an unsigned Apple Silicon simulator app without signing credentials. On a Mac, extract the successful simulator artifact and run `xcrun simctl install booted Keyshoal.app` with a simulator already open. The simulator build does not install on an iPhone.

## Build on a Mac or use EAS

From `mobile/` in the monorepo, run `npx expo run:ios` using Xcode. For an installable IPA from Linux, use the authorized Expo account, its EAS project and a matching Apple Developer team and bundle identifier. From `mobile/`, link the authorized project with `eas init`, register the test device if using ad hoc distribution, and run `eas build --platform ios --profile preview`. The `simulator` profile can validate compilation without provisioning a phone. The `production` profile is for a later store build, not needed for smoke testing. Do not commit signing credentials. See [Expo’s device-build instructions](https://docs.expo.dev/tutorial/eas/ios-development-build-for-devices/).

## Required real-device checks

- With synthetic data, scan a live desktop QR, accept the local network permission, reject an incorrect passphrase, then enrol with the correct one. Check expired, cancelled, and already claimed QR codes, and deny a connection if the server no longer presents the pinned certificate.
- Reopen while offline using only the passphrase and the enrolled phone’s Keychain. Create, generate, edit, reveal, copy and delete a test login. Confirm the background lock and 30-second local pasteboard expiry.
- Sync an offline edit and a separate desktop edit. Check both are preserved. Change the same login on both devices, resolve the conflict deliberately, and ensure revocation blocks a subsequent sync without losing local edits. Re-pair the same vault with a different desktop IP and verify no local edits were replaced.
