#!/usr/bin/env python3
"""agent-browser 指令级基准测试

每次 run 执行完整邮箱闭环（open → 登录 → 收件箱 → 筛选今天 → 读正文 → close），
逐条记录每个 agent-browser 指令的耗时，支持多 run 并发，
汇总 p50/p95/p99/平均/总耗时等统计，输出 JSON + Markdown 报告。

用法（在仓库根目录执行）：
  python3 bench/bench.py                # 5 次运行，无并发
  python3 bench/bench.py -n 10 -c 2     # 10 次运行，2 路并发
  python3 bench/bench.py --bin /path/to/agent-browser
  python3 bench/bench.py --url http://127.0.0.1:8000/index.html

默认入口为仓库 html/index.html（file:// 协议），报告输出到仓库根目录
output/bench/（bench-report.md + bench-results.json），
运行产物统一收纳在 output/ 目录。

每个 run 都使用独立的一次性状态目录（socket + Chrome profile），互不干扰；
daemon 空闲 15s 后自动退出，Chrome 随之关闭，系统零残留。
"""

import argparse
import glob as _glob
import json
import math
import os
import platform
import random
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # 仓库根目录
DEFAULT_PAGE = os.path.join(ROOT, "html", "index.html")


def default_out_dir(args):
    """默认产物目录：output/bench_c<并发>_n<次数>_<时间戳>。

    每次运行独立目录，本次任务的所有产物（报告 / 原始 JSON / 失败截图）
    都收纳在该目录下，天然不覆盖、不需要额外归档。
    """
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return os.path.join(ROOT, "output",
                        f"bench_c{args.concurrency}_n{args.runs}_{stamp}")


STEPS = [
    ("open_login",    ["open", "{PAGE_URL}"]),
    ("wait_open",     ["wait", "--load", "networkidle"]),
    ("fill_username", ["fill", "#username", "2021001234"]),
    ("fill_password", ["fill", "#password", "Jack@2024"]),
    ("click_login",   ["click", "#login-button"]),
    ("wait_home",     ["wait", "--load", "networkidle"]),
    ("click_inbox",   ["click", "#inbox-entry"]),
    ("wait_inbox",    ["wait", "--load", "networkidle"]),
    ("select_today",  ["select", "#date-filter", "今天"]),
    ("click_search",  ["click", "#search-button"]),
    ("wait_filter",   ["wait", "--load", "networkidle"]),
    ("click_mail",    ["click", "#filtered-result a.mail-item"]),
    ("wait_detail",   ["wait", "--load", "networkidle"]),
    ("get_text",      ["get", "text", "article[aria-label='邮件正文']"]),
    ("close",         ["close"]),
    ("session_list",  ["session", "list"]),
]


def resolve_bin(user_bin):
    """定位 agent-browser 可执行命令（返回 argv 列表）"""
    if user_bin:
        return [user_bin]
    p = shutil.which("agent-browser")
    if p:
        return [p]
    npx = shutil.which("npx")
    if npx:
        return [npx, "-y", "agent-browser"]
    sys.exit("错误：找不到 agent-browser（PATH/npx 均无），请安装或用 --bin 指定")


def percentile(sorted_vals, p):
    """线性插值百分位，输入需已升序"""
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * p / 100.0
    f, c = math.floor(k), math.ceil(k)
    if f == c:
        return sorted_vals[int(k)]
    return sorted_vals[f] * (c - k) + sorted_vals[c] * (k - f)


def stat_block(vals):
    """一组耗时(ms)的统计摘要"""
    if not vals:
        return {"n": 0}
    s = sorted(vals)
    return {
        "n": len(s),
        "min": round(s[0], 1),
        "p50": round(percentile(s, 50), 1),
        "mean": round(statistics.fmean(s), 1),
        "p95": round(percentile(s, 95), 1),
        "p99": round(percentile(s, 99), 1),
        "max": round(s[-1], 1),
    }


def fmt_dur(sec):
    """秒数 → 人类可读时长（89 -> "1m29s"）"""
    sec = int(sec)
    if sec < 60:
        return f"{sec}s"
    m, s = divmod(sec, 60)
    if m < 60:
        return f"{m}m{s:02d}s"
    h, m = divmod(m, 60)
    return f"{h}h{m:02d}m"


