#!/usr/bin/env bash

# Echoes a version based on the git hashes of the element-web & js-sdk checkouts, for the case where
# these dependencies are git checkouts.

set -e

VECTOR_SHA=$(git rev-parse --short=12 HEAD) # use the ACTUAL SHA rather than assume develop
JSSDK_DIR="$(pnpm -w root)/matrix-js-sdk"
if [ -d "$JSSDK_DIR" ] && git -C "$JSSDK_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    JSSDK_SHA=$(git -C "$JSSDK_DIR" rev-parse --short=12 HEAD)
    echo "$VECTOR_SHA-js-$JSSDK_SHA"
else
    echo "$VECTOR_SHA"
fi
