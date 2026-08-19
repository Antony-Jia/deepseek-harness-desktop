# PyInstaller onedir spec. The build command runs from python-sidecar.
from PyInstaller.utils.hooks import collect_all

datas, binaries, hiddenimports = collect_all("akshare")

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
