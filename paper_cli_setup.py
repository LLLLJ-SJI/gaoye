"""Install and verify the two supported Windows CLI packages."""

import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.request import urlopen
from zipfile import ZipFile

import paper_deepseek as model
import paper_jobs as jobs


PACKAGES = {
    "codex": ("Codex", ".codex-runner", "@openai/codex@0.167.1"),
    "codebuddy": ("CodeBuddy", ".codebuddy-runner", "@tencent-ai/codebuddy-code@2.184.0"),
}
NODE_RELEASE = "https://nodejs.org/download/release/"
NPM_ENTRY = "node_modules/npm/bin/npm-cli.js"


def command_for(key):
    if key == "codex":
        path = jobs.find_codex()
        return [str(path)] if path else None
    if key == "codebuddy":
        path, nodes = model.find_codebuddy(), model.node_candidates()
        return [str(nodes[0]), str(path)] if path and nodes else None
    raise ValueError("未知的 CLI 组件。")


def run(command, timeout, cwd=None, env=None):
    return subprocess.run(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                          capture_output=True, encoding="utf-8", errors="replace",
                          timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def version(key):
    command = command_for(key)
    if command:
        try:
            result = run([*command, "--version"], 15)
            if result.returncode == 0:
                return next((line.strip()[:100] for line in result.stdout.splitlines()
                             if re.fullmatch(r"(?:codex-cli\s+)?\d+\.\d+\.\d+[^\r\n]*", line.strip())), "")
        except (OSError, subprocess.TimeoutExpired):
            pass
    return ""


def npm_runtime():
    for node in model.node_candidates():
        entry = node.parent / NPM_ENTRY
        if not entry.is_file():
            continue
        try:
            result = run([str(node), "--version"], 10)
        except (OSError, subprocess.TimeoutExpired):
            continue
        match = re.fullmatch(r"v(\d+)\.\d+\.\d+", result.stdout.strip())
        if result.returncode == 0 and match and int(match[1]) >= 22:
            return node, entry
    return None


def install_node():
    runtime = jobs.WORKSPACE / ".cli-runtime"
    runtime.mkdir(exist_ok=True)
    target = runtime / "node"
    if target.exists():
        raise ValueError("稿页自带的 Node.js 无法启动。请检查安全软件是否拦截，或安装 Node.js 22 及以上版本后重试。")
    with urlopen(NODE_RELEASE + "latest-v22.x/SHASUMS256.txt", timeout=30) as source:
        checksums = source.read(32_768).decode("ascii")
    match = re.search(r"^([a-f0-9]{64})\s+(node-(v22\.\d+\.\d+)-win-x64)\.zip$", checksums, re.M)
    if not match:
        raise ValueError("未找到 Node.js 的 Windows x64 官方校验记录。")
    digest, name, release = match.groups()
    with TemporaryDirectory(prefix="node-", dir=runtime) as scratch:
        archive = Path(scratch) / "node.zip"
        checksum = hashlib.sha256()
        with urlopen(f"{NODE_RELEASE}{release}/{name}.zip", timeout=45) as source, archive.open("wb") as output:
            total = 0
            while chunk := source.read(1024 * 1024):
                total += len(chunk)
                if total > 80 * 1024 * 1024:
                    raise ValueError("Node.js 下载文件异常。")
                checksum.update(chunk)
                output.write(chunk)
        if checksum.hexdigest() != digest:
            raise ValueError("Node.js 下载校验失败，请重试。")
        with ZipFile(archive) as package:
            package.extractall(scratch)
        extracted = Path(scratch) / name
        if not (extracted / "node.exe").is_file() or not (extracted / NPM_ENTRY).is_file():
            raise ValueError("Node.js 下载包缺少运行文件。")
        extracted.rename(target)
    return target / "node.exe", target / NPM_ENTRY


def installation_order(connection, missing):
    if not connection:
        return missing
    try:
        response = model.chat(connection, "你在为稿页选择安装顺序。只返回 JSON {\"order\":[...]}"
                              "，必须恰好包含所有缺失组件的 ID，不要输出任何命令或其他字段。",
                              json.dumps({"missing": missing}), 512, structured=True)
        plan = json.loads(response.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip())
        order = plan.get("order") if isinstance(plan, dict) else None
        if isinstance(order, list) and all(isinstance(key, str) for key in order) and sorted(order) == sorted(missing):
            return order
    except (ValueError, OSError):
        pass
    return missing


def install(connection, update):
    versions = {key: version(key) for key in PACKAGES}
    if all(versions.values()):
        return versions, {}
    missing = [key for key, value in versions.items() if not value]
    update("正在安排缺失组件的安装…")
    if connection and connection.provider == "codebuddy" and "codebuddy" in missing:
        connection = None
    order = installation_order(connection, missing)
    runtime = npm_runtime()
    if not runtime:
        update("正在下载并校验便携 Node.js…")
        runtime = install_node()
    node, npm = runtime
    env = {**os.environ, "PATH": str(node.parent) + os.pathsep + os.environ.get("PATH", "")}
    failures = {}
    for key in order:
        label, directory, package = PACKAGES[key]
        update(f"正在安装 {label} CLI…")
        prefix = jobs.WORKSPACE / directory
        try:
            prefix.mkdir(exist_ok=True)
            result = run([str(node), str(npm), "install", "--prefix", str(prefix), "--include=optional",
                          "--registry=https://registry.npmjs.org", "--no-fund", "--no-audit",
                          "--fetch-retries=1", "--fetch-timeout=30000", package],
                         480, cwd=prefix, env=env)
            if result.returncode:
                code = re.search(r"(?:npm (?:ERR!|error) code)\s+([A-Z0-9_]+)", result.stderr, re.I)
                failures[key] = f"安装失败（{code[1] if code else result.returncode}），请检查网络或目录权限后重试。"
            else:
                versions[key] = version(key)
                if not versions[key]:
                    failures[key] = "已下载，CLI 版本验证未通过，请重试。"
        except (OSError, subprocess.TimeoutExpired):
            failures[key] = "安装未完成，请检查网络和目录权限后重试。"
    return versions, failures


def login(key):
    command = command_for(key)
    if not command:
        raise ValueError("请先安装对应的 CLI。")
    if key == "codex":
        command.append("login")
    env = {**os.environ, "PATH": str(Path(command[0]).parent) + os.pathsep + os.environ.get("PATH", "")}
    subprocess.Popen(command, cwd=os.path.expanduser("~"),
                     env=env, creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0))
