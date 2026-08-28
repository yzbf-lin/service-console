from __future__ import annotations

import signal
import sys
import time


running = True


def stop(signum: int, _frame: object) -> None:
    global running
    print(f"received-signal={signum}", flush=True)
    running = False


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)

print("ticker-started", flush=True)
print("ticker-stderr", file=sys.stderr, flush=True)
counter = 0
while running:
    print(f"tick={counter}", flush=True)
    counter += 1
    time.sleep(0.1)
print("ticker-stopped", flush=True)
