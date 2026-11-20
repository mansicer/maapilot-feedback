"""用真实的客户端代码生成一份上传请求（请求体和 Content-Type），给 Worker 的测试用。"""
import json, sys, base64
from pathlib import Path
from maapilot import cli, paths
from maapilot.tools import feedback, scrub

out, work = Path(sys.argv[1]), Path(sys.argv[2])
scrub.known_values = lambda: []
(work / "session.md").write_text("用户说日常跑到一半停了。\n我跑了 maapilot daily run，基建那一项报 maa_failed。\n", encoding="utf-8")
(work / "raw.txt").write_text("工具调用 1：maapilot daily run → 退出码 1，error.code handoff\n", encoding="utf-8")
png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
(paths.SHOTS).mkdir(parents=True, exist_ok=True)
(paths.SHOTS / "example.png").write_bytes(png)
captured = {}
def fake_post(url, body, headers, timeout=60):
    captured.update(body=body, headers=headers)
    return 200, b'{"ok": true, "id": "x"}'
feedback.http_post = fake_post
feedback.harness_env = lambda: {"names": ["EXAMPLE_HARNESS"], "values": {}}
import io, contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    cli.main(["feedback", "draft", "--text", "日常跑到一半停了，基建没做完", "--session-file", str(work / "session.md"),
              "--raw-session-file", str(work / "raw.txt"), "--shot", str(paths.SHOTS / "example.png"),
              "--harness", "Example Harness", "--model", "example-model", "--category", "bug", "--no-checks"])
d = json.loads(buf.getvalue())["data"]
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    assert cli.main(["feedback", "send", d["id"], "--digest", d["digest"]]) == 0
(out / "request-body.bin").write_bytes(captured["body"])
(out / "request-meta.json").write_text(json.dumps({"content_type": captured["headers"]["Content-Type"],
    "headers": {"X-MaaPilot-Feedback": captured["headers"]["X-MaaPilot-Feedback"]}, "id": d["id"]}, indent=1) + "\n", encoding="utf-8")
print(d["id"], len(captured["body"]))