def show_progress(prefix, detail, done, total, t0):
    """执行进度显示。

    TTY（交互终端）：单行原地刷新进度条 + 百分比 + ETA + 最近完成事件；
    重定向到文件/管道：逐行输出（带计数与 ETA），并强制 flush，
    保证 tail -f 日志能实时看到进展。
    """
    elapsed = max(time.perf_counter() - t0, 1e-6)
    eta = elapsed / done * (total - done) if done else 0
    pct = 100.0 * done / total
    if sys.stdout.isatty():
        width = 26
        filled = int(width * done / total)
        bar = "#" * filled + "-" * (width - filled)
        print(f"\r{prefix} |{bar}| {pct:5.1f}% ETA {fmt_dur(eta)} | "
              f"{detail[:60]:<60}", end="", flush=True)
        if done >= total:
            print(flush=True)
    else:
        print(f"{prefix} ({pct:.0f}%, ETA {fmt_dur(eta)}) {detail}", flush=True)


def think_sleep(think_ms, jitter_pct):
    """指令间思考时间：模拟大模型生成下一条指令的间隙（含 ±jitter% 抖动）。

    think_ms<=0 时是空操作（默认关闭，不影响既有口径的可比性）。
    """
    if think_ms <= 0:
        return 0.0
    jitter = think_ms * jitter_pct / 100.0
    delay = random.uniform(think_ms - jitter, think_ms + jitter)
    time.sleep(delay / 1000.0)
    return delay


def run_once(idx, base_cmd, page_url, cmd_timeout, think_ms=0, jitter_pct=0):
    """执行一次完整闭环，返回该 run 的计时数据"""
    iso = tempfile.mkdtemp(prefix=f"mail-bench-{idx}-")
    env = os.environ.copy()
    env["AGENT_BROWSER_SOCKET_DIR"] = iso
    env["AGENT_BROWSER_PROFILE"] = os.path.join(iso, "profile")
    # daemon 空闲 15s 自动退出（Chrome 随之关闭），避免并发后残留进程
    env["AGENT_BROWSER_IDLE_TIMEOUT_MS"] = "15000"

    timings = []
    wall0 = time.perf_counter()
    ok, err = True, None
    try:
        for si, (name, args) in enumerate(STEPS):
            if si:  # 指令间思考时间（首条指令前不加）
                think_sleep(think_ms, jitter_pct)
            argv = base_cmd + [a.replace("{PAGE_URL}", page_url) for a in args]
            t = time.perf_counter()
            r = subprocess.run(argv, env=env, capture_output=True,
                               text=True, timeout=cmd_timeout)
            ms = (time.perf_counter() - t) * 1000
            timings.append({"step": name, "ms": round(ms, 1), "rc": r.returncode})
            if r.returncode != 0:
                ok, err = False, f"{name}: {(r.stderr or r.stdout).strip()[:300]}"
                # 尽力收尾，关掉已启动的浏览器
                subprocess.run(base_cmd + ["close"], env=env,
                               capture_output=True, timeout=30)
                break
    except subprocess.TimeoutExpired:
        ok, err = False, "命令执行超时"
        subprocess.run(base_cmd + ["close"], env=env,
                       capture_output=True, timeout=30)
    finally:
        shutil.rmtree(iso, ignore_errors=True)

    wall = (time.perf_counter() - wall0) * 1000
    return {
        "run": idx,
        "ok": ok,
        "err": err,
        "wall_ms": round(wall, 1),
        "steps_sum_ms": round(sum(t["ms"] for t in timings), 1),
        "steps": timings,
    }


def fmt_stats(s):
    if s.get("n", 0) == 0:
        return "n=0"
    return (f"n={s['n']}  min={s['min']}  p50={s['p50']}  mean={s['mean']}  "
            f"p95={s['p95']}  p99={s['p99']}  max={s['max']}  (单位 ms)")


# ---------------- 用例合集模式（--cases） ----------------

def load_cases(case_dir):
    """加载 cases/*.json 用例合集"""
    paths = sorted(_glob.glob(os.path.join(case_dir, "*.json")))
    if not paths:
        sys.exit(f"错误：{case_dir} 下没有找到 *.json 用例文件")
    cases = []
    for p in paths:
        with open(p, encoding="utf-8") as f:
            c = json.load(f)
        c.setdefault("name", os.path.splitext(os.path.basename(p))[0])
        for field in ("env", "start_url", "steps"):
            if field not in c:
                sys.exit(f"错误：用例 {p} 缺少字段 {field}")
        cases.append(c)
    return cases


