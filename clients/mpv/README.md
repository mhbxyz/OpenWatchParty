# MPV Client

MPV script adapter using JSON IPC.

## PoC adapter

`opensyncparty.py` connects to the session server and MPV's JSON IPC socket.

Usage:

```bash
mpv --input-ipc-server=/tmp/mpv-socket /path/to/video.mp4
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python opensyncparty.py --room my-room --host
```

For a joiner:

```bash
python opensyncparty.py --room my-room
```

The adapter prints RTT samples every few seconds to help gauge latency.
