#!/bin/bash
# Builds a release arm64 granola-helper into dist/ and signs it ad hoc with the hardened
# runtime and the entitlements it needs, so local builds behave like notarized ones.
set -euo pipefail
cd "$(dirname "$0")"

swift build --configuration release --arch arm64
bin_dir=$(swift build --configuration release --arch arm64 --show-bin-path)

mkdir -p dist
cp "$bin_dir/granola-helper" dist/granola-helper
codesign --force --sign - --options runtime \
    --identifier com.granola.helper \
    --entitlements granola-helper.entitlements \
    dist/granola-helper
codesign --verify --strict dist/granola-helper
echo "built $(pwd)/dist/granola-helper"
