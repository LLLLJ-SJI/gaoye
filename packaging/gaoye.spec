# -*- coding: utf-8 -*-
from pathlib import Path
from PyInstaller.utils.hooks import collect_all

root = Path(SPECPATH).parent
assets = ["paper_workspace.html", "paper_workspace.css", "paper_workspace.js",
          "paper_workstation_neutral.ico", "paper_doubao_bridge.ps1"]
datas = [(str(root / name), ".") for name in assets]
binaries = []
hiddenimports = ["webview.platforms.winforms", "webview.platforms.edgechromium"]
for package in ("webview", "pythonnet", "clr_loader"):
    files, libraries, modules = collect_all(package)
    datas += files
    binaries += libraries
    hiddenimports += modules
a = Analysis([str(root / "paper_webview.py")], pathex=[str(root / ".webview-runtime")],
             datas=datas, binaries=binaries, hiddenimports=hiddenimports,
             excludes=["PyQt5", "PyQt6", "PySide2", "PySide6", "matplotlib", "scipy",
                       "torch", "IPython", "pandas", "numpy"])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="稿页", console=False,
          upx=False, icon=str(root / "paper_workstation_neutral.ico"))
coll = COLLECT(exe, a.binaries, a.datas, upx=False, name="稿页")
