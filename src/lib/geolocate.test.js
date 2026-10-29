/**
 * geolocate.test.js — the device-free half of "Use my location".
 *
 *     node --test src/lib/geolocate.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GEO_ERROR, checkFix, geoErrorCode, geoErrorMessage } from './geolocate.js';

describe('geoErrorCode', () => {
  it('passes browser error codes straight through', () => {
    assert.equal(geoErrorCode({ code: 1, message: 'User denied Geolocation' }), GEO_ERROR.PERMISSION_DENIED);
    assert.equal(geoErrorCode({ code: 2 }), GEO_ERROR.POSITION_UNAVAILABLE);
    assert.equal(geoErrorCode({ code: 3 }), GEO_ERROR.TIMEOUT);
  });

  it('reads plugin errors from their message', () => {
    assert.equal(geoErrorCode(new Error('Location permission was denied')), GEO_ERROR.PERMISSION_DENIED);
    assert.equal(geoErrorCode(new Error('Location services are not authorized')), GEO_ERROR.PERMISSION_DENIED);
    assert.equal(geoErrorCode(new Error('Timeout expired')), GEO_ERROR.TIMEOUT);
    assert.equal(geoErrorCode(new Error('Not implemented on web.')), GEO_ERROR.UNSUPPORTED);
  });

  it('treats anything unrecognised as "position unavailable"', () => {
    assert.equal(geoErrorCode(new Error('kCLErrorDomain error 0')), GEO_ERROR.POSITION_UNAVAILABLE);
    assert.equal(geoErrorCode(undefined), GEO_ERROR.POSITION_UNAVAILABLE);
    assert.equal(geoErrorCode(null), GEO_ERROR.POSITION_UNAVAILABLE);
  });
});

describe('geoErrorMessage', () => {
  it('gives a distinct, non-empty sentence for every code', () => {
    const messages = Object.values(GEO_ERROR).map(geoErrorMessage);
    for (const m of messages) assert.ok(typeof m === 'string' && m.length > 20, m);
    assert.equal(new Set(messages).size, messages.length, 'messages must differ');
  });

  it('points the user at their settings when permission is denied', () => {
    assert.match(geoErrorMessage(GEO_ERROR.PERMISSION_DENIED), /settings/);
  });

  it('falls back to "unavailable" for unknown codes', () => {
    assert.equal(geoErrorMessage(42), geoErrorMessage(GEO_ERROR.POSITION_UNAVAILABLE));
  });
});

describe('checkFix', () => {
  it('accepts a position inside Australia', () => {
    assert.deepEqual(
      checkFix({ latitude: -33.8688, longitude: 151.2093, accuracy: 20 }),
      { ok: true, lat: -33.8688, lon: 151.2093 }
    );
  });

  it('accepts Hobart and Darwin, near the frame edges', () => {
    assert.equal(checkFix({ latitude: -42.8821, longitude: 147.3272 }).ok, true);
    assert.equal(checkFix({ latitude: -12.4634, longitude: 130.8456 }).ok, true);
  });

  it('refuses a position outside the map and says where it was', () => {
    const r = checkFix({ latitude: 48.8566, longitude: 2.3522 }); // Paris
    assert.equal(r.ok, false);
    assert.match(r.message, /48\.86, 2\.35/);
    assert.match(r.message, /outside the map/);
  });

  it('refuses unreadable positions', () => {
    for (const bad of [
      null,
      {},
      { latitude: NaN, longitude: 151 },
      { latitude: -33, longitude: Infinity },
      { latitude: -95, longitude: 151 },
      { latitude: -33, longitude: 190 },
    ]) {
      const r = checkFix(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.match(r.message, /unreadable/);
    }
  });
});
