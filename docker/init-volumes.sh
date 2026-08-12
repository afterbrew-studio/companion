#!/bin/sh
set -eu

# Coolify may back a Compose volume with a root-owned host directory instead of
# Docker's ownership-preserving named-volume initialization. This one-shot
# container owns only Companion's two fixed writable roots; chown's physical
# traversal never follows provider-credential symlinks out of either tree.
chown -hR node:node /data /home/node/.moxxy