def eval_assert(base_cmd, env, a, cmd_timeout):
    """执行单条功能断言，返回 (ok, got, err)"""
    argv = base_cmd + list(a["cmd"])
    try:
        r = subprocess.run(argv, env=env, capture_output=True,
                           text=True, timeout=cmd_timeout)
    except subprocess.TimeoutExpired:
        return False, "", "命令执行超时"
    out = r.stdout.strip()
    if r.returncode != 0:
        return False, out[:200], (r.stderr or r.stdout).strip()[:200]
    op = a.get("op", "contains")
    exp = a.get("expect", "")
    if op == "contains":
        if isinstance(exp, list):  # 单值 list 容错：逐个包含
            return all(e in out for e in exp), out, None
        return exp in out, out, None
    if op == "contains_all":
        return all(e in out for e in exp), out, None
    if op == "contains_any":
        return any(e in out for e in exp), out, None
    if op == "equals":
        return out == exp, out, None
    if op == "re":
        return re.search(exp, out) is not None, out, None
    if op == "nonempty":
        return bool(out), out, None
    return False, out, f"未知断言算子: {op}"


def run_case_once(case, idx, base_cmd, cmd_timeout, failures_dir,
                  think_ms=0, jitter_pct=0):
    """执行一个用例的一次完整运行：steps（指令层）+ asserts（功能层）

    指令成功 = 所有 steps 命令 rc==0；
    功能成功 = 指令成功 且 所有 asserts 通过。
    任一层失败都会自动截图留证到 failures_dir。
    """
    # 目录名务必短：Unix socket 路径上限 103 字节，长用例名会超限
    iso = tempfile.mkdtemp(prefix=f"c{idx % 100}-{os.getpid()}-")
    env = os.environ.copy()
    env["AGENT_BROWSER_SOCKET_DIR"] = iso
    env["AGENT_BROWSER_PROFILE"] = os.path.join(iso, "profile")
    env["AGENT_BROWSER_IDLE_TIMEOUT_MS"] = "15000"

    shots = []

    def snap(tag):
        try:
            os.makedirs(failures_dir, exist_ok=True)
            path = os.path.join(
                failures_dir,
                f"{case['name']}__run{idx}__{tag}__{time.strftime('%H%M%S')}.png")
            subprocess.run(base_cmd + ["screenshot", path], env=env,
                           capture_output=True, timeout=30)
            if os.path.exists(path):
                shots.append(path)
        except Exception:
            pass

    timings, assert_log = [], []
    instr_ok, func_ok = True, True
    err = None
    wall0 = time.perf_counter()
    try:
        base = case.get("base_url", "")
        for si, args in enumerate(case["steps"]):
            if si:  # 指令间思考时间（首条指令前不加；断言命令不加）
                think_sleep(think_ms, jitter_pct)
            argv = base_cmd + [a.replace("{start_url}", case["start_url"])
                               .replace("{BASE}", base) for a in args]
            t = time.perf_counter()
            try:
                r = subprocess.run(argv, env=env, capture_output=True,
                                   text=True, timeout=cmd_timeout)
                ms = (time.perf_counter() - t) * 1000
                timings.append({"step": si, "cmd": args[0],
                                "detail": " ".join(args[:2]),
                                "ms": round(ms, 1), "rc": r.returncode})
                if r.returncode != 0:
                    instr_ok = False
                    err = (f"step {si} ({' '.join(args)[:120]}): "
                           f"{(r.stderr or r.stdout).strip()[:250]}")
                    snap(f"step{si}")
                    break
            except subprocess.TimeoutExpired:
                timings.append({"step": si, "cmd": args[0],
                                "detail": " ".join(args[:2]),
                                "ms": round((time.perf_counter() - t) * 1000, 1),
                                "rc": -1})
                instr_ok, err = False, f"step {si} ({args[0]}): 命令执行超时"
                snap(f"step{si}")
                break
        if not instr_ok:
            func_ok = False  # 指令失败 ⇒ 功能必然失败
        elif case.get("asserts"):
            for a in case["asserts"]:
                ok, got, aerr = eval_assert(base_cmd, env, a, cmd_timeout)
                assert_log.append({"desc": a.get("desc", ""),
                                   "op": a.get("op", "contains"),
                                   "expect": a.get("expect", ""),
                                   "ok": ok, "got": got[:300]})
                if not ok:
                    func_ok = False
            if not func_ok:
                bad = next((x for x in assert_log if not x["ok"]), None)
                if bad:
                    err = f"断言失败 [{bad['desc']}]: got={bad['got'][:150]}"
                snap("assert")
    finally:
        subprocess.run(base_cmd + ["close"], env=env,
                       capture_output=True, timeout=30)
        shutil.rmtree(iso, ignore_errors=True)

    wall = (time.perf_counter() - wall0) * 1000
    return {
        "run": idx,
        "case": case["name"],
        "category": case.get("category", ""),
        "instr_ok": instr_ok,
        "func_ok": func_ok,
        "err": err,
        "wall_ms": round(wall, 1),
        "steps": timings,
        "asserts": assert_log,
        "screenshots": shots,
    }


