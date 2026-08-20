# PyInstaller onedir spec. The build command runs from python-sidecar.
from PyInstaller.utils.hooks import collect_all

datas, binaries, hiddenimports = collect_all("akshare")
mini_racer_datas, mini_racer_binaries, mini_racer_hiddenimports = collect_all("py_mini_racer")
datas += mini_racer_datas
binaries += mini_racer_binaries
hiddenimports += mini_racer_hiddenimports

a = Analysis(
    ["src/akshare_service/main.py"],
    pathex=["src"],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name="akshare-service", debug=False, bootloader_ignore_signals=False, strip=False, upx=False, console=True)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="akshare-service")
