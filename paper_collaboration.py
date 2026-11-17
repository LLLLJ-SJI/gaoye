"""Windows desktop launchers and the folders used by paper handoffs."""

import json
import os
from pathlib import Path
import subprocess

import paper_jobs as jobs


APPS = {"doubao": "豆包", "codex": "GPT / Codex"}
PREFERENCES = "协作启动.json"


def preferences():
    try:
        value = json.loads(jobs.read_text(jobs.WORKSPACE / PREFERENCES) or "{}")
    except (OSError, ValueError):
        value = {}
    return {app: not isinstance(value, dict) or value.get(app) is not False for app in APPS}


def save_preferences(value):
    options = {app: value.get(app) is True for app in APPS}
    jobs.publish_text(jobs.WORKSPACE / PREFERENCES, json.dumps(options, indent=2))
    return options


def folders():
    return {"shared": jobs.WORKSPACE, "doubao": jobs.TASKS, "codex": jobs.FIGURE_DELIVERY}


def setup():
    paths = folders()
    for path in paths.values():
        path.mkdir(parents=True, exist_ok=True)
    return {key: str(path) for key, path in paths.items()}


def open_folder(key):
    path = folders().get(key)
    if path is None:
        raise ValueError("未知的工作区目录。")
    path.mkdir(parents=True, exist_ok=True)
    os.startfile(str(path))


# Use the installed Windows app registration; Doubao may only install a shortcut.
# Neither branch sends chat input or opens a manuscript.
WINDOWS_APPS = r"""
$ErrorActionPreference = 'Stop'
$app = $env:PAPER_COLLABORATION_APP
if ($app -eq 'doubao') {
    $roots = @('DesktopDirectory','CommonDesktopDirectory','Programs','CommonPrograms') |
        ForEach-Object { [Environment]::GetFolderPath($_) } | Where-Object { $_ }
    foreach ($root in $roots) {
        foreach ($name in @('豆包.lnk','Doubao.lnk','豆包\豆包.lnk','Doubao\Doubao.lnk')) {
            $shortcut = Join-Path $root $name
            if (Test-Path -LiteralPath $shortcut -PathType Leaf) {
                $target = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath
                if ($target -and (Test-Path -LiteralPath $target -PathType Leaf)) {
                    Start-Process -FilePath $shortcut
                    exit 0
                }
            }
        }
    }
    $entry = Get-StartApps | Where-Object { $_.Name -in @('豆包','Doubao') } | Select-Object -First 1
} elseif ($app -eq 'codex') {
    $entry = Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex_*!*' } | Select-Object -First 1
} else { exit 2 }
if (!$entry) { exit 3 }
Start-Process -FilePath explorer.exe -ArgumentList ('shell:AppsFolder\' + $entry.AppID)
"""


def launch(app):
    if app not in APPS:
        raise ValueError("未知的协作客户端。")
    environment = {**os.environ, "PAPER_COLLABORATION_APP": app}
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_APPS],
            env=environment, capture_output=True, timeout=18,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired):
        return f"未能打开{APPS[app]}，请从 Windows 开始菜单打开后重试。"
    if result.returncode == 3:
        return f"没有找到{APPS[app]}的启动入口。请确认已安装，豆包也可以在桌面放一个快捷方式。"
    if result.returncode:
        return f"未能打开{APPS[app]}，请从 Windows 开始菜单打开后重试。"
    return "已请求打开"
