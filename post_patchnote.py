"""
git commit 시 자동으로 디스코드 #업데이트-로그에 패치노트 전송
.git/hooks/post-commit 에서 호출됨
"""

import subprocess
import urllib.request
import urllib.error
import json
import re
import os
from datetime import datetime

def _load_env():
    """프로젝트 루트의 .env 파일에서 환경변수 로드"""
    root = subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], encoding="utf-8"
    ).strip()
    env_path = os.path.join(root, ".env")
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())

_load_env()
WEBHOOK_URL = os.environ.get("DISCORD_PATCH_WEBHOOK", "")

def get_commit_info():
    msg = subprocess.check_output(
        ["git", "log", "-1", "--pretty=%s"],
        encoding="utf-8"
    ).strip()
    count = subprocess.check_output(
        ["git", "rev-list", "--count", "HEAD"],
        encoding="utf-8"
    ).strip()
    return msg, count

def format_message(msg):
    """커밋 메시지를 읽기 좋은 패치노트로 변환"""
    lines = [l.strip() for l in msg.strip().split("\n") if l.strip()]
    if not lines:
        return msg

    result = []
    for line in lines:
        # - 또는 * 로 시작하면 그대로
        if line.startswith(("-", "*", "•")):
            result.append(f"• {line.lstrip('-*• ').strip()}")
        # 여러 항목이 / 또는 , 로 구분된 경우 분리
        elif "/" in line or ("," in line and len(line) > 20):
            items = re.split(r"[/,]", line)
            for item in items:
                item = item.strip()
                if item:
                    result.append(f"• {item}")
        else:
            result.append(f"• {line}")

    return "\n".join(result)

def send_to_discord(msg, version):
    formatted = format_message(msg)
    now = datetime.now().strftime("%Y.%m.%d")

    body = {
        "embeds": [{
            "title": f"📋 패치노트 v0.{version}",
            "description": formatted,
            "color": 0x5865F2,
            "footer": {"text": f"마추기온라인 • {now}"},
            "timestamp": datetime.utcnow().isoformat() + "Z",
        }]
    }

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        WEBHOOK_URL,
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "MatchuOnline-PatchBot/1.0",
        },
        method="POST"
    )
    try:
        urllib.request.urlopen(req)
        print(f"✅ 디스코드 패치노트 전송 완료 (v0.{version})")
    except urllib.error.HTTPError as e:
        print(f"❌ 전송 실패: {e}")
        print(f"   응답 내용: {e.read().decode('utf-8')}")
    except Exception as e:
        print(f"❌ 전송 실패: {e}")

if __name__ == "__main__":
    msg, count = get_commit_info()
    # 자동 전송 무시 키워드
    skip_keywords = ["wip", "merge", "fix typo", "minor", "temp", "임시", "테스트"]
    if any(k in msg.lower() for k in skip_keywords):
        print("⏭️  패치노트 전송 생략")
    else:
        send_to_discord(msg, count)
