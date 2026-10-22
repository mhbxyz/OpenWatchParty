---
title: "Technical glossary"
---

<span id="technical-glossary" class="legacy-anchor"></span>

These terms describe the playback and networking behavior referenced throughout the developer documentation.

| Term | Full name | Meaning |
| --- | --- | --- |
| HLS | HTTP Live Streaming | Adaptive streaming that breaks video into small segments. Jellyfin can use it for transcoded content. |
| RTT | Round-trip time | Time for a message to reach the server and return. The room bar displays the measured latency. |
| EMA | Exponential moving average | Smoothing used in clock synchronization to reduce sudden changes in the estimated time offset. |
| JWT | JSON Web Token | A signed token carrying identity claims for session authentication. |
| CORS | Cross-origin resource sharing | Browser rules governing HTTP requests across origins. WebSocket origin validation is configured separately on the session server. |
| WebSocket | — | A persistent, bidirectional connection used for playback events, room activity and chat. |
| Drift | — | The difference between expected and actual playback position. The client can adjust playback speed or seek to correct it. |
| Host | — | The participant who controls room seeking and the episode queue. Play and pause are shared with guests. |
