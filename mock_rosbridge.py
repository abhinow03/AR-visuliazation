#!/usr/bin/env python3
"""
mock_rosbridge.py — minimal stand-in for rosbridge_websocket, replicating
ONLY the envelope shape that was verified end-to-end on mars-4090:

    subscribe (client -> server):
        {"op":"subscribe","topic":"/rf/test_emitters","type":"std_msgs/String", ...}
    publish (server -> client):
        {"op":"publish","topic":"/rf/test_emitters","msg":{"data":"[...]"}}

Used only to test ros-feed.js's connect/subscribe/translate/buffer logic
without needing the real ROS 2 + rosbridge_suite stack. Supports two modes
via query string so the SAME server can exercise reconnect/staleness logic:
  ws://host:port/            normal: publishes at ~5Hz forever
  ws://host:port/?dropafter=5   publishes 5 messages then goes silent
  ws://host:port/?malformed=1   occasionally sends a broken entry
"""
import asyncio
import json
import time
from urllib.parse import urlparse, parse_qs
import websockets

TOPIC = "/rf/test_emitters"

def make_batch(t, malformed=False):
    batch = [
        {"id": "EMT-001", "cls": "controller", "confidence": 0.8,
         "pos": [10 + t, 3, -5], "vel": [0.5, 0, 0]},
        {"id": "EMT-002", "cls": "enemy", "confidence": 0.7,
         "pos": [-4, 2, 8 + t*0.5], "vel": [0, 0, 0.3]},
        {"id": "EMT-003", "cls": "walkie", "confidence": 0.6,
         "pos": [0, 1.5, 0], "vel": [0, 0, 0]},
    ]
    if malformed:
        batch.append({"id": "EMT-BAD", "pos": "not-an-array"})  # should be dropped, not crash
    return batch

async def handler(ws):
    qs = parse_qs(urlparse(ws.request.path).query) if hasattr(ws, 'request') else {}
    dropafter = int(qs.get('dropafter', [0])[0])
    malformed = qs.get('malformed', ['0'])[0] == '1'

    subscribed = False
    async def reader():
        nonlocal subscribed
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if msg.get('op') == 'subscribe' and msg.get('topic') == TOPIC:
                subscribed = True

    reader_task = asyncio.create_task(reader())
    t0 = time.time()
    n = 0
    try:
        while True:
            if subscribed:
                if dropafter and n >= dropafter:
                    await asyncio.sleep(3600)  # go silent, simulate feed dying
                t = time.time() - t0
                batch = make_batch(t, malformed and n % 4 == 3)
                env = {"op": "publish", "topic": TOPIC, "msg": {"data": json.dumps(batch)}}
                await ws.send(json.dumps(env))
                n += 1
            await asyncio.sleep(0.2)   # 5Hz
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        reader_task.cancel()

async def main():
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9090
    async with websockets.serve(handler, "0.0.0.0", port):
        print(f"mock rosbridge listening on ws://0.0.0.0:{port}")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
