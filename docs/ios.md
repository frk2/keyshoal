# iOS build and peer verification

Keyshoal uses Expo SDK 58, a Swift Expo module, Apple's Bonjour/Network framework and protected local storage. Expo Go cannot load this module. The project includes no signing data or EAS account identifiers.

From the repository root:

```sh
npm ci
EXPO_NO_TELEMETRY=1 npm run export:ios
EXPO_NO_TELEMETRY=1 npm exec --workspace @keyshoal/mobile -- expo prebuild --platform ios --no-install
npm exec --workspace @keyshoal/mobile -- expo-modules-autolinking resolve --platform apple
```

Linux can export the Hermes JavaScript bundle and generated project. The GitHub macOS check compiles Swift and publishes an unsigned iOS Simulator app. On a Mac, unpack that artifact and run `xcrun simctl install booted Keyshoal.app` with a simulator open. That does not install the app on a real iPhone.

For a physical iPhone, use an authorized Apple Developer team, a matching bundle identifier, and a device provisioning profile. Build from `mobile/` on a Mac with `npx expo run:ios`, or link the approved EAS project using `eas init` and run `eas build --platform ios --profile preview`. Do not commit signing credentials. [Expo's device-build instructions](https://docs.expo.dev/tutorial/eas/ios-development-build-for-devices/)

## Real-device acceptance

- With the phone disconnected, create a vault and login, edit it, lock, reopen and delete a throwaway entry. The app must not require a connection.
- Show a setup QR on the phone and join a Linux replica with the code and passphrase. Reverse the pairing direction on a separate synthetic vault. A wrong passphrase and an unrelated vault must fail. Verify the iOS local-network permission prompt and the foreground/background lock transition.
- With three replicas, transfer records between the two that did not create the vault while its original device is offline. Check that all devices can start, pause, resume and show sync status, and that stale devices catch up without manual IP entry.
- Edit the same login differently on two disconnected devices. Reconnect and verify both versions are offered. Disconnect before picking one, compare and reveal one version at a time, then reconnect and verify convergence. Include delete-versus-edit and a late replica returning with an unseen edit.
- Confirm Chrome on Linux can fill a locally available nonconflicting record with sync paused, then refuses a conflicting or deleted login. Test iPhone behavior across two real Wi-Fi access points or device sleep/rejoin. Autofill in iOS Safari is not part of this preview.
