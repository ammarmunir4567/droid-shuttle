#!/usr/bin/env bash
# One command to install Droid Shuttle: downloads the latest release's DMG for this Mac, checks it against
# the release's SHA256SUMS, copies the app to /Applications, and opens it. Files fetched with curl carry no
# quarantine flag, so macOS does not block the first launch; any flag that is there is cleared anyway.
# Nothing outside the app is changed, and Gatekeeper stays on for every other app.
#
#   curl -fsSL https://raw.githubusercontent.com/ammarmunir4567/droid-shuttle/main/scripts/install-droid-shuttle.sh | bash
#
# No admin rights? Install for your account only:
#   curl -fsSL <same URL> | DROID_SHUTTLE_INSTALL_DIR="$HOME/Applications" bash
set -euo pipefail

REPO=ammarmunir4567/droid-shuttle
WORK="" STAGING=""

fail() { echo "install-droid-shuttle: $*" >&2; exit 1; }

cleanup() {
  [[ -z $STAGING ]] || rm -rf "$STAGING"
  if [[ -n $WORK ]]; then
    hdiutil detach -quiet "$WORK/mnt" 2>/dev/null || hdiutil detach -quiet -force "$WORK/mnt" 2>/dev/null || true
    rm -rf "$WORK" 2>/dev/null || true
  fi
}

# Everything runs from main, called on the last line, so a download cut short never runs half a script.
main() {
  local dest_dir=${DROID_SHUTTLE_INSTALL_DIR:-/Applications} arch release dmg_url sums_url name app
  [[ "$(uname -s)" == Darwin ]] || fail "this is for macOS."

  mkdir -p "$dest_dir" 2>/dev/null || true
  [[ -w $dest_dir ]] || fail "cannot write to $dest_dir. To install for your account only, run again with DROID_SHUTTLE_INSTALL_DIR=\"\$HOME/Applications\" in front of bash."
  app="$dest_dir/Droid Shuttle.app"

  # The same check on a Rosetta terminal: uname -m would say x86_64 there, this still says arm64.
  if [[ $(sysctl -n hw.optional.arm64 2>/dev/null || true) == 1 ]]; then arch=aarch64; else arch=x64; fi

  pgrep -f "/Droid Shuttle.app/Contents/MacOS/droid-shuttle" >/dev/null 2>&1 \
    && fail "Droid Shuttle is running. Quit it (menu-bar item, then Quit) and run this again."

  release=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest") \
    || fail "could not reach GitHub to find the latest release. Check your connection and try again in a few minutes (GitHub limits anonymous requests)."
  dmg_url=$(grep -o '"browser_download_url": *"[^"]*_'"$arch"'\.dmg"' <<<"$release" | sed -n 1p | cut -d'"' -f4 || true)
  sums_url=$(grep -o '"browser_download_url": *"[^"]*/SHA256SUMS"' <<<"$release" | sed -n 1p | cut -d'"' -f4 || true)
  [[ -n $dmg_url && -n $sums_url ]] || fail "the latest release has no $arch DMG or no SHA256SUMS. See https://github.com/$REPO/releases/latest"
  name=${dmg_url##*/}

  WORK=$(mktemp -d)
  trap cleanup EXIT
  mkdir "$WORK/mnt"

  echo "Downloading $name ..."
  curl -fL# "$dmg_url" -o "$WORK/$name" || fail "the download failed."
  curl -fsSL "$sums_url" -o "$WORK/SHA256SUMS" || fail "could not download SHA256SUMS."
  (cd "$WORK" && grep -F "  $name" SHA256SUMS | shasum -a 256 -c - >/dev/null 2>&1) \
    || fail "$name does not match SHA256SUMS, so it was not installed. Try again; if it keeps happening, open an issue."

  hdiutil attach -nobrowse -readonly -quiet -mountpoint "$WORK/mnt" "$WORK/$name" >/dev/null \
    || fail "could not open $name."
  [[ -d "$WORK/mnt/Droid Shuttle.app" ]] || fail "Droid Shuttle.app is not inside $name."

  # Copy beside the final spot, then swap, so a failed copy never leaves a half-installed app.
  STAGING="$dest_dir/.Droid Shuttle.installing"
  rm -rf "$STAGING"
  ditto "$WORK/mnt/Droid Shuttle.app" "$STAGING" || fail "could not copy the app into $dest_dir."
  xattr -dr com.apple.quarantine "$STAGING" 2>/dev/null || true
  rm -rf "$app"
  mv "$STAGING" "$app"
  STAGING=""

  echo "Installed: $app"
  open "$app"
}

main "$@"
