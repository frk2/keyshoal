#!/bin/sh
set -eu
case "${1-}" in
  '') echo 'Usage: ./install-chrome-host.sh EXTENSION_ID [google-chrome|chromium|google-chrome-for-testing] [user-data-dir]' >&2; exit 2;;
  *[!a-p]*) echo 'Use the extension ID from chrome://extensions.' >&2; exit 2;;
esac
[ "${#1}" -eq 32 ] || { echo 'The extension ID must have 32 characters.' >&2; exit 2; }
case "${2-google-chrome}" in
  google-chrome|chromium|google-chrome-for-testing) browser="${2-google-chrome}";;
  *) echo 'Unknown Chrome profile family.' >&2; exit 2;;
esac
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
host="$here/keyshoal-chrome-host"
[ -x "$host" ] || { echo 'Run the installer from the packaged chrome directory.' >&2; exit 1; }
python3 - "$host" "$1" "$browser" "${3-${CHROME_USER_DATA_DIR-}}" <<'PY'
import json, os, pathlib, sys, tempfile
path, extension_id, browser, data_dir = sys.argv[1:]
if data_dir:
    root = pathlib.Path(data_dir)
    if not root.is_absolute():
        sys.exit('Pass the absolute Chrome User Data directory, not a profile name.')
else:
    root = pathlib.Path(os.environ.get('CHROME_CONFIG_HOME') or os.environ.get('XDG_CONFIG_HOME') or
                        pathlib.Path.home() / '.config') / browser
folder = root / 'NativeMessagingHosts'
folder.mkdir(parents=True, exist_ok=True)
manifest = folder / 'com.keyshoal.desktop.json'
data = dict(name='com.keyshoal.desktop', description='Keyshoal local vault bridge',
            path=path, type='stdio', allowed_origins=[f'chrome-extension://{extension_id}/'])
fd, temp = tempfile.mkstemp(dir=folder)
try:
    with os.fdopen(fd, 'w') as output:
        json.dump(data, output)
    os.replace(temp, manifest)
finally:
    if os.path.exists(temp):
        os.unlink(temp)
print(manifest)
PY
