#!/usr/bin/env python3
"""Deterministic synthetic orders, with the defects the ETL job is meant to remove.

Usage: generate_orders.py <output-dir> [rows-per-day] [days]
Writes <output-dir>/orders/dt=YYYY-MM-DD/orders.csv for each day and prints, as JSON, the number of rows per day that
survive cleaning (a valid order id, a positive amount, one row per order id).
"""
import csv
import os
import random
import sys
from datetime import datetime, timedelta

out_dir = sys.argv[1]
per_day = int(sys.argv[2]) if len(sys.argv) > 2 else 20000
n_days = int(sys.argv[3]) if len(sys.argv) > 3 else 3
rng = random.Random(42)
products = ["keyboard", "mouse", "monitor", "dock", "headset", "webcam", "cable", "laptop-stand"]
days = [(datetime(2026, 10, 1) + timedelta(days=i)).date() for i in range(n_days)]

import json

valid = {}
for day in days:
    valid_ids = set()
    path = os.path.join(out_dir, "orders", f"dt={day}")
    os.makedirs(path, exist_ok=True)
    rows = []
    for n in range(per_day):
        order_id = f"{day:%Y%m%d}-{n:06d}"
        ts = datetime.combine(day, datetime.min.time()) + timedelta(seconds=rng.randrange(86400))
        rows.append([order_id, f"C{rng.randrange(5000):05d}", rng.choice(products), rng.randrange(1, 6), f"{rng.uniform(5, 900):.2f}", ts.isoformat(sep=" ")])
    # defects: duplicated exports, a missing order id, a negative amount
    for _ in range(per_day // 100):
        rows.append(list(rng.choice(rows)))
    for row in rng.sample(rows[:per_day], per_day // 400):
        row[0] = ""
    for row in rng.sample(rows[:per_day], per_day // 700):
        row[4] = f"-{row[4]}"
    rng.shuffle(rows)
    with open(os.path.join(path, "orders.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["order_id", "customer_id", "product", "quantity", "amount", "order_ts"])
        w.writerows(rows)
    for r in rows:
        if r[0] and not r[4].startswith("-"):
            valid_ids.add(r[0])
    valid[str(day)] = len(valid_ids)
print(json.dumps(valid))
