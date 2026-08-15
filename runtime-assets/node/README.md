# Portable Node runtime

The production installer resource is expected to contain a signed,
checksum-verified Node 24 x64 distribution in this directory with node.exe
and the bundled node_modules/npm/bin/npm-cli.js. The first application start
copies that resource to %LOCALAPPDATA%/dsh-desktop/node.

The binary is intentionally not committed to this repository. During local
development the Rust shell falls back to node.exe/npm.cmd on PATH, while a
release build should populate this directory before running npm run build. The
repository keeps only this marker file, so local development falls back to the
Node executable on PATH.
