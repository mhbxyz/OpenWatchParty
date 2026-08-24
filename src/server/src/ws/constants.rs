// Channel buffer size for client message queues (prevents OOM from slow clients)
pub(super) const CLIENT_CHANNEL_BUFFER: usize = 100;
pub(super) const CLOSE_ENQUEUE_TIMEOUT_MS: u64 = 250;
pub(super) const WRITER_SHUTDOWN_TIMEOUT_MS: u64 = 1000;

pub(super) const PLAY_SCHEDULE_MS: u64 = 1000; // Reduced from 1500ms for better UX (UX-P1)
pub(super) const CONTROL_SCHEDULE_MS: u64 = 300;
pub(super) const MAX_READY_WAIT_MS: u64 = 2000;
pub(super) const MIN_STATE_UPDATE_INTERVAL_MS: u64 = 500;
pub(super) const POSITION_JITTER_THRESHOLD: f64 = 0.5;
pub(super) const COMMAND_COOLDOWN_MS: u64 = 2000;

// Rate limiting constants
pub(super) const RATE_LIMIT_MESSAGES: u32 = 30; // Max messages per window
pub(super) const RATE_LIMIT_WINDOW_MS: u64 = 1000; // Window size in ms
pub(super) const POLICY_VIOLATION_CLOSE_CODE: u16 = 1008;

// Resource limits
pub(super) const MAX_CLIENTS_PER_ROOM: usize = 20; // Max clients in a room

// Payload validation
pub(super) const MAX_POSITION_SECONDS: f64 = 86400.0; // 24 hours max
pub(crate) const MAX_MESSAGE_SIZE: usize = 64 * 1024; // 64 KiB max assembled message size
pub(crate) const MAX_FRAME_SIZE: usize = 64 * 1024; // 64 KiB max frame size before assembly
pub(super) const MAX_NAME_LENGTH: usize = 100; // Max length for user/room names
pub(super) const MAX_CHAT_MESSAGE_LENGTH: usize = 500; // Max chat message length
