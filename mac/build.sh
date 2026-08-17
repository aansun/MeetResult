#!/bin/bash
# Compile MeetResultTray.swift menjadi binary native macOS
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$DIR")"
mkdir -p "$ROOT/bin"
echo "Compiling MeetResultTray..."
swiftc -O "$DIR/MeetResultTray.swift" -o "$ROOT/bin/meetresult-tray"
echo "Selesai: $ROOT/bin/meetresult-tray"
