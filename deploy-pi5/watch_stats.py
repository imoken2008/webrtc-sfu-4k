"""ハブの ingest 統計を定期取得し、パケットロス等の変化を追う"""
import json, sys, time, urllib.request

HUB = "http://pi5.local:8080"
N = int(sys.argv[1]) if len(sys.argv) > 1 else 20
INTERVAL = float(sys.argv[2]) if len(sys.argv) > 2 else 6

prev = {}
print(f"  {'時刻':8} {'カメラ':14} {'score':5} {'Mbps':7} {'loss増':6} {'discard増':9} {'nack':5} {'pli':4} {'jitter':6}")
for i in range(N):
    try:
        with urllib.request.urlopen(f"{HUB}/api/ingest/stats", timeout=8) as r:
            data = json.loads(r.read().decode())
    except Exception as e:
        print("  取得失敗:", e); time.sleep(INTERVAL); continue

    for s in data.get("stats", []):
        name = s.get("displayName", s.get("name", "?"))[:14]
        p = (s.get("producer") or [{}])[0]
        sc = (s.get("score") or [{}])[0].get("score", "?")
        lost = p.get("packetsLost", 0) or 0
        disc = p.get("packetsDiscarded", 0) or 0
        key = s.get("name")
        dl = lost - prev.get(key, (0, 0))[0]
        dd = disc - prev.get(key, (0, 0))[1]
        prev[key] = (lost, disc)
        mark = "  ★" if (dl > 0 or dd > 0 or (isinstance(sc, int) and sc < 10)) else ""
        print(f"  {time.strftime('%H:%M:%S')} {name:14} {sc!s:5} "
              f"{(p.get('bitrate',0) or 0)/1e6:7.2f} {dl:6} {dd:9} "
              f"{p.get('nackCount',0):5} {p.get('pliCount',0):4} {p.get('jitter',0):6}{mark}")
    print()
    time.sleep(INTERVAL)