def run_cases_mode(args, base_cmd):
    """用例合集模式：遍历 cases、跑 N 轮、双成功率 + 指令分桶统计"""
    cases = load_cases(args.cases)
    failures_dir = os.path.join(args.out, "failures")
    os.makedirs(args.out, exist_ok=True)
    print(f"[cases] 用例数: {len(cases)}，每个 {args.runs} 次，"
          f"并发 {args.concurrency}，共 {len(cases) * args.runs} 次运行")
    print(f"[cases] 合集: {args.cases}")
    if args.think_time:
        print(f"[cases] 思考时间: {args.think_time}ms ±{args.think_jitter}%"
              f"（指令间，模拟 LLM 生成间隙）")
    print(f"[cases] 产物目录: {args.out}")

    jobs = [(c, i) for c in cases for i in range(args.runs)]
    results = []
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futs = {pool.submit(run_case_once, c, i, base_cmd,
                            args.timeout, failures_dir,
                            args.think_time, args.think_jitter): (c, i)
                for c, i in jobs}
        for fut in as_completed(futs):
            r = fut.result()
            results.append(r)
            tag = ("OK" if r["func_ok"] else
                   ("INSTR-FAIL" if not r["instr_ok"] else "ASSERT-FAIL"))
            detail = (f"{r['case']} run{r['run'] + 1}: "
                      f"wall={r['wall_ms']:.0f}ms  {tag}"
                      + (f"  {r['err']}" if tag != "OK" else ""))
            show_progress(f"[cases] {len(results)}/{len(jobs)}",
                          detail, len(results), len(jobs), t0)
    total_wall = (time.perf_counter() - t0) * 1000

    # ---- 汇总 ----
    instr_ok_n = sum(1 for r in results if r["instr_ok"])
    func_ok_n = sum(1 for r in results if r["func_ok"])
    per_case = {}
    for c in cases:
        rs = [r for r in results if r["case"] == c["name"]]
        per_case[c["name"]] = {
            "category": c.get("category", ""),
            "env": c.get("env", ""),
            "runs": len(rs),
            "instr_ok": sum(1 for r in rs if r["instr_ok"]),
            "func_ok": sum(1 for r in rs if r["func_ok"]),
            "wall_stats": stat_block([r["wall_ms"] for r in rs if r["func_ok"]]),
        }
    # 指令分桶：按命令动词聚合（仅统计成功 run 的指令）
    buckets = {}
    for r in results:
        if not r["instr_ok"]:
            continue
        for t in r["steps"]:
            buckets.setdefault(t["cmd"], []).append(t["ms"])
    bucket_stats = {k: stat_block(v) for k, v in sorted(buckets.items())}
    # 分类聚合
    per_cat = {}
    for c in cases:
        cat = c.get("category", "uncategorized")
        rs = [r for r in results if r["case"] == c["name"]]
        d = per_cat.setdefault(cat, {"runs": 0, "instr_ok": 0, "func_ok": 0})
        d["runs"] += len(rs)
        d["instr_ok"] += sum(1 for r in rs if r["instr_ok"])
        d["func_ok"] += sum(1 for r in rs if r["func_ok"])

    # ---- 控制台输出 ----
    n_total = len(results)
    print(f"\n===== 总览：{n_total} 次运行 =====")
    print(f"指令成功率: {instr_ok_n}/{n_total}"
          f" ({100 * instr_ok_n / n_total:.1f}%)")
    print(f"功能成功率: {func_ok_n}/{n_total}"
          f" ({100 * func_ok_n / n_total:.1f}%)")
    print(f"整体耗时: {total_wall:.0f}ms")
    print("\n===== 各用例 =====")
    print(f"{'case':<38}{'instr':>8}{'func':>8}{'p50(ms)':>10}{'p95(ms)':>10}")
    for name, d in per_case.items():
        ws = d["wall_stats"]
        p50 = f"{ws['p50']:.0f}" if ws.get("n") else "-"
        p95 = f"{ws['p95']:.0f}" if ws.get("n") else "-"
        print(f"{name:<38}"
              f"{d['instr_ok']}/{d['runs']:>4}{d['func_ok']}/{d['runs']:>4}"
              f"{p50:>10}{p95:>10}")
    print("\n===== 指令分桶耗时 (成功 run, ms) =====")
    print(f"{'bucket':<12}{'n':>5}{'p50':>10}{'mean':>10}{'p95':>10}{'max':>10}")
    for k, s in bucket_stats.items():
        if s.get("n", 0) == 0:
            continue
        print(f"{k:<12}{s['n']:>5}{s['p50']:>10}{s['mean']:>10}"
              f"{s['p95']:>10}{s['max']:>10}")
    fails = [r for r in results if not r["func_ok"]]
    if fails:
        print(f"\n===== 失败明细（{len(fails)}，截图见 {failures_dir}）=====")
        for r in fails:
            print(f"  {r['case']} run{r['run'] + 1}: {r['err']}")

    # ---- 落盘 ----
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    report = {
        "timestamp": ts,
        "mode": "cases",
        "cases_dir": args.cases,
        "command": " ".join(base_cmd),
        "platform": f"{platform.system()} {platform.release()} ({platform.machine()})",
        "runs_per_case": args.runs,
        "concurrency": args.concurrency,
        "think_time_ms": args.think_time,
        "think_jitter_pct": args.think_jitter,
        "total_wall_ms": round(total_wall, 1),
        "instr_ok": instr_ok_n,
        "func_ok": func_ok_n,
        "total": n_total,
        "per_case": per_case,
        "per_category": per_cat,
        "bucket_stats": bucket_stats,
        "raw": results,
    }
    json_path = os.path.join(args.out, "cases-results.json")
    md_path = os.path.join(args.out, "cases-report.md")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    lines = [
        "# agent-browser 用例合集基准报告",
        "",
        f"- 时间：{ts}",
        f"- 平台：{report['platform']}",
        f"- 合集：`{args.cases}`（{len(cases)} 个用例，每个 {args.runs} 次，"
        f"并发 {args.concurrency}）",
        f"- 思考时间：{args.think_time}ms ±{args.think_jitter}%"
        + ("" if args.think_time else "（关闭）"),
        f"- 结果：指令成功 {instr_ok_n}/{n_total}，功能成功 {func_ok_n}/{n_total}",
        "",
        "## 成功率",
        "",
        "| 口径 | 数值 |",
        "|---|---|",
        f"| 指令成功率（所有命令 rc==0） | {instr_ok_n}/{n_total} "
        f"({100 * instr_ok_n / n_total:.1f}%) |",
        f"| 功能成功率（断言全部通过） | {func_ok_n}/{n_total} "
        f"({100 * func_ok_n / n_total:.1f}%) |",
        "",
        "## 各用例",
        "",
        "| 用例 | 分类 | 指令成功 | 功能成功 | wall p50 (ms) | wall p95 (ms) |",
        "|---|---|---|---|---|---|",
    ]
    for name, d in per_case.items():
        ws = d["wall_stats"]
        p50 = f"{ws['p50']:.0f}" if ws.get("n") else "-"
        p95 = f"{ws['p95']:.0f}" if ws.get("n") else "-"
        lines.append(f"| {name} | {d['category']} | {d['instr_ok']}/{d['runs']} | "
                     f"{d['func_ok']}/{d['runs']} | {p50} | {p95} |")
    lines += ["", "## 指令分桶耗时（成功 run，ms）", "",
              "| 指令 | n | p50 | mean | p95 | max |",
              "|---|---|---|---|---|---|"]
    for k, s in bucket_stats.items():
        if s.get("n", 0) == 0:
            continue
        lines.append(f"| {k} | {s['n']} | {s['p50']} | {s['mean']} | "
                     f"{s['p95']} | {s['max']} |")
    lines += ["", "## 分类聚合", "", "| 分类 | 指令成功 | 功能成功 |",
              "|---|---|---|"]
    for cat, d in per_cat.items():
        lines.append(f"| {cat} | {d['instr_ok']}/{d['runs']} | "
                     f"{d['func_ok']}/{d['runs']} |")
    if fails:
        lines += ["", "## 失败明细", ""]
        for r in fails:
            lines.append(f"- **{r['case']}** run {r['run'] + 1}: `{r['err']}`")
            for s in r.get("screenshots", []):
                lines.append(f"  - 截图：`{s}`")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"\n[cases] 本次运行目录: {args.out}"
          f"\n[cases] 报告: {md_path}\n[cases] 数据: {json_path}")
    sys.exit(0 if not fails else 2)


