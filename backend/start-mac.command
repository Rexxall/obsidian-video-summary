#!/bin/bash
# Double-click in Finder to start the Video Summary backend on macOS.
cd "$(dirname "$0")" && ./vs-backend.sh "$@"
echo
read -r -p "按回车关闭这个窗口…" _
