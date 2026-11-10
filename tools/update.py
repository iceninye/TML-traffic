#!/usr/bin/env python3
"""一條指令更新資料：收到新檔案後，自己行都得，唔使靠 Claude。

    python3 tools/update.py 新檔案1 [新檔案2 ...]      # 自動分辨再匯入
    python3 tools/update.py --dry-run 新 DutySheet.xlsx # Duty Sheet 試跑，唔寫檔
    python3 tools/update.py --check                     # 只檢查環境同解析器（CI 用）
    python3 tools/update.py --code 7091M file.xlsx      # 另起編號（同 parse_dutysheet.py）

會做：
  1. 缺 pdfplumber／openpyxl 就自動建 .venv 並安裝（requirements.txt 固定版本），再用 .venv 重新行。
  2. 分辨每個檔案係咩：
       .xlsx 有 KSR／TAW／HHS／ETS DM 工作表  → Duty Sheet（parse_dutysheet.py）
       .xlsx 有 Index 工作表                  → Duty 總表（index-to-basic.py）
       .pdf  第一頁標題有 "Duty Sheet"        → 舊式 Duty Sheet PDF（parse_dutysheet.py）
       .pdf  第一頁有 (TML....) 代號          → 工作時間表（parse_timetables.py）
  3. 行所有驗證（有 node 先行），用中文列出新增／更改咗啲乜，同未來 14 日用邊份。
原始檔案唔好放入 repo（repo 係公開嘅）。
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VENV = os.path.join(ROOT, ".venv")
REQ = os.path.join(ROOT, "requirements.txt")


def ensure_deps():
    """Re-run inside .venv when the packages are missing (no network need if already installed)."""
    try:
        import openpyxl  # noqa: F401
        import pdfplumber  # noqa: F401
        return
    except ImportError:
        pass
    if os.environ.get("TML_UPDATE_VENV") == "1":
        sys.exit("已用 .venv 但仍缺 pdfplumber／openpyxl：請檢查 pip install -r requirements.txt 有冇報錯")
    py = os.path.join(VENV, "bin", "python") if os.name != "nt" else os.path.join(VENV, "Scripts", "python.exe")
    if not os.path.exists(py):
        print("第一次使用：建立 .venv ...")
        subprocess.check_call([sys.executable, "-m", "venv", VENV])
    print("安裝 requirements.txt ...")
    subprocess.check_call([py, "-m", "pip", "install", "-q", "-r", REQ])
    os.execve(py, [py] + sys.argv, {**os.environ, "TML_UPDATE_VENV": "1"})


def classify(path):
    low = path.lower()
    if low.endswith(".xlsx"):
        import openpyxl
        names = openpyxl.load_workbook(path, read_only=True, data_only=True).sheetnames
        if any(n in names for n in ("KSR", "TAW", "HHS", "ETS DM")):
            return "dutysheet"
        if "Index" in names:
            return "basic"
        return None
    if low.endswith(".pdf"):
        import pdfplumber
        with pdfplumber.open(path) as pdf:
            first = pdf.pages[0].extract_text() or ""
        if re.search(r"Duty Sheet \d{4}", first):
            return "dutysheet"
        if re.search(r"\(TML\w+\)", first):
            return "timetable"
    return None


def snapshot():
    def load(rel):
        try:
            with open(os.path.join(ROOT, rel), encoding="utf8") as fh:
                return json.load(fh)
        except OSError:
            return {}
    books = {e["code"]: e for e in load("data/timetables/index.json").get("timetables", [])}
    cards = {e["code"]: e for e in load("data/duties/index.json").get("sheets", [])}
    return books, cards


def describe_changes(before, after):
    (b0, c0), (b1, c1) = before, after
    lines = []
    for code, e in b1.items():
        if code not in b0:
            when = f"，行車日 {'、'.join(e['dates'])}" if e.get("dates") else ""
            lines.append(f"新增時間表 {code}（{e.get('day')}，生效 {e.get('effective')}{when}）")
        elif e != b0[code]:
            lines.append(f"更新時間表 {code}（revision {e.get('revision', '-')}）")
    for code, e in c1.items():
        if code not in c0:
            lines.append(f"新增更份卡片 DS{code}（{e.get('duties')} 個更份）")
        elif e.get("sha256") != c0[code].get("sha256"):
            lines.append(f"更新更份卡片 DS{code}（{e.get('duties')} 個更份）")
    return lines


def run_node(script, *args):
    node = shutil.which("node")
    if not node:
        print(f"  （冇裝 node，跳過 {script}）")
        return True
    r = subprocess.run([node, os.path.join(HERE, script), *args], cwd=ROOT, capture_output=True, text=True)
    tail = [l for l in (r.stdout + r.stderr).splitlines() if l.strip()]
    if r.returncode:
        print(f"  ✗ {script} 失敗：")
        for l in tail[-12:]:
            print(f"    {l}")
        return False
    print(f"  ✓ {script}：{tail[-1] if tail else 'OK'}")
    return True


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="*")
    ap.add_argument("--dry-run", action="store_true", help="Duty Sheet 試跑，唔寫檔（時間表 PDF 同 Duty 總表不支援，會略過）")
    ap.add_argument("--check", action="store_true", help="只檢查環境同解析器可以載入")
    ap.add_argument("--code", help="Duty Sheet 另起編號，例如 7091M（只可一個檔案）")
    args = ap.parse_args(argv)
    ensure_deps()
    sys.path.insert(0, HERE)

    if args.check:
        import dutycards  # noqa: F401
        import parse_dutysheet  # noqa: F401
        import parse_timetables  # noqa: F401
        import validate_dutysheet  # noqa: F401
        import validate_timetable  # noqa: F401
        print("解析器同依賴載入正常")
        return 0
    if not args.files:
        ap.error("請提供要匯入嘅檔案")

    groups = {"dutysheet": [], "basic": [], "timetable": []}
    for f in args.files:
        kind = classify(f)
        if not kind:
            print(f"✗ {f}：分辨唔到係 Duty Sheet、Duty 總表定時間表（唔支援 CSV；請用原本 xlsx／PDF）")
            return 1
        print(f"· {os.path.basename(f)} → {dict(dutysheet='Duty Sheet', basic='Duty 總表', timetable='工作時間表')[kind]}")
        groups[kind].append(f)

    before = snapshot()
    ok = True
    py = sys.executable
    if groups["timetable"] and not args.dry_run:
        ok &= subprocess.call([py, os.path.join(HERE, "parse_timetables.py"), *groups["timetable"]], cwd=ROOT) == 0
    if groups["dutysheet"]:
        cmd = [py, os.path.join(HERE, "parse_dutysheet.py"), *groups["dutysheet"]]
        if args.dry_run:
            cmd.append("--dry-run")
        if args.code:
            cmd += ["--code", args.code]
        ok &= subprocess.call(cmd, cwd=ROOT) == 0
    for f in groups["basic"]:
        if not args.dry_run:
            ok &= subprocess.call([py, os.path.join(HERE, "index-to-basic.py"), f], cwd=ROOT) == 0
    if not ok:
        print("\n✗ 匯入有錯，請睇上面訊息。解析器唔通過就唔會寫入該檔案。")
        return 1
    if args.dry_run:
        print("\n試跑完成，冇寫任何檔案。")
        return 0

    print("\n── 驗證 ──")
    for s in ("validate_data.mjs", "validate_calendar.mjs", "validate_duties.mjs", "validate-hours.mjs", "validate-duty-codes.mjs"):
        ok &= run_node(s)
    changes = describe_changes(before, snapshot())
    print("\n── 今次改動 ──")
    print("\n".join(f"  · {l}" for l in changes) or "  （資料冇變：同現有一樣）")
    print("\n── 未來 14 日預計用邊份 ──")
    if shutil.which("node"):
        out = subprocess.run(["node", os.path.join(HERE, "coverage.mjs"), "--days", "14"], cwd=ROOT, capture_output=True, text=True)
        print(out.stdout.rstrip())  # exit code 2 only means "has warnings"
    print("\n下一步：")
    print("  1. 睇上面「未來 14 日」有冇日子用錯；要指定某日就改 data/calendar.json 嘅 sheets。")
    print("  2. git checkout -b data/<日期>；git add data; git commit；開 PR（改動只應有 data/ 同 docs/）。")
    print("  3. 合併後 Cloudflare 自動部署。")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
