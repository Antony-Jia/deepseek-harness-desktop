# Third-party notices

The sidecar uses the following independently licensed Python projects. The
release build must retain their licenses and notices in the generated SBOM.

- AKShare: MIT License, https://github.com/akfamily/akshare
- pandas: BSD 3-Clause License, https://github.com/pandas-dev/pandas
- NumPy: BSD 3-Clause License, https://github.com/numpy/numpy
- lxml: BSD 3-Clause License, https://github.com/lxml/lxml
- curl-cffi: MIT License, https://github.com/lexiforest/curl_cffi
- PyInstaller: GPL-2.0-or-later with its bootloader exception,
  https://github.com/pyinstaller/pyinstaller

This plugin does not copy source code from the reference OpenClaw AKShare
project. Its adapters, indicators, and protocol implementation are an
independent implementation based on the public AKShare API contract.
