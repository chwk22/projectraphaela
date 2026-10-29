/**
 * geolocate.js — pure helpers behind the "Use my location" button.
 *
 * Reading the position itself needs a browser or the Capacitor plugin, so it
 * lives in the component. What is left here is everything that can be tested
 * without a device: turning an error into a code, a code into a sentence, and
 * a raw fix into a pin the map can show.
 *
 * Mirrored in RaphaelaProject.jsx (SECTION 3b); parity.test.js checks the two
 * copies agree.
 */

import { isInFrame } from '../data/australia.js';

/** Error codes. 1 to 3 match the W3C GeolocationPositionError codes. */
export const GEO_ERROR = {
  UNSUPPORTED: 0,
  PERMISSION_DENIED: 1,
  POSITION_UNAVAILABLE: 2,
  TIMEOUT: 3,
};

/**
 * Normalise anything thrown while locating into one of the GEO_ERROR codes.
 *
 * Browsers reject with a numeric `code`. The Capacitor plugin rejects with a
 * plain Error whose message (and sometimes a string `code`) says what failed,
 * so fall back to reading the text.
 */
export function geoErrorCode(err) {
  if (err && (err.code === 1 || err.code === 2 || err.code === 3)) return err.code;
  const text = err ? `${err.code || ''} ${err.message || ''}`.toLowerCase() : '';
  if (/denied|permission|not authori[sz]ed|restricted/.test(text)) return GEO_ERROR.PERMISSION_DENIED;
  if (/time ?out|timed out/.test(text)) return GEO_ERROR.TIMEOUT;
  if (/not (implemented|available|supported)|unsupported|unimplemented/.test(text)) return GEO_ERROR.UNSUPPORTED;
  return GEO_ERROR.POSITION_UNAVAILABLE;
}

/** The sentence shown to the user for each error code. */
export function geoErrorMessage(code) {
  switch (code) {
    case GEO_ERROR.PERMISSION_DENIED:
      return 'Location access is turned off for Moonsun. Allow it in your browser or device settings, then try again.';
    case GEO_ERROR.TIMEOUT:
      return 'Finding your position took too long. Try again, ideally outdoors.';
    case GEO_ERROR.UNSUPPORTED:
      return 'This device or browser cannot share its location. Drop the pin by hand or type a coordinate instead.';
    default:
      return 'Your position could not be found. Check that location services are on, then try again.';
  }
}

/**
 * Turn a raw fix ({ latitude, longitude }) into a pin, or explain why not.
 *
 * Returns { ok: true, lat, lon } or { ok: false, message }. Positions outside
 * the map frame are refused, matching the typed-coordinate form.
 */
export function checkFix(coords) {
  // Number.isFinite rather than Number(): Number(null) is 0, which would turn
  // a missing fix into a pin at 0, 0.
  const lat = coords ? coords.latitude : undefined;
  const lon = coords ? coords.longitude : undefined;
  if (
    !Number.isFinite(lat) || !Number.isFinite(lon) ||
    Math.abs(lat) > 90 || Math.abs(lon) > 180
  ) {
    return { ok: false, message: 'Your device returned an unreadable position. Try again in a moment.' };
  }
  if (!isInFrame(lat, lon)) {
    return {
      ok: false,
      message: `You appear to be at ${lat.toFixed(2)}, ${lon.toFixed(2)}, outside the map of Australia, so the pin has not moved.`,
    };
  }
  return { ok: true, lat, lon };
}
