// Test setup: creates the global OWP namespace expected by client modules.
// Modules are IIFEs that attach to window.OpenWatchParty, so we simulate
// the browser environment minimally with globalThis.

globalThis.window = globalThis;
globalThis.window.location = { protocol: 'https:', hostname: 'localhost', hash: '' };
globalThis.document = { querySelector: () => null };
globalThis.setTimeout = setTimeout;
globalThis.clearTimeout = clearTimeout;

// Load state.js first (defines OWP.constants and OWP.state)
require('../state.js');

// Load time.js (defines OWP.utils.nowMs, getServerNow, adjustedPosition)
require('../utils/time.js');

// Load url.js (defines strict session WebSocket URL validation)
require('../utils/url.js');

// Load misc.js (defines OWP.utils.suppress and shouldSend)
require('../utils/misc.js');

module.exports = globalThis.OpenWatchParty;
