(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const utils = OWP.utils = OWP.utils || {};

  const defaultPort = (protocol) => protocol === 'https:' || protocol === 'wss:' ? '443' : '80';

  const normalizeSessionServerUrl = (value, pageLocation = window.location) => {
    if (value === undefined || value === null || value === '') {
      return { valid: true, url: '', thirdParty: false };
    }
    if (typeof value !== 'string') {
      return { valid: false, error: 'Session server URL must be a string' };
    }

    const candidate = value.trim();
    if (!candidate) return { valid: true, url: '', thirdParty: false };

    let url;
    try {
      url = new URL(candidate);
    } catch (err) {
      return { valid: false, error: 'Session server URL must be an absolute ws:// or wss:// URL with a host' };
    }
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname) {
      return { valid: false, error: 'Session server URL must be an absolute ws:// or wss:// URL with a host' };
    }
    if (url.username || url.password) {
      return { valid: false, error: 'Session server URL must not contain credentials' };
    }
    if (candidate.includes('?') || candidate.includes('#')) {
      return { valid: false, error: 'Session server URL must not contain a query string or fragment' };
    }
    if (pageLocation?.protocol === 'https:' && url.protocol === 'ws:') {
      return { valid: false, error: 'An HTTPS page requires a secure wss:// session server URL' };
    }

    const pageHost = String(pageLocation?.hostname || '').toLowerCase();
    const pagePort = String(pageLocation?.port || defaultPort(pageLocation?.protocol));
    const targetPort = url.port || defaultPort(url.protocol);
    return {
      valid: true,
      url: url.href,
      thirdParty: url.hostname.toLowerCase() !== pageHost || targetPort !== pagePort
    };
  };

  Object.assign(utils, { normalizeSessionServerUrl });
})();
