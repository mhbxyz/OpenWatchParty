const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');
const { FakeDocument } = require('./fake-dom');
const OWP = require('./setup');

const { t, locale, catalogs } = OWP.i18n;
const placeholders = value => [...String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]).sort();

describe('localization catalogs', () => {
  beforeEach(() => {
    globalThis.document = { documentElement: { lang: 'en' }, querySelector: () => null };
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });
  });

  it('keeps every shipped locale complete with matching placeholders', () => {
    const englishKeys = Object.keys(catalogs.en).sort();
    for (const language of ['es', 'fr', 'de']) {
      assert.deepEqual(Object.keys(catalogs[language]).sort(), englishKeys);
      for (const key of englishKeys) {
        assert.deepEqual(placeholders(catalogs[language][key]), placeholders(catalogs.en[key]), `${language}.${key}`);
      }
    }
  });

  it('resolves exact tags, base languages and unsupported locales', () => {
    document.documentElement.lang = 'es-AR';
    assert.equal(locale(), 'es');
    document.documentElement.lang = 'de-DE';
    assert.equal(locale(), 'de');
    document.documentElement.lang = 'pt-BR';
    assert.equal(locale(), 'en');
  });

  it('uses navigator.language when the document language is empty, then English', () => {
    document.documentElement.lang = '';
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'fr-CA' }, configurable: true });
    assert.equal(locale(), 'fr');
    Object.defineProperty(globalThis, 'navigator', { value: { language: '' }, configurable: true });
    assert.equal(locale(), 'en');
  });

  it('falls back per key and formats plurals and placeholders', () => {
    document.documentElement.lang = 'es';
    const saved = catalogs.es.invite;
    delete catalogs.es.invite;
    assert.equal(t('invite'), 'Invite');
    catalogs.es.invite = saved;
    assert.equal(t('user', { count: 1 }), '1 usuario');
    assert.equal(t('user', { count: 3 }), '3 usuarios');
    assert.equal(t('latency', { client: 'abc' }), 'Latencia al servidor de la sala (cliente abc)');
    assert.equal(t('missing.key'), 'missing.key');
  });

  it('shows known server errors and room-closed reasons in the viewer language', () => {
    const { localizeServerError, localizeRoomClosedReason } = OWP.i18n;
    document.documentElement.lang = 'es';
    assert.equal(localizeServerError('ROOM_FULL', 'Room is full'), 'La sala está llena');
    assert.equal(localizeServerError('AUTHENTICATION_EXPIRED', 'Invite ticket has expired'), 'El enlace de invitación expiró');
    assert.equal(localizeServerError('HOST_PERMISSION_REQUIRED', 'Only the room host can control playback'), 'Solo el anfitrión controla la reproducción');
    assert.equal(localizeServerError('INVALID_JSON', 'Invalid JSON'), 'Invalid JSON');
    assert.equal(localizeServerError('constructor', ''), 'Error desconocido');
    assert.equal(localizeRoomClosedReason('Host left the room'), 'El anfitrión salió de la sala');
    assert.equal(localizeRoomClosedReason('Host left'), 'Host left');
    assert.equal(localizeRoomClosedReason(undefined), 'La sala se cerró');
    document.documentElement.lang = 'en';
    assert.equal(localizeServerError('ROOM_NOT_FOUND', 'Room not found'), 'Room not found');
    assert.equal(localizeRoomClosedReason('Host started a new room'), 'Host started a new room');
  });

  it('shows the server default room name in the viewer language, and other names as they are', () => {
    const { localizeRoomName } = OWP.i18n;
    document.documentElement.lang = 'es';
    assert.equal(localizeRoomName("Ana's room"), 'Sala de Ana');
    assert.equal(localizeRoomName("Jo's room's room"), "Sala de Jo's room");
    assert.equal(localizeRoomName('Movie night'), 'Movie night');
    assert.equal(localizeRoomName(undefined), '');
    document.documentElement.lang = 'de';
    assert.equal(localizeRoomName("Ana's room"), 'Raum von Ana');
    document.documentElement.lang = 'en';
    assert.equal(localizeRoomName("Ana's room"), "Ana's room");
  });
});

describe('localized rendering', () => {
  it('renders the lobby and room bar in Spanish', () => {
    const fakeDocument = new FakeDocument();
    fakeDocument.documentElement = { lang: 'es' };
    globalThis.document = fakeDocument;
    OWP.utils.getPlayingItemId = () => '';
    require('../ui/indicators.js');
    require('../ui/cards.js');
    require('../ui/render.js');
    OWP.ui.renderHomeWatchParties = () => {};
    OWP.actions = OWP.actions || {};

    const panel = document.createElement('div');
    panel.id = OWP.constants.PANEL_ID;
    document.body.appendChild(panel);
    Object.assign(OWP.state, { inRoom: false, rooms: [], ws: { readyState: 1 } });
    OWP.ui.render(true);
    assert.equal(panel.querySelector('.owp-label').textContent, 'Salas disponibles');
    assert.equal(document.getElementById('owp-btn-create').textContent, 'Crear sala');
    assert.equal(document.getElementById('owp-room-list').textContent, 'No hay salas activas.');

    OWP.state.rooms = [{ id: 'room-a', name: "Ana's room", count: 2, media_id: 'a'.repeat(32) }];
    OWP.ui.render(true);
    assert.equal(panel.querySelector('.owp-room-title').textContent, 'Sala de Ana');

    Object.assign(OWP.state, {
      inRoom: true, isHost: false, roomName: "Ana's room", clientId: 'client-abc',
      participants: [], participantCount: 2, lastRttMs: null, roomBarSection: ''
    });
    OWP.ui.render(true);
    assert.equal(document.getElementById('owp-btn-people').getAttribute('aria-label'), 'Participantes: 2');
    assert.equal(document.getElementById('owp-btn-leave').getAttribute('aria-label'), 'Salir de la sala');
    assert.equal(document.getElementById('owp-chat-input').placeholder, 'Escribir un mensaje...');
    const barName = panel.querySelector('.owp-room-name');
    assert.equal(barName.textContent, 'Sala de Ana');
    assert.equal(barName.title, 'Sala de Ana');
  });
});
