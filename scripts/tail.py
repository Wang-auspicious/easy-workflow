# Prints the journal of the running factory in a readable form (dev helper).
import json, sys, urllib.request

since = int(sys.argv[1]) if len(sys.argv) > 1 else 0
skip = {"stock.set", "resource.sample", "worker.spawned", "factory.loaded", "token.data", "evidence.added"}
with urllib.request.urlopen("http://127.0.0.1:4317/api/journal") as r:
    for line in r:
        e = json.loads(line)
        if e["seq"] <= since:
            continue
        k = e["kind"]
        if k == "attempt.progress":
            print("      ", e["text"][:130])
            continue
        if k in skip:
            continue
        print(e["seq"], k, {x: str(v)[:90] for x, v in e.items() if x not in ("seq", "at", "run", "kind", "returned")})