def main():
    ap = argparse.ArgumentParser(description="agent-browser 指令级基准测试")
    ap.add_argument("-n", "--runs", type=int, default=5, help="总运行次数（默认 5）")
    ap.add_argument("-c", "--concurrency", type=int, default=1,
                    help="并发 worker 数（默认 1）")
    ap.add_argument("--url", default=None,
                    help="入口页面 URL（默认 file://<仓库>/html/index.html）")
    ap.add_argument("--bin", default=os.environ.get("AGENT_BROWSER_BIN"),
                    help="agent-browser 可执行文件路径（默认从 PATH/npx 查找）")
    ap.add_argument("--timeout", type=float, default=180,
                    help="单条命令超时秒数（默认 180）")
    ap.add_argument("--think-time", type=int, default=0, metavar="MS",
                    help="指令间思考时间 ms，模拟大模型生成下一条指令的间隙"
                         "（默认 0=关闭；仅插入 steps 之间，首条前与断言命令不加）")
    ap.add_argument("--think-jitter", type=int, default=30, metavar="PCT",
                    help="思考时间随机抖动 ±百分比（默认 30；think-time=0 时忽略）")
    ap.add_argument("--out", default=None, metavar="DIR",
                    help="产物目录（默认自动生成 output/bench_c<并发>_n<次数>_<时间戳>，"
                         "每次运行独立目录，互不覆盖）")
    ap.add_argument("--cases", default=None, metavar="DIR",
                    help="用例合集模式：指定 cases/ 目录，遍历其中 *.json "
                         "（报告/数据/失败截图均在本次运行目录内）")
    args = ap.parse_args()

    if args.runs < 1 or args.concurrency < 1:
        sys.exit("错误：runs/concurrency 需 >= 1")
    if args.think_time < 0:
        sys.exit("错误：think-time 需 >= 0")
    if not 0 <= args.think_jitter <= 100:
        sys.exit("错误：think-jitter 需在 0~100 之间")
    if not args.out:
        args.out = default_out_dir(args)
    base_cmd = resolve_bin(args.bin)

    if args.cases:
        run_cases_mode(args, base_cmd)  # 内部在结束时 sys.exit()

    page_url = args.url or ("file://" + DEFAULT_PAGE)

    print(f"[bench] runs={args.runs} concurrency={args.concurrency}")
    print(f"[bench] 入口: {page_url}")
    print(f"[bench] 命令: {' '.join(base_cmd)}")
    if args.think_time:
        print(f"[bench] 思考时间: {args.think_time}ms ±{args.think_jitter}%"
              f"（指令间，模拟 LLM 生成间隙）")
    print(f"[bench] 产物目录: {args.out}")

    results = [None] * args.runs
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futs = {pool.submit(run_once, i, base_cmd, page_url, args.timeout,
                            args.think_time, args.think_jitter): i
                for i in range(args.runs)}
        for fut in as_completed(futs):
            r = fut.result()
            results[r["run"]] = r
            done = sum(1 for x in results if x)
            status = "OK" if r["ok"] else f"FAIL ({r['err']})"
            detail = (f"run {r['run'] + 1}: wall={r['wall_ms']:.0f}ms  "
                      f"steps={r['steps_sum_ms']:.0f}ms  {status}")
            show_progress(f"[bench] {done}/{args.runs}", detail,
                          done, args.runs, t0)
    total_wall = (time.perf_counter() - t0) * 1000

    ok_runs = [r for r in results if r and r["ok"]]
    fail_runs = [r for r in results if r and not r["ok"]]

    run_stats = stat_block([r["wall_ms"] for r in ok_runs])
    step_stats = {}
    for name, _ in STEPS:
        vals = [t["ms"] for r in ok_runs for t in r["steps"] if t["step"] == name]
        step_stats[name] = stat_block(vals)

    # ---- 控制台输出 ----
    print("\n===== Run 总耗时 =====")
    print(fmt_stats(run_stats))
    print(f"\n整体: {len(ok_runs)} ok / {len(fail_runs)} fail, "
          f"总耗时 {total_wall:.0f}ms")
    if fail_runs:
        for r in fail_runs:
            print(f"  失败 run {r['run'] + 1}: {r['err']}")
    print("\n===== 各指令耗时 (跨成功 run 聚合) =====")
    header = f"{'step':<15}{'n':>4}{'min':>9}{'p50':>9}{'mean':>9}{'p95':>9}{'p99':>9}{'max':>9}"
    print(header)
    for name, _ in STEPS:
        s = step_stats[name]
        if s.get("n", 0) == 0:
            continue
        print(f"{name:<15}{s['n']:>4}{s['min']:>9}{s['p50']:>9}{s['mean']:>9}"
              f"{s['p95']:>9}{s['p99']:>9}{s['max']:>9}")

    # ---- 落盘报告 ----
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    report = {
        "timestamp": ts,
        "page_url": page_url,
        "command": " ".join(base_cmd),
        "platform": f"{platform.system()} {platform.release()} ({platform.machine()})",
        "runs": args.runs,
        "concurrency": args.concurrency,
        "think_time_ms": args.think_time,
        "think_jitter_pct": args.think_jitter,
        "total_wall_ms": round(total_wall, 1),
        "ok": len(ok_runs),
        "fail": len(fail_runs),
        "run_wall_stats": run_stats,
        "step_stats": step_stats,
        "raw": results,
    }
    json_path = os.path.join(args.out, "bench-results.json")
    md_path = os.path.join(args.out, "bench-report.md")
    os.makedirs(args.out, exist_ok=True)
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    lines = [
        "# agent-browser 指令级基准测试报告",
        "",
        f"- 时间：{ts}",
        f"- 平台：{report['platform']}",
        f"- 入口：{page_url}",
        f"- 命令：`{' '.join(base_cmd)}`",
        f"- 参数：runs={args.runs}, concurrency={args.concurrency}",
        f"- 思考时间：{args.think_time}ms ±{args.think_jitter}%"
        + ("" if args.think_time else "（关闭）"),
        f"- 结果：{len(ok_runs)} ok / {len(fail_runs)} fail，整体总耗时 {total_wall:.0f} ms",
        "",
        "## Run 总耗时统计（ms）",
        "",
        "| n | min | p50 | mean | p95 | p99 | max |",
        "|---|---|---|---|---|---|---|",
    ]
    if run_stats.get("n", 0) > 0:
        lines.append(f"| {run_stats['n']} | {run_stats['min']} | {run_stats['p50']} | "
                     f"{run_stats['mean']} | {run_stats['p95']} | {run_stats['p99']} | "
                     f"{run_stats['max']} |")
    lines += ["", "## 各指令耗时统计（ms，跨成功 run 聚合）", "",
              "| 指令 | n | min | p50 | mean | p95 | p99 | max |",
              "|---|---|---|---|---|---|---|---|"]
    for name, _ in STEPS:
        s = step_stats[name]
        if s.get("n", 0) == 0:
            continue
        lines.append(f"| {name} | {s['n']} | {s['min']} | {s['p50']} | {s['mean']} | "
                     f"{s['p95']} | {s['p99']} | {s['max']} |")
    if fail_runs:
        lines += ["", "## 失败记录", ""]
        for r in fail_runs:
            lines.append(f"- run {r['run'] + 1}: `{r['err']}`")
    lines += ["", "## 各 Run 明细", "",
              "| run | 结果 | wall (ms) | 指令累计 (ms) |",
              "|---|---|---|---|"]
    for r in results:
        lines.append(f"| {r['run'] + 1} | {'OK' if r['ok'] else 'FAIL'} | "
                     f"{r['wall_ms']:.0f} | {r['steps_sum_ms']:.0f} |")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print(f"\n[bench] 本次运行目录: {args.out}")
    print(f"[bench] 报告已写入: {md_path}")
    print(f"[bench] 原始数据已写入: {json_path}")
    sys.exit(0 if not fail_runs else 2)


if __name__ == "__main__":
    main()
