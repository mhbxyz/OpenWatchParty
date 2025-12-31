# MPV Client

MPV script adapter using JSON IPC.

## PoC adapter

`opensyncparty.py` connects to the session server and MPV's JSON IPC socket.

Usage:

```bash
mpv --input-ipc-server=/tmp/mpv-socket /path/to/video.mp4
make mpv-host ROOM=my-room
```

For a joiner:

```bash
make mpv-join ROOM=my-room
```

The adapter prints RTT samples every few seconds to help gauge latency.
