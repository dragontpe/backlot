#!/bin/zsh
# Build skp2obj against the SketchUpAPI.framework bundled inside the
# installed SketchUp app. No Trimble SDK download required.
set -e
FWDIR="/Applications/SketchUp 2026/SketchUp.app/Contents/Frameworks"
if [ ! -d "$FWDIR/SketchUpAPI.framework" ]; then
  echo "SketchUpAPI.framework not found — is SketchUp 2026 installed?" >&2
  exit 1
fi
cd "$(dirname "$0")"
clang -O2 -arch arm64 -o skp2obj skp2obj.c \
  -F"$FWDIR" -framework SketchUpAPI -Wl,-rpath,"$FWDIR"
cp skp2obj ../src-tauri/binaries/skp2obj-aarch64-apple-darwin
echo "built: converter/skp2obj (+ sidecar copy)"
