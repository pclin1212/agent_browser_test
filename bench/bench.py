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

默认入口为仓库 html/index.html（file:// 协议），报告输出到 bench/ 目录
（bench-report.md + bench-results.json）。

每个 run 都使用独立的一次性状态目录（socket + Chrome profile），互不干扰；
daemon 空闲 15s 后自动退出，Chrome 随之关闭，系统零残留。
"""

import argparse
import json
import math
import os
import platform
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


def run_once(idx, base_cmd, page_url, cmd_timeout):
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
        for name, args in STEPS:
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
    ap.add_argument("--out", default=os.path.join(HERE, "bench"),
                    help="报告输出路径前缀（默认 bench/bench）")
    args = ap.parse_args()

    if args.runs < 1 or args.concurrency < 1:
        sys.exit("错误：runs/concurrency 需 >= 1")
    page_url = args.url or ("file://" + DEFAULT_PAGE)
    base_cmd = resolve_bin(args.bin)

    print(f"[bench] runs={args.runs} concurrency={args.concurrency}")
    print(f"[bench] 入口: {page_url}")
    print(f"[bench] 命令: {' '.join(base_cmd)}")

    results = [None] * args.runs
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futs = {pool.submit(run_once, i, base_cmd, page_url, args.timeout): i
                for i in range(args.runs)}
        for fut in as_completed(futs):
            r = fut.result()
            results[r["run"]] = r
            status = "OK" if r["ok"] else f"FAIL ({r['err']})"
            print(f"[bench] run {r['run'] + 1}/{args.runs} 完成: "
                  f"wall={r['wall_ms']:.0f}ms  steps={r['steps_sum_ms']:.0f}ms  {status}")
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
        "total_wall_ms": round(total_wall, 1),
        "ok": len(ok_runs),
        "fail": len(fail_runs),
        "run_wall_stats": run_stats,
        "step_stats": step_stats,
        "raw": results,
    }
    json_path = f"{args.out}-results.json"
    md_path = f"{args.out}-report.md"
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

    print(f"\n[bench] 报告已写入: {md_path}")
    print(f"[bench] 原始数据已写入: {json_path}")
    sys.exit(0 if not fail_runs else 2)


if __name__ == "__main__":
    main()
