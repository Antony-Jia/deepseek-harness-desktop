# Portable Node runtime

The production installer resource contains a signed, checksum-verified Node
24 x64 distribution in this directory with node.exe and the bundled
node_modules/npm/bin/npm-cli.js. The current release build uses
node-v24.19.0-win-x64.zip with SHA256
57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73. The first
application start copies that resource to %LOCALAPPDATA%/dsh-desktop/node.

The binary is intentionally not committed to this repository. During local
development the Rust shell falls back to node.exe/npm.cmd on PATH, while a
release build should populate this directory before running npm run build. The
repository keeps only this marker file, so local development falls back to the
Node executable on PATH.
