(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};

  const MAX_POSITION = 86400;
  const MAX_PARTICIPANTS = 20;
  const MAX_NAME_LENGTH = 100;
  const MAX_ROOM_NAME_LENGTH = 128;
  const MAX_CHAT_LENGTH = 500;
  const MAX_ID_LENGTH = 128;
  const PLAY_STATES = new Set(['playing', 'paused']);
  const PLAYER_ACTIONS = new Set(['play', 'pause', 'seek', 'buffering']);

  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const string = (value, max, allowEmpty = false) =>
    typeof value === 'string'
    && (allowEmpty || Array.from(value).length > 0)
    && Array.from(value).length <= max;
  const timestamp = value => Number.isSafeInteger(value) && value >= 0;
  const position = value => typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= MAX_POSITION;
  const count = value => Number.isInteger(value) && value >= 0 && value <= MAX_PARTICIPANTS;
  const optional = (value, validator) => value === undefined || validator(value);
  const nullable = (value, validator) => value === null || validator(value);
  const payloadObject = message => object(message.payload);

  const invalid = error => ({ valid: false, error });
  const valid = () => ({ valid: true, error: null });
  const onlyKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));

  const validateRoomList = (message) => {
    if (!Array.isArray(message.payload)) return 'payload must be an array';
    for (const room of message.payload) {
      if (!object(room)) return 'room_list entries must be objects';
      if (!onlyKeys(room, ['id', 'name', 'count', 'media_id'])) return 'room_list entry has unknown fields';
      if (!string(room.id, MAX_ID_LENGTH)) return 'room_list entry id is invalid';
      if (!string(room.name, MAX_ROOM_NAME_LENGTH)) return 'room_list entry name is invalid';
      if (!count(room.count)) return 'room_list entry count is invalid';
      if (!optional(room.media_id, value => nullable(value, id => string(id, MAX_ID_LENGTH)))) {
        return 'room_list entry media_id is invalid';
      }
    }
    return null;
  };

  const validateClientHello = (message) => {
    if (!payloadObject(message)) return 'payload must be an object';
    if (!onlyKeys(message.payload, ['client_id'])) return 'client_hello has unknown fields';
    return string(message.payload.client_id, MAX_ID_LENGTH) ? null : 'client_id is invalid';
  };

  const validateAuthSuccess = (message) => {
    if (!payloadObject(message)) return 'payload must be an object';
    if (!onlyKeys(message.payload, ['user_name'])) return 'auth_success has unknown fields';
    return string(message.payload.user_name, MAX_NAME_LENGTH) ? null : 'user_name is invalid';
  };

  const validateRoomState = (message) => {
    if (!payloadObject(message)) return 'payload must be an object';
    const payload = message.payload;
    if (!onlyKeys(payload, ['name', 'host_id', 'participant_count', 'state', 'state_server_ts', 'target_server_ts', 'media_id'])) return 'room_state has unknown fields';
    if (!string(payload.name, MAX_ROOM_NAME_LENGTH)) return 'room name is invalid';
    if (!string(payload.host_id, MAX_ID_LENGTH)) return 'host_id is invalid';
    if (!count(payload.participant_count)) return 'participant_count is invalid';
    if (!object(payload.state)) return 'state must be an object';
    if (!onlyKeys(payload.state, ['position', 'play_state'])) return 'state has unknown fields';
    if (!position(payload.state.position)) return 'state position is invalid';
    if (!PLAY_STATES.has(payload.state.play_state)) return 'state play_state is invalid';
    if (!optional(payload.state_server_ts, timestamp)) return 'state_server_ts is invalid';
    if (!optional(payload.target_server_ts, value => nullable(value, timestamp))) return 'target_server_ts is invalid';
    if (!optional(payload.media_id, value => nullable(value, id => string(id, MAX_ID_LENGTH)))) return 'media_id is invalid';
    return null;
  };

  const validateParticipantCount = (message) => {
    if (!payloadObject(message)) return 'payload must be an object';
    if (!onlyKeys(message.payload, ['participant_count'])) return 'participant update has unknown fields';
    return count(message.payload.participant_count) ? null : 'participant_count is invalid';
  };

  const validateRoomClosed = (message) => {
    if (!payloadObject(message)) return 'payload must be an object';
    if (!onlyKeys(message.payload, ['reason'])) return 'room_closed has unknown fields';
    return string(message.payload.reason, 500) ? null : 'reason is invalid';
  };

  const validatePlayerEvent = (message) => {
    if (!payloadObject(message)) return 'payload must be an object';
    const payload = message.payload;
    if (!onlyKeys(payload, ['action', 'position', 'play_state', 'target_server_ts'])) return 'player_event has unknown fields';
    if (!PLAYER_ACTIONS.has(payload.action)) return 'player action is invalid';
    if (!position(payload.position)) return 'player position is invalid';
    if (!PLAY_STATES.has(payload.play_state)) return 'player play_state is invalid';
    return timestamp(payload.target_server_ts) ? null : 'target_server_ts is invalid';
  };

  const validateStateUpdate = (message) => {
    if (!payloadObject(message)) return 'payload must be an object';
    if (!onlyKeys(message.payload, ['position', 'play_state'])) return 'state_update has unknown fields';
    if (!position(message.payload.position)) return 'state position is invalid';
    return PLAY_STATES.has(message.payload.play_state) ? null : 'state play_state is invalid';
  };

  const validatePong = (message) => {
    if (!payloadObject(message)) return 'payload must be an object';
    if (!onlyKeys(message.payload, ['client_ts'])) return 'pong has unknown fields';
    return timestamp(message.payload.client_ts) ? null : 'client_ts is invalid';
  };

  const validateChat = (message) => {
    if (!payloadObject(message)) return 'payload must be an object';
    if (!onlyKeys(message.payload, ['username', 'text'])) return 'chat_message has unknown fields';
    if (!string(message.payload.username, MAX_NAME_LENGTH)) return 'chat username is invalid';
    return string(message.payload.text, MAX_CHAT_LENGTH) ? null : 'chat text is invalid';
  };

  const validateError = (message) => {
    if (!payloadObject(message)) return 'payload must be an object';
    if (!onlyKeys(message.payload, ['code', 'message'])) return 'error has unknown fields';
    if (!string(message.payload.code, 64)) return 'error code is invalid';
    return string(message.payload.message, 1000) ? null : 'error message is invalid';
  };

  const validators = {
    room_list: validateRoomList,
    client_hello: validateClientHello,
    auth_success: validateAuthSuccess,
    room_state: validateRoomState,
    participants_update: validateParticipantCount,
    client_left: validateParticipantCount,
    room_closed: validateRoomClosed,
    player_event: validatePlayerEvent,
    state_update: validateStateUpdate,
    pong: validatePong,
    chat_message: validateChat,
    error: validateError
  };
  const roomRequired = new Set([
    'room_state',
    'participants_update',
    'client_left',
    'room_closed',
    'player_event',
    'state_update',
    'chat_message'
  ]);
  const envelopeKeys = ['type', 'room', 'client', 'payload', 'ts', 'server_ts'];

  const validateMessage = (message) => {
    if (!object(message)) return invalid('message must be an object');
    if (typeof message.type !== 'string' || !validators[message.type]) return invalid('message type is unknown');
    if (!onlyKeys(message, envelopeKeys)) return invalid('message has unknown fields');
    if (roomRequired.has(message.type) && !string(message.room, MAX_ID_LENGTH)) {
      return invalid('room is required');
    }
    if (!optional(message.room, value => string(value, MAX_ID_LENGTH))) return invalid('room is invalid');
    if (!optional(message.client, value => string(value, MAX_ID_LENGTH))) return invalid('client is invalid');
    if (!timestamp(message.ts)) return invalid('ts is invalid');
    if (!timestamp(message.server_ts)) return invalid('server_ts is invalid');
    if (!Object.prototype.hasOwnProperty.call(message, 'payload')) return invalid('payload is required');
    const error = validators[message.type](message);
    return error ? invalid(error) : valid();
  };

  OWP.wsValidation = {
    validateMessage,
    isKnownType: type => typeof type === 'string' && Object.hasOwn(validators, type)
  };
})();
