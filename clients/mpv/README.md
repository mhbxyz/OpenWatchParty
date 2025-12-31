# MPV Client

MPV script adapter using JSON IPC.

## PoC adapter

`opensyncparty.py` connects to the session server and MPV's JSON IPC socket.

Usage:

```bash
mpv --input-ipc-server=/tmp/mpv-socket /path/to/video.mp4
make mpv-host ROOM=my-room
```

Host avec auth:

```bash
make mpv-host ROOM=my-room ARGS="--auth-token <JWT>"
```

For a joiner:

```bash
make mpv-join ROOM=my-room
```

Auth/invite:

```bash
make mpv-join ROOM=my-room ARGS="--auth-token <JWT> --invite-token <INVITE>"
```

The adapter prints RTT samples every few seconds to help gauge latency.
