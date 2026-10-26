#!/usr/bin/env bash
# Lets a downloaded copy of Droid Shuttle open on macOS. The app is ad-hoc signed but not notarized, so
# Gatekeeper blocks the first launch of a quarantined copy. This clears the quarantine flag on that one
# app (the same as `xattr -dr com.apple.quarantine "/Applications/Droid Shuttle.app"`) and opens it.
# It changes no system setting and leaves Gatekeeper on for every other app.
#
#   curl -fsSL https://raw.githubusercontent.com/ammarmunir4567/droid-shuttle/main/scripts/allow-droid-shuttle.sh | bash
#   bash allow-droid-shuttle.sh ["/path/to/Droid Shuttle.app"]
set -euo pipefail

fail() { echo "allow-droid-shuttle: $*" >&2; exit 1; }

# Everything runs from main, called on the last line, so a download cut short never runs half a script.
main() {
  local bundle_id=ai.arqanum.droidshuttle app="" candidate id attrs
  [[ "$(uname -s)" == Darwin ]] || fail "this is for macOS."

  if [[ $# -gt 0 ]]; then
    app=${1%/}
    [[ -d $app ]] || fail "no such app: $app"
  else
    for candidate in "/Applications/Droid Shuttle.app" "$HOME/Applications/Droid Shuttle.app"; do
      if [[ -d $candidate ]]; then app=$candidate; break; fi
    done
    [[ -n $app ]] || fail "Droid Shuttle is not in /Applications or ~/Applications.
Open the DMG and drag Droid Shuttle onto Applications, then run this again.
If it is somewhere else, give its path: bash allow-droid-shuttle.sh \"/path/to/Droid Shuttle.app\""
  fi

  # Only ever touch Droid Shuttle, whatever path was given.
  id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null || true)
  [[ $id == "$bundle_id" ]] || fail "$app is not Droid Shuttle, so I left it alone."

  attrs=$(xattr -r "$app" 2>/dev/null || true)
  if [[ $attrs == *com.apple.quarantine* ]]; then
    xattr -dr com.apple.quarantine "$app" 2>/dev/null \
      || fail "could not clear the quarantine flag on $app. Try: sudo xattr -dr com.apple.quarantine \"$app\""
    echo "Allowed: $app"
  else
    echo "Already allowed: $app"
  fi
  open "$app"
}

main "$@"
