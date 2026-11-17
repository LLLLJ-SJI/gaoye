"""DeepSeek text tasks and Windows Credential Manager storage."""

import ctypes
from ctypes import wintypes
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit, urlunsplit
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


ENDPOINT = "https://api.deepseek.com/chat/completions"
MODELS = ("deepseek-flash", "deepseek-v4-pro")
TARGET = "论文工作站/DeepSeek"
MODEL_TARGET = "论文工作站/调度模型"
CODEBUDDY_ROOT = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
CODEBUDDY_CLI = (CODEBUDDY_ROOT / ".codebuddy-runner" / "node_modules"
                / "@tencent-ai" / "codebuddy-code" / "bin" / "codebuddy")


class Credential(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
        ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
        ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR),
    ]


@dataclass(frozen=True)
class Connection:
    model: str
    key: str = field(repr=False)
    endpoint: str = ENDPOINT
    provider: str = "deepseek"


def normalize_endpoint(value):
    try:
        url = urlsplit(value.strip())
        url.port  # Validate the port, if supplied.
    except ValueError:
        raise ValueError("请输入有效的接口地址。") from None
    local = url.hostname in ("localhost", "127.0.0.1", "::1")
    if (not url.hostname or url.username is not None or url.password is not None
            or url.query or url.fragment or any(char.isspace() for char in url.geturl())
            or (url.scheme != "https" and not (local and url.scheme == "http"))):
        raise ValueError("接口需使用 HTTPS，本机 localhost 可使用 HTTP。")
    path = url.path.rstrip("/")
    if not path.endswith("/chat/completions"):
        path += "/chat/completions"
    return urlunsplit((url.scheme, url.netloc, path, "", ""))


def validate(connection):
    if not connection.model.strip() or any(char.isspace() for char in connection.model):
        raise ValueError("请填写有效的模型 ID。")
    if connection.provider == "codebuddy":
        if connection.key:
            raise ValueError("CodeBuddy 使用官方 CLI 的登录状态。")
        return ""
    if connection.provider not in ("deepseek", "compatible"):
        raise ValueError("请选择受支持的连接方式。")
    endpoint = normalize_endpoint(connection.endpoint)
    if connection.provider == "deepseek" and endpoint != ENDPOINT:
        raise ValueError("DeepSeek 官方连接使用固定地址。")
    if (not connection.key.isascii() or any(char.isspace() for char in connection.key)
            or (not connection.key and urlsplit(endpoint).hostname not in ("localhost", "127.0.0.1", "::1"))):
        raise ValueError("请填写有效的 API Key，本机无认证服务可留空。")
    return endpoint


def credential_api():
    library = ctypes.WinDLL("Advapi32", use_last_error=True)
    library.CredWriteW.argtypes = [ctypes.POINTER(Credential), wintypes.DWORD]
    library.CredWriteW.restype = wintypes.BOOL
    library.CredReadW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
        ctypes.POINTER(ctypes.POINTER(Credential)),
    ]
    library.CredReadW.restype = wintypes.BOOL
    library.CredFree.argtypes = [ctypes.c_void_p]
    library.CredFree.restype = None
    return library


def _read_credential(target):
    api = credential_api()
    result = ctypes.POINTER(Credential)()
    if not api.CredReadW(target, 1, 0, ctypes.byref(result)):
        error = ctypes.get_last_error()
        if error == 1168:
            return None
        raise ctypes.WinError(error)
    try:
        entry = result.contents
        key = ctypes.string_at(entry.CredentialBlob, entry.CredentialBlobSize).decode("utf-8")
        return entry.UserName, key
    finally:
        api.CredFree(result)


def load_connection():
    selected = _read_credential(MODEL_TARGET)
    if selected:
        try:
            return Connection(**json.loads(selected[1]))
        except (TypeError, ValueError):
            raise OSError("调度模型配置无法读取。") from None
    legacy = _read_credential(TARGET)
    return Connection(*legacy) if legacy else None


def save_connection(connection):
    endpoint = validate(connection)
    data = json.dumps(dict(model=connection.model, key=connection.key,
                           endpoint=endpoint, provider=connection.provider)).encode("utf-8")
    if len(data) > 2560:
        raise ValueError("连接信息过长，无法保存到 Windows 凭据管理器。")
    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    entry = Credential(Type=1, TargetName=MODEL_TARGET, CredentialBlobSize=len(data),
                       CredentialBlob=buffer, Persist=2, UserName=connection.model)
    if not credential_api().CredWriteW(ctypes.byref(entry), 0):
        raise ctypes.WinError(ctypes.get_last_error())


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def find_codebuddy():
    if CODEBUDDY_CLI.is_file():
        return CODEBUDDY_CLI
    prefix = os.environ.get("APPDATA")
    candidates = [Path(prefix) / "npm"] if prefix else []
    candidates.extend(Path(entry.strip('"')) for entry in os.environ.get("PATH", "").split(os.pathsep) if entry)
    package = CODEBUDDY_CLI.parts[CODEBUDDY_CLI.parts.index("node_modules"):]
    return next((path.joinpath(*package) for path in candidates if path.joinpath(*package).is_file()), None)


