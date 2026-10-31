(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const tracks = OWP.tracks = OWP.tracks || {};
  const state = OWP.state;
  const utils = OWP.utils;

  // Jellyfin keeps the tracks each client plays in its session; a change in
  // the player reaches it within a second. Read this often at most.
  const READ_INTERVAL_MS = 5000;
  const MAX_TITLE_CHARS = 100;
  const LANGUAGE = /^[A-Za-z0-9-]{1,16}$/;

  let reading = false;
  let readAt = -Infinity;
  let readFor = '';

  // What the others see of one stream: its title, its language and, for
  // subtitles, whether it is forced. Nothing about codecs or files.
  const describe = (stream) => {
    if (!stream) return null;
    const track = {};
    const title = typeof stream.Title === 'string' ? stream.Title.replace(/\p{Cc}/gu, ' ').trim() : '';
    if (title) track.title = Array.from(title).slice(0, MAX_TITLE_CHARS).join('').trim();
    if (typeof stream.Language === 'string' && LANGUAGE.test(stream.Language)) track.language = stream.Language;
    if (stream.Type === 'Subtitle' && stream.IsForced === true) track.forced = true;
    return track;
  };

  // This client's tracks for the item it plays, from its own Jellyfin
  // session; null while it plays nothing.
  const readOwnTracks = async () => {
    const api = window.ApiClient;
    const sessions = await api.getSessions({ deviceId: api.deviceId() });
    const item = sessions?.[0]?.NowPlayingItem;
    if (!item) return null;
    const play = sessions[0].PlayState || {};
    const streams = Array.isArray(item.MediaStreams) ? item.MediaStreams : [];
    const find = (type, index) => streams.find(stream => stream.Type === type && stream.Index === index) || null;
    return {
      media_id: String(item.Id).toLowerCase(),
      audio: describe(find('Audio', play.AudioStreamIndex)),
      subtitle: describe(find('Subtitle', play.SubtitleStreamIndex))
    };
  };

  // From the sync loop: reads this client's tracks every READ_INTERVAL_MS, or
  // at once for a new item, and sends them when they changed. Once per room
  // and connection: the server forgets a member's tracks when it leaves.
  tracks.report = () => {
    if (!state.inRoom || !state.roomMediaId || !state.serverFeatures.includes('participant_tracks')) return;
    if (!state.ws || state.ws.readyState !== 1 || reading || !window.ApiClient) return;
    const now = utils.nowMs();
    if (state.roomMediaId === readFor && now - readAt < READ_INTERVAL_MS) return;
    reading = true;
    readAt = now;
    readFor = state.roomMediaId;
    readOwnTracks()
      .then((own) => {
        // Only for the room's item, which may have changed during the read.
        if (!own || !state.inRoom || own.media_id !== String(state.roomMediaId).toLowerCase()) return;
        const key = `${state.roomId}|${state.clientId}|${JSON.stringify(own)}`;
        if (key === state.tracksSentKey || !OWP.actions?.send) return;
        OWP.actions.send('participant_tracks', own);
        state.tracksSentKey = key;
      })
      .catch(err => utils.log('TRACKS', { error: err?.name || 'Error' }))
      .finally(() => { reading = false; });
  };

  // For tests and a fresh start: the next report reads at once.
  tracks.reset = () => {
    reading = false;
    readAt = -Infinity;
    readFor = '';
  };
})();
