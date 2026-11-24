#!/bin/bash
# Builds a double-click macOS installer: dist/MeetResult-<version>.pkg
#
#   ./scripts/build-installer.sh
#
# The package installs /Applications/MeetResult.app, which is self-contained:
#   - the menu-bar app (Swift, arm64)
#   - the MeetResult code (src/, Template/, production node_modules)
#   - an official Node.js runtime (downloaded once, SHA-256 verified, cached in dist/cache)
# User data and settings live in ~/Library/Application Support/MeetResult (created on first launch).
#
# NOT bundled (system components): ffmpeg and the BlackHole audio driver. The app detects them
# on first launch and offers a one-click Homebrew install.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
NODE_VERSION="${NODE_VERSION:-}"   # e.g. v26.13.1; default: newest LTS of the Node major you develop with
BUNDLE_ID="com.aansun.meetresult"
DIST="$ROOT/dist"
CACHE="$DIST/cache"
# Stage in a temp dir OUTSIDE the project: folders under ~/Documents may be managed by iCloud's
# File Provider, which stamps them with com.apple.FinderInfo - codesign rejects such bundles.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/meetresult-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/stage"
APP="$STAGE/MeetResult.app"
PKG_ROOT="$WORK/pkgroot"
OUT="$DIST/MeetResult-$VERSION.pkg"
mkdir -p "$DIST"

echo "==> MeetResult $VERSION"
[[ "$(uname -m)" == "arm64" ]] || { echo "This build script targets Apple Silicon (arm64)."; exit 1; }

# ---------------------------------------------------------------- Node runtime
mkdir -p "$CACHE"
if [[ -z "$NODE_VERSION" ]]; then
  MAJOR="$(node -p "process.versions.node.split('.')[0]")"
  curl -fsS https://nodejs.org/dist/index.json -o "$CACHE/node_index.json"
  NODE_VERSION="$(node -e "
    const d=require('$CACHE/node_index.json');
    const m=d.find(e=>e.version.startsWith('v$MAJOR.') && e.lts) || d.find(e=>e.version.startsWith('v$MAJOR.'));
    console.log(m.version)")"
fi
NODE_TAR="node-$NODE_VERSION-darwin-arm64.tar.gz"
if [[ ! -f "$CACHE/$NODE_TAR" ]]; then
  echo "==> Downloading Node.js $NODE_VERSION"
  curl -fSL "https://nodejs.org/dist/$NODE_VERSION/$NODE_TAR" -o "$CACHE/$NODE_TAR"
fi
echo "==> Verifying Node.js checksum (SHASUMS256.txt from nodejs.org)"
curl -fsS "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$CACHE/SHASUMS256-$NODE_VERSION.txt"
EXPECTED="$(grep " $NODE_TAR\$" "$CACHE/SHASUMS256-$NODE_VERSION.txt" | awk '{print $1}')"
ACTUAL="$(shasum -a 256 "$CACHE/$NODE_TAR" | awk '{print $1}')"
[[ -n "$EXPECTED" && "$EXPECTED" == "$ACTUAL" ]] || { echo "Checksum mismatch for $NODE_TAR - aborting."; rm -f "$CACHE/$NODE_TAR"; exit 1; }

# ---------------------------------------------------------------- menu-bar binary
echo "==> Compiling menu-bar app"
bash "$ROOT/mac/build.sh" >/dev/null

# ---------------------------------------------------------------- stage the .app
echo "==> Staging MeetResult.app"
rm -rf "$STAGE" "$PKG_ROOT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app" "$APP/Contents/Resources/node"

cp "$ROOT/bin/meetresult-tray" "$APP/Contents/MacOS/MeetResult"

RES="$APP/Contents/Resources"
mkdir -p "$RES/app/bin" "$RES/app/Template"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/.env.example" "$RES/app/"
cp "$ROOT/bin/meetresult.js" "$RES/app/bin/"
cp -R "$ROOT/src" "$ROOT/scripts" "$RES/app/"
rm -f "$RES/app/scripts/build-installer.sh"
# Only the generic *_template.docx files (user-specific logos/documents are never shipped)
cp "$ROOT"/Template/*_template.docx "$RES/app/Template/"
cp -R "$ROOT/node_modules" "$RES/app/node_modules"
( cd "$RES/app" && npm prune --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 )

tar -xzf "$CACHE/$NODE_TAR" -C "$RES/node" --strip-components=1 "node-$NODE_VERSION-darwin-arm64/bin/node" "node-$NODE_VERSION-darwin-arm64/LICENSE"
chmod +x "$RES/node/bin/node"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>MeetResult</string>
  <key>CFBundleDisplayName</key><string>MeetResult</string>
  <key>CFBundleExecutable</key><string>MeetResult</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>MeetResult records your microphone during Microsoft Teams meetings to produce meeting minutes.</string>
  <key>NSAppleEventsUsageDescription</key><string>MeetResult opens Terminal to install required components (ffmpeg, BlackHole) via Homebrew.</string>
</dict>
</plist>
PLIST

# Ad-hoc signature (required for arm64 code to run). This is NOT a Developer ID signature:
# on other Macs, Gatekeeper still asks for a one-time "Open Anyway" approval.
echo "==> Ad-hoc signing"
# Extended attributes (provenance/quarantine copied from the downloaded Node tarball, Finder info)
# make codesign refuse the bundle ("resource fork, Finder information, or similar detritus").
xattr -cr "$APP"
codesign --force --sign - "$APP/Contents/Resources/node/bin/node" >/dev/null 2>&1
codesign --force --sign - "$APP" >/dev/null 2>&1
codesign --verify --deep --strict "$APP"

# ---------------------------------------------------------------- .pkg
echo "==> Building installer package"
mkdir -p "$PKG_ROOT/Applications"
cp -R "$APP" "$PKG_ROOT/Applications/"
COMPONENT="$WORK/MeetResult-component.pkg"
pkgbuild --root "$PKG_ROOT" --identifier "$BUNDLE_ID.pkg" --version "$VERSION" \
         --install-location / "$COMPONENT" >/dev/null

cat > "$WORK/distribution.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>MeetResult $VERSION</title>
  <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
  <volume-check><allowed-os-versions><os-version min="13.0"/></allowed-os-versions></volume-check>
  <choices-outline><line choice="default"><line choice="$BUNDLE_ID.pkg"/></line></choices-outline>
  <choice id="default"/>
  <choice id="$BUNDLE_ID.pkg" visible="false"><pkg-ref id="$BUNDLE_ID.pkg"/></choice>
  <pkg-ref id="$BUNDLE_ID.pkg" version="$VERSION" onConclusion="none">MeetResult-component.pkg</pkg-ref>
</installer-gui-script>
XML
productbuild --distribution "$WORK/distribution.xml" --package-path "$WORK" "$OUT" >/dev/null

echo "==> Done: $OUT ($(du -h "$OUT" | awk '{print $1}'))"
shasum -a 256 "$OUT"