def node_candidates():
    paths = [CODEBUDDY_ROOT / ".cli-runtime" / "node" / "node.exe"]
    installed = shutil.which("node.exe") or shutil.which("node")
    if installed:
        paths.append(Path(installed))
    standard = os.environ.get("ProgramFiles")
    if standard:
        paths.append(Path(standard) / "nodejs" / "node.exe")
    return list(dict.fromkeys(path for path in paths if path.is_file()))


def codebuddy_chat(connection, system, user, structured):
    cli = find_codebuddy()
    if cli is None:
        raise ValueError("未安装 CodeBuddy CLI，请在模型设置中点击「检查并安装 CLI」。")
    nodes = node_candidates()
    if not nodes:
        raise ValueError("未找到 Node.js，请在模型设置中点击「检查并安装 CLI」。")
    node = nodes[0]
    env = {**os.environ, "PATH": str(node.parent) + os.pathsep + os.environ.get("PATH", "")}
    if structured:
        system += "\n只返回一个有效 JSON 对象，不要加代码围栏或说明。"
    try:
        with TemporaryDirectory(prefix="paper-codebuddy-") as folder:
            result = subprocess.run([
                str(node), str(cli), "--print", "--output-format", "text",
                "--model", connection.model, "--tools", "", "--strict-mcp-config",
                "--setting-sources", "", "--no-session-persistence",
                "--system-prompt", system,
            ], input=user, encoding="utf-8", errors="replace", capture_output=True,
               cwd=folder, env=env, timeout=150, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError("CodeBuddy CLI 无法启动或请求超时。") from None
    output = result.stdout.strip()
    if "authentication required" in (output + result.stderr).lower():
        raise ValueError("CodeBuddy 尚未登录。请在模型设置中点击「登录 CodeBuddy」，需要时输入 /login。")
    if result.returncode or not output:
        raise ValueError("CodeBuddy 没有返回结果。请先用官方 CLI 登录，并确认模型可用。")
    return output


def chat(connection, system, user, max_tokens, *, structured=False):
    endpoint = validate(connection)
    if connection.provider == "codebuddy":
        return codebuddy_chat(connection, system, user, structured)
    payload = {
        "model": connection.model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_tokens": max_tokens,
    }
    if connection.provider == "deepseek":
        payload["thinking"] = {"type": "disabled"}
        if structured:
            payload["response_format"] = {"type": "json_object"}
    elif structured:
        payload["messages"][0]["content"] += "\n只返回一个有效 JSON 对象，不要加 Markdown 代码围栏或说明。"
    headers = {"Content-Type": "application/json"}
    if connection.key:
        headers["Authorization"] = "Bearer " + connection.key
    request = Request(endpoint, data=json.dumps(payload).encode("utf-8"), headers=headers)
    try:
        handlers = [NoRedirect()]
        if urlsplit(endpoint).hostname in ("localhost", "127.0.0.1", "::1"):
            handlers.append(ProxyHandler({}))
        with build_opener(*handlers).open(request, timeout=120) as response:
            result = json.load(response)
        choice = result["choices"][0]
        if choice.get("finish_reason") == "length":
            raise ValueError("模型输出达到长度上限，请缩小小节范围后重试。")
        content = choice["message"]["content"]
        if not isinstance(content, str) or not content.strip():
            raise ValueError("模型未返回正文内容。")
        return content.strip()
    except HTTPError as error:
        details = {
            401: "API Key 无效或已撤销。", 402: "账户余额不足。",
            429: "请求过于频繁，请稍后重试。",
        }
        raise ValueError(f"模型接口 HTTP {error.code}。"
                         + details.get(error.code, "请检查模型及服务状态。")) from None
    except (URLError, TimeoutError):
        raise ValueError("无法连接模型接口或请求超时。") from None
    except (KeyError, IndexError, TypeError, json.JSONDecodeError):
        raise ValueError("模型接口返回了无法识别的响应。") from None


def test_connection(connection):
    reply = chat(connection, "这是一次连接测试。", '只返回 JSON 对象 {"ok":true}。', 512, structured=True)
    try:
        result = json.loads(reply.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip())
    except json.JSONDecodeError:
        result = None
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise ValueError("模型已响应，但未通过调度所需的 JSON 测试。")


def draft(connection, material, brief, *, write, figure):
    system = (
        "你是论文写作助手。严格依据原稿、材料和写作要求。保持术语、数据和引用，"
        "缺少证据的内容标明待补，不编造研究数据或文献。"
        '输出一个 JSON 对象，包含两个字符串字段 "body" 和 "image_prompt"。'
        "正文用 Markdown。配图提示词要包括应绘制的内容、标签、流程及版式，"
        "但不要绘图。未启用的字段填空字符串。"
    )
    user = f"写正文：{write}\n生成配图提示词：{figure}\n\n任务要求：\n{brief}\n\n原稿与材料：\n{material}"
    try:
        result = json.loads(chat(connection, system, user, 8000, structured=True))
    except json.JSONDecodeError:
        raise ValueError("DeepSeek 未返回有效的 JSON 结果，可重试。") from None
    if not isinstance(result, dict):
        raise ValueError("DeepSeek 未返回预期的结果对象。")
    for name, required in (("body", write), ("image_prompt", figure)):
        if required and (not isinstance(result.get(name), str) or not result[name].strip()):
            raise ValueError("DeepSeek 缺少所请求的正文或配图提示词，可重试。")
    return result
