/**
 * FirstAndLastLight.jsx
 * ============================================================================
 * Offline sunrise and sunset planning for Australia.
 *
 * WHAT IT DOES
 *   1. Tracks where the good light is: ranks 29 curated sites for a chosen
 *      date, scoring horizon alignment, twilight duration, air clarity and
 *      vantage height.
 *   2. Reports peak-colour time: the sky usually peaks a fixed interval either
 *      side of the official event (20 minutes before sunrise, and by symmetry
 *      20 minutes after sunset). The interval is adjustable.
 *   3. Shows the sun moving: a hand-computed terminator is painted over a map
 *      of Australia and can be scrubbed or animated through the day.
 *   4. Copies a plan to the clipboard: place, coordinates, and every relevant
 *      time, as plain text.
 *
 * SINGLE-FILE BUILD
 *   This file is self-contained on purpose so it can be dropped into any React
 *   app or preview sandbox without a bundler config. In the repository the
 *   pure logic also lives in `src/lib/solar.js` and `src/data/australia.js`,
 *   which is what the unit tests import. If you edit the maths, edit it there
 *   and copy it down — or delete the inlined sections below and import
 *   instead. See README.md.
 *
 * BROWSER SUPPORT
 *   Safari 14+, Chrome 90+, Firefox 90+, and the mobile equivalents.
 *   - No optional chaining assignment, no top-level await, no `structuredClone`.
 *   - `aspect-ratio` is avoided in favour of the padding-top ratio technique.
 *   - Clipboard writes fall back to a hidden textarea for older Safari.
 *   - localStorage access is probed inside a try/catch because Safari private
 *     browsing and sandboxed iframes throw on access rather than returning null.
 *
 * ACCESSIBILITY
 *   The map is operable from the keyboard (arrow keys nudge the pin, Enter
 *   drops it), every control has a label, focus is always visible, and
 *   `prefers-reduced-motion` suppresses the animation loop.
 */

import React, {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Crosshair,
  Info,
  MapPin,
  Pause,
  Play,
  Star,
  Sunrise,
  Sunset,
  Trash2,
  X,
} from 'lucide-react';

/* ==========================================================================
 * SECTION 1 — Solar engine (mirror of src/lib/solar.js)
 * ========================================================================== */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const MS_PER_DAY = 86400000;
const UNIX_EPOCH_JD = 2440587.5;

/** Zenith angles that define each solar event, in degrees from straight up. */
const ZENITH = {
  SUNRISE_SUNSET: 90.833, // includes refraction and the sun's semi-diameter
  CIVIL: 96,
  NAUTICAL: 102,
  ASTRONOMICAL: 108,
  GOLDEN_UPPER: 84, // sun 6 degrees up: the top of the golden window
};

const DEFAULT_PEAK_OFFSET_MIN = 20;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const norm360 = (deg) => ((deg % 360) + 360) % 360;
const lerp = (a, b, t) => a + (b - a) * t;

/** Throw early and loudly rather than propagating NaN through the whole UI. */
function assertCoords(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) {
    throw new TypeError('Coordinates must be finite numbers');
  }
  if (la < -90 || la > 90) throw new RangeError(`Latitude ${la} is outside -90..90`);
  if (lo < -180 || lo > 180) throw new RangeError(`Longitude ${lo} is outside -180..180`);
  return { lat: la, lon: lo };
}

const toJulianDay = (date) => date.getTime() / MS_PER_DAY + UNIX_EPOCH_JD;
const fromJulianDay = (jd) => new Date((jd - UNIX_EPOCH_JD) * MS_PER_DAY);
const julianDayForUTCDate = (y, m, d) => toJulianDay(new Date(Date.UTC(y, m - 1, d)));
const julianCentury = (jd) => (jd - 2451545) / 36525;

const geomMeanLongSun = (t) => norm360(280.46646 + t * (36000.76983 + t * 0.0003032));
const geomMeanAnomalySun = (t) => 357.52911 + t * (35999.05029 - 0.0001537 * t);
const earthOrbitEccentricity = (t) => 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

function sunEqOfCentre(t) {
  const m = geomMeanAnomalySun(t) * RAD;
  return (
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289
  );
}

function sunApparentLong(t) {
  const trueLong = geomMeanLongSun(t) + sunEqOfCentre(t);
  return trueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * RAD);
}

function obliquityCorrection(t) {
  const seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
  const mean = 23 + (26 + seconds / 60) / 60;
  return mean + 0.00256 * Math.cos((125.04 - 1934.136 * t) * RAD);
}

function sunDeclination(t) {
  return (
    Math.asin(
      Math.sin(obliquityCorrection(t) * RAD) * Math.sin(sunApparentLong(t) * RAD)
    ) * DEG
  );
}

/** Difference between apparent and mean solar time, in minutes. */
function equationOfTime(t) {
  const epsilon = obliquityCorrection(t) * RAD;
  const l0 = geomMeanLongSun(t) * RAD;
  const e = earthOrbitEccentricity(t);
  const m = geomMeanAnomalySun(t) * RAD;
  let y = Math.tan(epsilon / 2);
  y *= y;
  const eTime =
    y * Math.sin(2 * l0) -
    2 * e * Math.sin(m) +
    4 * e * y * Math.sin(m) * Math.cos(2 * l0) -
    0.5 * y * y * Math.sin(4 * l0) -
    1.25 * e * e * Math.sin(2 * m);
  return eTime * DEG * 4;
}

/** Returns null during polar day or polar night, which callers must handle. */
function hourAngle(latDeg, declDeg, zenithDeg) {
  const lat = latDeg * RAD;
  const decl = declDeg * RAD;
  const cosH =
    (Math.cos(zenithDeg * RAD) - Math.sin(lat) * Math.sin(decl)) /
    (Math.cos(lat) * Math.cos(decl));
  if (cosH > 1 || cosH < -1 || !Number.isFinite(cosH)) return null;
  return Math.acos(cosH) * DEG;
}

function refractionCorrection(elev) {
  if (elev > 85) return 0;
  const te = Math.tan(elev * RAD);
  let arcsec;
  if (elev > 5) arcsec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elev > -0.575)
    arcsec = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)));
  else arcsec = -20.772 / te;
  return arcsec / 3600;
}

/** Sun elevation and compass azimuth as seen from (lat, lon) at an instant. */
function solarPosition(date, lat, lon) {
  assertCoords(lat, lon);
  const jd = toJulianDay(date);
  const t = julianCentury(jd);
  const decl = sunDeclination(t);
  const eqTime = equationOfTime(t);

  const utcMinutes = ((((jd + 0.5) % 1) + 1) % 1) * 1440;
  const trueSolarTime = (((utcMinutes + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  let ha = trueSolarTime / 4 - 180;
  if (ha < -180) ha += 360;

  const latR = lat * RAD;
  const declR = decl * RAD;
  const cosZ = clamp(
    Math.sin(latR) * Math.sin(declR) + Math.cos(latR) * Math.cos(declR) * Math.cos(ha * RAD),
    -1, 1
  );
  const zenith = Math.acos(cosZ) * DEG;
  const geometricElevation = 90 - zenith;

  let azimuth;
  const azDenom = Math.cos(latR) * Math.sin(zenith * RAD);
  if (Math.abs(azDenom) > 0.001) {
    const azRad = clamp((Math.sin(latR) * cosZ - Math.sin(declR)) / azDenom, -1, 1);
    azimuth = 180 - Math.acos(azRad) * DEG;
    if (ha > 0) azimuth = -azimuth;
  } else {
    azimuth = lat > 0 ? 180 : 0;
  }

  return {
    elevation: geometricElevation + refractionCorrection(geometricElevation),
    geometricElevation,
    azimuth: norm360(azimuth),
    declination: decl,
    hourAngle: ha,
  };
}

/**
 * Minutes after 00:00 UTC at which the sun crosses `zenith`. Two passes: the
 * second re-evaluates declination at the first estimate. NOAA's reference code
 * uses positive-west longitude; we store positive-east, hence the subtraction.
 */
function eventMinutesUTC(jd, lat, lon, zenith, isRise) {
  let minutes = null;
  for (let pass = 0; pass < 2; pass++) {
    const t = julianCentury(pass === 0 ? jd : jd + minutes / 1440);
    const ha = hourAngle(lat, sunDeclination(t), zenith);
    if (ha === null) return null;
    minutes = 720 - 4 * (lon + (isRise ? ha : -ha)) - equationOfTime(t);
  }
  return minutes;
}

function solveEvent(civilDate, lat, lon, zenith, isRise) {
  assertCoords(lat, lon);
  const jd = julianDayForUTCDate(civilDate.year, civilDate.month, civilDate.day);
  const minutes = eventMinutesUTC(jd, lat, lon, zenith, isRise);
  return minutes === null ? null : fromJulianDay(jd + minutes / 1440);
}

/** Every solar time the interface needs for one day at one place. */
function dayTimes(civilDate, lat, lon, options) {
  assertCoords(lat, lon);
  const opts = options || {};
  const peakOffset = Number.isFinite(opts.peakOffsetMinutes)
    ? opts.peakOffsetMinutes
    : DEFAULT_PEAK_OFFSET_MIN;

  const jd = julianDayForUTCDate(civilDate.year, civilDate.month, civilDate.day);
  const at = (z, rise) => solveEvent(civilDate, lat, lon, z, rise);

  const sunrise = at(ZENITH.SUNRISE_SUNSET, true);
  const sunset = at(ZENITH.SUNRISE_SUNSET, false);
  const solarNoon = fromJulianDay(
    jd + (720 - 4 * lon - equationOfTime(julianCentury(jd + 0.5))) / 1440
  );
  const civilDawn = at(ZENITH.CIVIL, true);
  const civilDusk = at(ZENITH.CIVIL, false);

  const between = (a, b) => (a && b ? Math.round((b.getTime() - a.getTime()) / 60000) : null);

  let regime = 'normal';
  if (!sunrise || !sunset) {
    regime = solarPosition(solarNoon, lat, lon).elevation > 0 ? 'polar-day' : 'polar-night';
  }

  const offsetMs = peakOffset * 60000;
  return {
    sunrise,
    sunset,
    solarNoon,
    civilDawn,
    civilDusk,
    nauticalDawn: at(ZENITH.NAUTICAL, true),
    nauticalDusk: at(ZENITH.NAUTICAL, false),
    astronomicalDawn: at(ZENITH.ASTRONOMICAL, true),
    astronomicalDusk: at(ZENITH.ASTRONOMICAL, false),
    goldenMorningEnd: at(ZENITH.GOLDEN_UPPER, true),
    goldenEveningStart: at(ZENITH.GOLDEN_UPPER, false),
    // The brief's rule: colour peaks a fixed interval before sunrise, and the
    // same interval after sunset.
    peakColourSunrise: sunrise ? new Date(sunrise.getTime() - offsetMs) : null,
    peakColourSunset: sunset ? new Date(sunset.getTime() + offsetMs) : null,
    dayLengthMinutes: between(sunrise, sunset),
    civilTwilightMorningMinutes: between(civilDawn, sunrise),
    civilTwilightEveningMinutes: between(sunset, civilDusk),
    regime,
  };
}

/* -------------------------------------------------------------------------
 * Timezones
 * ---------------------------------------------------------------------- */

/**
 * Australian zone lookup by rectangle. A deliberate simplification: a real
 * shapefile is tens of thousands of vertices and this app ships no data files.
 * Known misses are documented in the README (Broken Hill, Eucla).
 */
function timezoneForPoint(lat, lon) {
  assertCoords(lat, lon);
  if (lat < -39.2 && lon > 143.5 && lon < 149.5) return 'Australia/Hobart';
  if (lon < 129) return 'Australia/Perth';
  if (lon < 141) return lat > -26 ? 'Australia/Darwin' : 'Australia/Adelaide';
  if (lat > -29) return 'Australia/Brisbane';
  return 'Australia/Sydney';
}

function formatInZone(date, timeZone, opts) {
  if (!date) return '--:--';
  const base = { hour: '2-digit', minute: '2-digit', hour12: false };
  try {
    return new Intl.DateTimeFormat('en-AU', { ...base, ...opts, timeZone }).format(date);
  } catch {
    // Unknown zone, or a very old runtime without full ICU data.
    try {
      return (
        new Intl.DateTimeFormat('en-AU', { ...base, ...opts, timeZone: 'UTC' }).format(date) +
        ' UTC'
      );
    } catch {
      return date.toISOString().slice(11, 16) + ' UTC';
    }
  }
}

function zoneAbbreviation(date, timeZone) {
  if (!date) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-AU', {
      timeZone,
      timeZoneName: 'short',
    }).formatToParts(date);
    const found = parts.find((p) => p.type === 'timeZoneName');
    if (found && found.value) return found.value;
  } catch {
    /* fall through */
  }
  return 'UTC';
}

function civilDateInZone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    return { year: get('year'), month: get('month'), day: get('day') };
  } catch {
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }
}

function zoneOffsetMinutes(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date);
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const asIfUTC = Date.UTC(
      get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')
    );
    return Math.round((asIfUTC - date.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/** The instant of 00:00 local time, used as the origin for the day ribbon. */
function localMidnight(civilDate, timeZone) {
  const naive = Date.UTC(civilDate.year, civilDate.month - 1, civilDate.day, 0, 0, 0);
  const guess = zoneOffsetMinutes(new Date(naive), timeZone);
  let ms = naive - guess * 60000;
  const refined = zoneOffsetMinutes(new Date(ms), timeZone);
  if (refined !== guess) ms = naive - refined * 60000;
  return new Date(ms);
}

/* -------------------------------------------------------------------------
 * Horizon geometry and scoring
 * ---------------------------------------------------------------------- */

/** Degrees from a bearing to the nearest edge of a clockwise arc; 0 if inside. */
function bearingDistanceToArc(bearing, arc) {
  const start = norm360(arc[0]);
  const span = norm360(arc[1] - arc[0]);
  const rel = norm360(bearing - start);
  if (rel <= span) return 0;
  return Math.min(rel - span, 360 - rel);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Rate an event on geometry alone. Weighting: alignment 40, twilight duration
 * 25, clarity 20, vantage 15.
 *
 * DELIBERATE LIMITATION: cloud is the biggest real-world factor and this app
 * has no network by design, so it is not modelled. Read the score as "how good
 * is this place for this event on this date", not as a forecast.
 */
function scoreEvent(input) {
  const {
    azimuth,
    openArcs = [],
    twilightMinutes,
    elevationM = 0,
    clarity = 0.6,
    waterHorizon = false,
  } = input;

  // 1. Does the sun land in the part of the sky you can actually see?
  let miss = 45;
  for (const arc of openArcs) miss = Math.min(miss, bearingDistanceToArc(azimuth, arc));
  const alignment = 40 * (1 - clamp(miss, 0, 45) / 45);

  // 2. Longer civil twilight means the colour holds longer.
  const dur = Number.isFinite(twilightMinutes) ? twilightMinutes : 25;
  const twilight = 25 * clamp((dur - 20) / 25, 0, 1);

  // 3. Height lowers your horizon; water gives an unbroken line and reflections.
  const vantage = 10 * clamp(elevationM / 800, 0, 1) + (waterHorizon ? 5 : 0);

  // 4. Static proxy for haze, dust and light pollution.
  const clarityScore = 20 * clamp(clarity, 0, 1);

  const total = Math.round(alignment + twilight + vantage + clarityScore);
  const grade =
    total >= 85 ? 'exceptional' :
    total >= 70 ? 'strong' :
    total >= 55 ? 'good' :
    total >= 40 ? 'fair' : 'poor';

  let headline;
  if (alignment < 20) headline = 'The sun is well off the open part of the horizon here.';
  else if (clarityScore < 10) headline = 'Good geometry, but hazier air than the inland sites.';
  else if (twilight > 18 && alignment > 32) headline = 'Sun lands in the open, and the colour holds for a long window.';
  else if (waterHorizon && alignment > 30) headline = 'Clean water horizon with the sun in the right place.';
  else if (vantage >= 10) headline = 'Height gives you a low horizon and a longer event.';
  else headline = 'Workable geometry without anything outstanding.';

  return {
    total,
    grade,
    parts: {
      alignment: Math.round(alignment),
      twilight: Math.round(twilight),
      vantage: Math.round(vantage),
      clarity: Math.round(clarityScore),
    },
    headline,
  };
}

/** Distance to the nearest city as a crude haze and light-pollution proxy. */
function estimateClarity(lat, lon, cities) {
  if (!cities || cities.length === 0) return 0.7;
  let nearest = Infinity;
  for (const c of cities) nearest = Math.min(nearest, haversineKm(lat, lon, c.lat, c.lon));
  return clamp(0.45 + (nearest / 600) * 0.5, 0.45, 0.95);
}

/* -------------------------------------------------------------------------
 * Twilight colour ramp
 * ---------------------------------------------------------------------- */

/** [elevationDegrees, r, g, b, alpha], ordered from high sun to deep night. */
const TWILIGHT_STOPS = [
  [10, 255, 255, 255, 0.0],
  [6, 255, 214, 140, 0.2],
  [2, 255, 168, 86, 0.38],
  [-0.833, 244, 118, 76, 0.5],
  [-4, 186, 86, 122, 0.58],
  [-6, 118, 78, 152, 0.64],
  [-12, 38, 46, 112, 0.76],
  [-18, 12, 16, 48, 0.86],
  [-90, 5, 7, 22, 0.9],
];

function twilightColour(elevation) {
  const s = TWILIGHT_STOPS;
  if (elevation >= s[0][0]) return { r: s[0][1], g: s[0][2], b: s[0][3], a: s[0][4] };
  for (let i = 0; i < s.length - 1; i++) {
    const hi = s[i];
    const lo = s[i + 1];
    if (elevation <= hi[0] && elevation >= lo[0]) {
      const t = (hi[0] - elevation) / (hi[0] - lo[0]);
      return {
        r: Math.round(lerp(hi[1], lo[1], t)),
        g: Math.round(lerp(hi[2], lo[2], t)),
        b: Math.round(lerp(hi[3], lo[3], t)),
        a: lerp(hi[4], lo[4], t),
      };
    }
  }
  const last = s[s.length - 1];
  return { r: last[1], g: last[2], b: last[3], a: last[4] };
}

/**
 * Pre-baked lookup table so the map raster does not call twilightColour once
 * per pixel per frame. 512 steps across -40..+14 degrees is far finer than the
 * eye can resolve in a gradient.
 */
const LUT_SIZE = 512;
const LUT_MIN = -40;
const LUT_MAX = 14;
const TWILIGHT_LUT = (() => {
  const table = new Uint8ClampedArray(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const elev = LUT_MIN + (i / (LUT_SIZE - 1)) * (LUT_MAX - LUT_MIN);
    const c = twilightColour(elev);
    table[i * 4] = c.r;
    table[i * 4 + 1] = c.g;
    table[i * 4 + 2] = c.b;
    table[i * 4 + 3] = Math.round(c.a * 255);
  }
  return table;
})();

function lutIndex(elev) {
  const t = (elev - LUT_MIN) / (LUT_MAX - LUT_MIN);
  return clamp(Math.round(t * (LUT_SIZE - 1)), 0, LUT_SIZE - 1);
}

/* -------------------------------------------------------------------------
 * Clipboard payload
 * ---------------------------------------------------------------------- */

function buildClipboardText({
  name, lat, lon, event, times, timeZone, score, peakOffsetMinutes,
}) {
  const isRise = event === 'sunrise';
  const main = isRise ? times.sunrise : times.sunset;
  const peak = isRise ? times.peakColourSunrise : times.peakColourSunset;
  const goldenA = isRise ? times.sunrise : times.goldenEveningStart;
  const goldenB = isRise ? times.goldenMorningEnd : times.sunset;
  const blueA = isRise ? times.civilDawn : times.sunset;
  const blueB = isRise ? times.sunrise : times.civilDusk;

  const zone = zoneAbbreviation(main || new Date(), timeZone);
  const t = (d) => formatInZone(d, timeZone);
  const dateLine = main
    ? formatInZone(main, timeZone, {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
        hour: undefined, minute: undefined, hour12: undefined,
      })
    : '';

  const lines = [
    `${name} — ${event} plan`,
    dateLine,
    `Coordinates: ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    '',
    `${isRise ? 'Sunrise' : 'Sunset'}: ${t(main)} ${zone}`,
    `Peak colour: ${t(peak)} ${zone}  (${peakOffsetMinutes} min ${isRise ? 'before sunrise' : 'after sunset'})`,
    `Golden hour: ${t(goldenA)} – ${t(goldenB)}`,
    `Blue hour: ${t(blueA)} – ${t(blueB)}`,
  ];
  if (score) lines.push(`Light score: ${score.total}/100 (${score.grade})`);
  lines.push('', `Map: https://www.google.com/maps?q=${lat.toFixed(5)},${lon.toFixed(5)}`);
  lines.push('Times are astronomical only — check cloud cover before you commit.');
  return lines.join('\n');
}

/* ==========================================================================
 * SECTION 2 — Geography (mirror of src/data/australia.js)
 * ========================================================================== */

const BOUNDS = { lonMin: 111, lonMax: 155.5, latMin: -44.5, latMax: -9.5 };

const MAINLAND = [
  [142.5, -10.7], [141.9, -12.0], [141.6, -13.2], [141.6, -15.0], [140.8, -17.0],
  [139.9, -17.6], [138.6, -16.8], [137.5, -16.4], [136.4, -15.6], [135.4, -14.9],
  [136.8, -12.2], [135.9, -12.1], [135.0, -12.4], [133.5, -11.8], [132.6, -12.1],
  [131.8, -11.4], [130.8, -12.4], [130.0, -13.2], [129.6, -14.8],
  [128.6, -15.2], [128.0, -15.4], [127.4, -13.9], [126.2, -14.0], [125.0, -14.6],
  [124.1, -15.5], [123.6, -16.4], [122.2, -18.0], [121.6, -19.0], [120.7, -19.6],
  [119.6, -20.0], [118.6, -20.4], [117.2, -20.8], [115.9, -21.1], [114.9, -21.5],
  [114.1, -21.8], [113.7, -22.6], [114.4, -23.2], [113.8, -24.5],
  [113.4, -25.5], [114.1, -26.3], [113.7, -27.7], [114.6, -28.8], [114.9, -30.0],
  [115.2, -31.2], [115.7, -32.1], [115.6, -33.3],
  [115.1, -34.4], [116.6, -35.1], [117.9, -35.1], [119.4, -34.5], [120.6, -33.9],
  [121.9, -33.9], [123.6, -33.9], [125.5, -32.6], [127.3, -32.1], [128.9, -31.7],
  [131.2, -31.5], [132.6, -31.9], [133.7, -32.1], [134.3, -32.9], [135.2, -34.2],
  [135.9, -34.7], [136.9, -35.2], [137.0, -33.5], [137.8, -32.6], [137.9, -34.0],
  [137.6, -35.3], [138.2, -34.1], [138.5, -34.9], [138.1, -35.6],
  [139.3, -35.7], [139.8, -37.2], [140.9, -38.1], [141.6, -38.4], [142.9, -38.6],
  [143.5, -38.9], [144.5, -38.4], [144.9, -38.1], [145.1, -38.5],
  [146.4, -39.1], [147.0, -38.4], [147.9, -37.9], [149.2, -37.6], [149.9, -37.5],
  [150.2, -36.4], [150.9, -35.1], [151.3, -33.9], [152.5, -32.7], [153.1, -30.5],
  [153.6, -28.6], [153.5, -27.5], [153.2, -26.3], [152.5, -24.9], [151.6, -24.1],
  [150.8, -23.4], [149.5, -22.4], [148.5, -20.8], [147.4, -19.6], [146.4, -19.0],
  [145.8, -16.9], [145.3, -15.0], [144.3, -14.5], [143.6, -14.4], [143.5, -12.8],
  [142.8, -11.5], [142.5, -10.7],
];

const TASMANIA = [
  [144.7, -40.7], [145.3, -40.8], [146.4, -41.1], [147.4, -40.8], [148.3, -40.9],
  [148.3, -42.1], [147.9, -43.0], [147.5, -42.9], [146.9, -43.6], [146.0, -43.5],
  [145.5, -42.5], [145.2, -41.5], [144.7, -40.7],
];

const KANGAROO_ISLAND = [
  [136.5, -35.75], [137.4, -35.6], [138.1, -35.6], [137.9, -36.0], [136.6, -36.05],
  [136.5, -35.75],
];

const TIWI_ISLANDS = [
  [130.4, -11.2], [131.5, -11.2], [131.5, -11.8], [130.4, -11.7], [130.4, -11.2],
];

const LANDMASSES = [MAINLAND, TASMANIA, KANGAROO_ISLAND, TIWI_ISLANDS];

function pointInPolygon(lon, lat, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Coarse land test. Used only to warn, never to block — beaches sit on the line. */
const isOnLand = (lat, lon) => LANDMASSES.some((p) => pointInPolygon(lon, lat, p));

const isInFrame = (lat, lon) =>
  lon >= BOUNDS.lonMin && lon <= BOUNDS.lonMax &&
  lat >= BOUNDS.latMin && lat <= BOUNDS.latMax;

const CITIES = [
  { name: 'Sydney', lat: -33.8688, lon: 151.2093 },
  { name: 'Melbourne', lat: -37.8136, lon: 144.9631 },
  { name: 'Brisbane', lat: -27.4698, lon: 153.0251 },
  { name: 'Perth', lat: -31.9523, lon: 115.8613 },
  { name: 'Adelaide', lat: -34.9285, lon: 138.6007 },
  { name: 'Hobart', lat: -42.8821, lon: 147.3272 },
  { name: 'Darwin', lat: -12.4634, lon: 130.8456 },
  { name: 'Canberra', lat: -35.2809, lon: 149.13 },
  { name: 'Gold Coast', lat: -28.0167, lon: 153.4 },
  { name: 'Newcastle', lat: -32.9283, lon: 151.7817 },
  { name: 'Cairns', lat: -16.9186, lon: 145.7781 },
  { name: 'Alice Springs', lat: -23.698, lon: 133.8807 },
];

/**
 * Curated sites. `openArcs` are hand-estimated compass bearings over which the
 * horizon is open from the usual vantage point, written clockwise and allowed
 * to wrap through north. `clarity` is a subjective 0-1 index for haze, dust
 * and light pollution: desert sites near 0.95, city beaches near 0.5.
 */
const SPOTS = [
  { id: 'cape-byron', name: 'Cape Byron', region: 'NSW', lat: -28.644, lon: 153.638, elevationM: 100, openArcs: [[335, 200]], waterHorizon: true, clarity: 0.78, note: 'The mainland’s easternmost point. First light in the country, with ocean on three sides.' },
  { id: 'bondi', name: 'Bondi Beach', region: 'NSW', lat: -33.8908, lon: 151.2743, elevationM: 8, openArcs: [[20, 190]], waterHorizon: true, clarity: 0.5, note: 'Easy access and a clean eastern horizon, at the cost of city haze.' },
  { id: 'echo-point', name: 'Echo Point, Blue Mountains', region: 'NSW', lat: -33.732, lon: 150.312, elevationM: 900, openArcs: [[130, 260]], waterHorizon: false, clarity: 0.7, note: 'Sandstone escarpment over the Jamison Valley. Valley fog is common at dawn.' },
  { id: 'kosciuszko', name: 'Mount Kosciuszko', region: 'NSW', lat: -36.456, lon: 148.263, elevationM: 2228, openArcs: [[0, 359]], waterHorizon: false, clarity: 0.92, note: 'The highest ground in the country and the thinnest air with it.' },
  { id: 'twelve-apostles', name: 'Twelve Apostles', region: 'VIC', lat: -38.665, lon: 143.105, elevationM: 70, openArcs: [[170, 320]], waterHorizon: true, clarity: 0.8, note: 'Limestone stacks on a south-facing coast. Best when the sun sets well to the south-west.' },
  { id: 'lake-tyrrell', name: 'Lake Tyrrell', region: 'VIC', lat: -35.36, lon: 142.8, elevationM: 60, openArcs: [[0, 359]], waterHorizon: true, clarity: 0.9, note: 'A salt lake that mirrors the entire sky when a film of water sits on the crust.' },
  { id: 'wilsons-prom', name: 'Wilsons Promontory', region: 'VIC', lat: -39.03, lon: 146.32, elevationM: 60, openArcs: [[200, 60]], waterHorizon: true, clarity: 0.86, note: 'Granite headlands at the southern tip of the mainland, open to the west and north.' },
  { id: 'kunanyi', name: 'kunanyi / Mount Wellington', region: 'TAS', lat: -42.896, lon: 147.237, elevationM: 1271, openArcs: [[0, 359]], waterHorizon: true, clarity: 0.85, note: 'A full 360 over the Derwent estuary. Cold, exposed, and worth it.' },
  { id: 'wineglass', name: 'Wineglass Bay Lookout', region: 'TAS', lat: -42.157, lon: 148.297, elevationM: 200, openArcs: [[20, 170]], waterHorizon: true, clarity: 0.9, note: 'Granite saddle above the bay, facing east into the Tasman Sea.' },
  { id: 'cradle-mountain', name: 'Dove Lake, Cradle Mountain', region: 'TAS', lat: -41.684, lon: 145.953, elevationM: 940, openArcs: [[190, 40]], waterHorizon: true, clarity: 0.88, note: 'Still water under dolerite spires. The long southern twilight holds colour for ages.' },
  { id: 'uluru', name: 'Uluru sunset viewing area', region: 'NT', lat: -25.345, lon: 131.036, elevationM: 500, openArcs: [[0, 359]], waterHorizon: false, clarity: 0.95, note: 'The rock takes the colour, not the sky. Desert air is about as clear as it gets.' },
  { id: 'kata-tjuta', name: 'Kata Tjuta dune viewing', region: 'NT', lat: -25.298, lon: 130.737, elevationM: 550, openArcs: [[0, 359]], waterHorizon: false, clarity: 0.95, note: 'Open dune platform with the domes to the west and Uluru behind you.' },
  { id: 'kings-canyon', name: 'Kings Canyon rim', region: 'NT', lat: -24.256, lon: 131.567, elevationM: 700, openArcs: [[0, 359]], waterHorizon: false, clarity: 0.94, note: 'Sandstone walls that go furnace-orange for about ten minutes.' },
  { id: 'mindil', name: 'Mindil Beach, Darwin', region: 'NT', lat: -12.443, lon: 130.829, elevationM: 5, openArcs: [[200, 340]], waterHorizon: true, clarity: 0.75, note: 'Straight west over the Timor Sea. Fast tropical twilight, so do not be late.' },
  { id: 'cable-beach', name: 'Cable Beach, Broome', region: 'WA', lat: -17.961, lon: 122.212, elevationM: 6, openArcs: [[190, 350]], waterHorizon: true, clarity: 0.88, note: 'Twenty-two kilometres of west-facing sand and famously clean dry-season air.' },
  { id: 'cape-leeuwin', name: 'Cape Leeuwin', region: 'WA', lat: -34.372, lon: 115.136, elevationM: 20, openArcs: [[130, 340]], waterHorizon: true, clarity: 0.85, note: 'Where the Indian and Southern oceans meet. Open from south-east right round to north-west.' },
  { id: 'cape-naturaliste', name: 'Cape Naturaliste', region: 'WA', lat: -33.537, lon: 115.017, elevationM: 40, openArcs: [[230, 60]], waterHorizon: true, clarity: 0.85, note: 'North-west facing headland, which keeps working through the summer months.' },
  { id: 'pinnacles', name: 'The Pinnacles, Nambung', region: 'WA', lat: -30.604, lon: 115.158, elevationM: 30, openArcs: [[200, 340]], waterHorizon: true, clarity: 0.9, note: 'Limestone spires that throw metre-long shadows in the last twenty minutes.' },
  { id: 'cottesloe', name: 'Cottesloe Beach, Perth', region: 'WA', lat: -31.996, lon: 115.752, elevationM: 5, openArcs: [[200, 340]], waterHorizon: true, clarity: 0.55, note: 'The most convenient clean western horizon in any Australian capital.' },
  { id: 'karijini', name: 'Oxer Lookout, Karijini', region: 'WA', lat: -22.481, lon: 118.29, elevationM: 700, openArcs: [[0, 359]], waterHorizon: false, clarity: 0.95, note: 'Four gorges meeting under an enormous Pilbara sky.' },
  { id: 'coral-bay', name: 'Coral Bay, Ningaloo', region: 'WA', lat: -23.143, lon: 113.766, elevationM: 5, openArcs: [[200, 340]], waterHorizon: true, clarity: 0.92, note: 'Reef-sheltered water to the west and almost no light pollution in any direction.' },
  { id: 'bunda-cliffs', name: 'Bunda Cliffs, Nullarbor', region: 'SA', lat: -31.55, lon: 130.5, elevationM: 90, openArcs: [[110, 300]], waterHorizon: true, clarity: 0.96, note: 'Ninety metres of vertical limestone above the Southern Ocean, and no one for miles.' },
  { id: 'wilpena', name: 'Wilpena Pound, Flinders Ranges', region: 'SA', lat: -31.541, lon: 138.593, elevationM: 500, openArcs: [[0, 359]], waterHorizon: false, clarity: 0.94, note: 'Ancient quartzite ridges that light up long before the sun clears the horizon.' },
  { id: 'remarkable-rocks', name: 'Remarkable Rocks, Kangaroo Island', region: 'SA', lat: -36.049, lon: 136.746, elevationM: 60, openArcs: [[160, 320]], waterHorizon: true, clarity: 0.88, note: 'Wind-carved granite on a south-west facing dome. Almost purpose-built for backlight.' },
  { id: 'lake-eyre', name: 'Halligan Point, Kati Thanda', region: 'SA', lat: -28.36, lon: 137.36, elevationM: 0, openArcs: [[0, 359]], waterHorizon: true, clarity: 0.96, note: 'Salt pan below sea level. In flood years the reflections are the whole photograph.' },
  { id: 'whitehaven', name: 'Whitehaven Beach', region: 'QLD', lat: -20.283, lon: 149.038, elevationM: 5, openArcs: [[30, 190]], waterHorizon: true, clarity: 0.88, note: 'Silica sand and tidal channels facing east across the Coral Sea.' },
  { id: 'cape-trib', name: 'Cape Tribulation', region: 'QLD', lat: -16.084, lon: 145.466, elevationM: 10, openArcs: [[20, 180]], waterHorizon: true, clarity: 0.82, note: 'Rainforest running into reef. Humid, so expect softer and warmer light.' },
  { id: 'glass-house', name: 'Glass House Mountains lookout', region: 'QLD', lat: -26.898, lon: 152.955, elevationM: 220, openArcs: [[120, 260]], waterHorizon: false, clarity: 0.7, note: 'Volcanic plugs that catch side light beautifully in the last half hour.' },
  { id: 'punsand', name: 'Punsand Bay, Cape York', region: 'QLD', lat: -10.712, lon: 142.243, elevationM: 5, openArcs: [[250, 30]], waterHorizon: true, clarity: 0.85, note: 'The top of the continent, looking north-west over the Torres Strait.' },
];

const SPOTS_BY_ID = Object.fromEntries(SPOTS.map((s) => [s.id, s]));

/* ==========================================================================
 * SECTION 3 — Map projection
 * ========================================================================== */

/**
 * Equirectangular projection. The longitude compression that a real projection
 * would apply is expressed once, in the viewBox aspect ratio, so the mapping
 * from degrees to viewBox units stays perfectly linear and invertible.
 */
const VB_W = 1000;
const LON_SPAN = BOUNDS.lonMax - BOUNDS.lonMin;
const LAT_SPAN = BOUNDS.latMax - BOUNDS.latMin;
const MID_LAT_COS = Math.cos(((BOUNDS.latMin + BOUNDS.latMax) / 2) * RAD);
const VB_H = Math.round((VB_W * LAT_SPAN) / (LON_SPAN * MID_LAT_COS));

const projectX = (lon) => ((lon - BOUNDS.lonMin) / LON_SPAN) * VB_W;
const projectY = (lat) => ((BOUNDS.latMax - lat) / LAT_SPAN) * VB_H;
const unprojectLon = (x) => BOUNDS.lonMin + (x / VB_W) * LON_SPAN;
const unprojectLat = (y) => BOUNDS.latMax - (y / VB_H) * LAT_SPAN;

/** Turn a ring of [lon, lat] into an SVG path string. */
const toPath = (ring) =>
  ring.map(([lon, lat], i) => `${i ? 'L' : 'M'}${projectX(lon).toFixed(1)} ${projectY(lat).toFixed(1)}`).join(' ') + ' Z';

const LAND_PATHS = LANDMASSES.map(toPath);

/* ==========================================================================
 * SECTION 4 — Storage
 * ========================================================================== */

const STORAGE_PREFIX = 'fll:v1:';

/**
 * localStorage with a transparent in-memory fallback.
 *
 * Reading `window.localStorage` *throws* in Safari private browsing, in
 * sandboxed iframes, and when a user has blocked site data — it does not
 * return null. So the probe has to be a real write inside a try/catch, and
 * every later call needs its own guard because quota can be exhausted at any
 * point. `mode` is surfaced in the UI so people know whether their saved spots
 * will actually survive a refresh.
 */
function createStorage() {
  const memory = new Map();
  let backend = null;

  try {
    const probe = `${STORAGE_PREFIX}__probe__`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    backend = window.localStorage;
  } catch {
    backend = null;
  }

  return {
    mode: backend ? 'localStorage' : 'memory',

    /** @returns {*} the parsed value, or `fallback` on any failure */
    get(key, fallback) {
      try {
        const raw = backend
          ? backend.getItem(STORAGE_PREFIX + key)
          : memory.has(key) ? memory.get(key) : null;
        if (raw === null || raw === undefined) return fallback;
        return JSON.parse(raw);
      } catch {
        // Corrupt JSON from an older version, or a read failure. Do not let a
        // bad saved value take down the whole app.
        return fallback;
      }
    },

    /** @returns {boolean} whether the value was persisted */
    set(key, value) {
      const raw = JSON.stringify(value);
      try {
        if (backend) backend.setItem(STORAGE_PREFIX + key, raw);
        else memory.set(key, raw);
        return true;
      } catch {
        // Quota exceeded. Keep it in memory so the session still works.
        memory.set(key, raw);
        return false;
      }
    },
  };
}

/* ==========================================================================
 * SECTION 5 — Clipboard
 * ========================================================================== */

/**
 * Copy text, trying the async Clipboard API first and falling back to a hidden
 * textarea with `execCommand`.
 *
 * The fallback matters: the async API needs a secure context, so it is absent
 * on plain http, and iOS Safari needs an explicit Range selection rather than
 * `select()` on a textarea.
 *
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    }
  } catch {
    // Permission denied or not user-initiated. Fall through to the legacy path.
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);

    if (/ipad|iphone|ipod/i.test(navigator.userAgent)) {
      const range = document.createRange();
      range.selectNodeContents(ta);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      ta.setSelectionRange(0, text.length);
    } else {
      ta.select();
    }

    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok ? { ok: true } : { ok: false, error: 'The browser blocked the copy.' };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'Copy failed.' };
  }
}

/* ==========================================================================
 * SECTION 6 — Styles
 * ========================================================================== */

/**
 * Design notes.
 *
 * The palette is the sky twenty minutes after sunset: deep blue-violet, with
 * eucalypt green as the only interface accent. Every warm colour on screen is
 * therefore *data* — the terminator on the map, the ribbon, the event times —
 * which is what makes the map read at a glance.
 *
 * Fraunces carries the display type; Archivo handles interface and data, set
 * with tabular figures so columns of times line up. Both fall back to system
 * stacks if the webfont request fails, which it will in an offline install.
 */
const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,400;9..144,600&display=swap');

.fll {
  --ink: #0D1124;
  --ink-1: #141935;
  --ink-2: #1C2246;
  --hair: #2C3565;
  --hair-soft: #222a52;
  --paper: #EAE9F4;
  --muted: #9698BE;
  --faint: #6B6F98;

  --eucalypt: #93C3A8;
  --eucalypt-deep: #4E7A64;

  --dawn: #FFB067;
  --ember: #F2764C;
  --violet: #8B6FD1;
  --deep: #3A46A8;

  --display: 'Fraunces', ui-serif, Georgia, 'Times New Roman', serif;
  --ui: 'Archivo', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;

  font-family: var(--ui);
  font-variant-numeric: tabular-nums;
  background: var(--ink);
  color: var(--paper);
  min-height: 100%;
  padding: 22px;
  box-sizing: border-box;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.fll *, .fll *::before, .fll *::after { box-sizing: border-box; }

.fll :focus-visible {
  outline: 2px solid var(--eucalypt);
  outline-offset: 2px;
  border-radius: 2px;
}

/* ---- Header ---- */
.fll-head {
  display: flex; flex-wrap: wrap; align-items: flex-end;
  justify-content: space-between; gap: 18px;
  padding-bottom: 16px; margin-bottom: 20px;
  border-bottom: 1px solid var(--hair);
}
.fll-title {
  font-family: var(--display);
  font-size: 34px; font-weight: 600; line-height: 1.05;
  letter-spacing: -0.01em; margin: 0;
}
.fll-sub { color: var(--muted); font-size: 13.5px; margin: 6px 0 0; max-width: 46ch; }

/* ---- Date stepper ---- */
.fll-datebar { display: flex; align-items: center; gap: 8px; }
.fll-date {
  font-family: var(--ui); font-size: 14px; font-variant-numeric: tabular-nums;
  background: var(--ink-2); color: var(--paper);
  border: 1px solid var(--hair); border-radius: 3px;
  padding: 7px 10px; min-width: 148px;
}

/* ---- Buttons ---- */
.fll-btn {
  font: inherit; font-size: 13px; font-weight: 500;
  display: inline-flex; align-items: center; gap: 7px;
  background: var(--ink-2); color: var(--paper);
  border: 1px solid var(--hair); border-radius: 3px;
  padding: 7px 12px; cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.fll-btn:hover { background: #232a52; border-color: #3b4680; }
.fll-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.fll-btn--icon { padding: 7px 8px; }
.fll-btn--primary {
  background: var(--eucalypt-deep); border-color: var(--eucalypt-deep); color: #F2FBF6;
  width: 100%; justify-content: center; padding: 11px 14px; font-size: 14px; font-weight: 600;
}
.fll-btn--primary:hover { background: #5b8d74; border-color: #5b8d74; }
.fll-btn--done { background: var(--eucalypt); border-color: var(--eucalypt); color: #0D2A1B; }
.fll-btn--done:hover { background: var(--eucalypt); border-color: var(--eucalypt); }

/* ---- Segmented control ---- */
.fll-seg { display: inline-flex; border: 1px solid var(--hair); border-radius: 3px; overflow: hidden; }
.fll-seg button {
  font: inherit; font-size: 13px; font-weight: 500;
  display: inline-flex; align-items: center; gap: 7px;
  background: transparent; color: var(--muted);
  border: 0; padding: 8px 15px; cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.fll-seg button + button { border-left: 1px solid var(--hair); }
.fll-seg button:hover { color: var(--paper); }
.fll-seg button[aria-pressed='true'] { background: var(--ink-2); color: var(--paper); }

/* ---- Layout ---- */
.fll-grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(310px, 1fr); gap: 26px; align-items: start; }
@media (max-width: 940px) { .fll-grid { grid-template-columns: 1fr; gap: 22px; } }

/* ---- Map ---- */
.fll-mapwrap {
  position: relative; width: 100%;
  background: #090C1C;
  border: 1px solid var(--hair);
  border-radius: 3px; overflow: hidden;
}
.fll-mapratio { width: 100%; height: 0; }
.fll-maplayer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: block; }
.fll-mapcanvas { image-rendering: auto; pointer-events: none; }
.fll-mapsvg { cursor: crosshair; touch-action: manipulation; }
.fll-mapsvg:focus-visible { outline: 2px solid var(--eucalypt); outline-offset: -2px; }

.fll-land { fill: #171D3B; stroke: #39457E; stroke-width: 1.6; stroke-linejoin: round; }
.fll-landtop { fill: none; stroke: rgba(147,195,168,0.34); stroke-width: 1; }

.fll-spotdot { fill: rgba(234,233,244,0.5); }
.fll-spotdot--top { fill: var(--eucalypt); }
.fll-spothit { fill: transparent; cursor: pointer; }
.fll-spothit:hover + .fll-spotdot, .fll-spothit:focus-visible + .fll-spotdot { fill: #fff; }

.fll-maplegend {
  position: absolute; left: 12px; bottom: 10px;
  display: flex; align-items: center; gap: 10px;
  font-size: 11px; color: var(--muted);
  background: rgba(9,12,28,0.72); padding: 6px 10px; border-radius: 3px;
  border: 1px solid var(--hair-soft);
}
.fll-legendramp { width: 88px; height: 8px; border-radius: 1px; }

/* ---- Transport controls ---- */
.fll-transport { display: flex; align-items: center; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
.fll-clock {
  font-family: var(--display); font-size: 25px; font-weight: 600;
  letter-spacing: -0.01em; min-width: 78px;
}
.fll-clocknote { font-size: 11.5px; color: var(--faint); margin-top: -2px; }

.fll-range { flex: 1 1 200px; min-width: 140px; }
.fll-range input[type='range'] {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 22px; background: transparent; cursor: pointer; margin: 0; display: block;
}
.fll-range input[type='range']::-webkit-slider-runnable-track {
  height: 3px; background: var(--hair); border-radius: 2px;
}
.fll-range input[type='range']::-moz-range-track {
  height: 3px; background: var(--hair); border-radius: 2px;
}
.fll-range input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 15px; height: 15px; border-radius: 50%;
  background: var(--paper); border: 0; margin-top: -6px;
}
.fll-range input[type='range']::-moz-range-thumb {
  width: 15px; height: 15px; border-radius: 50%;
  background: var(--paper); border: 0;
}

/* ---- Day ribbon ---- */
.fll-ribbonwrap { margin-top: 16px; }
.fll-ribbon { display: block; width: 100%; height: 76px; }

/* ---- Right rail ---- */
.fll-panel { border: 1px solid var(--hair); border-radius: 3px; padding: 18px; background: var(--ink-1); }
.fll-panel + .fll-panel { margin-top: 18px; }

.fll-eyebrow { font-size: 12px; color: var(--faint); margin: 0 0 3px; }
.fll-place { font-family: var(--display); font-size: 23px; font-weight: 600; line-height: 1.15; margin: 0; }
.fll-coords { font-size: 12px; color: var(--muted); margin: 5px 0 0; }
.fll-note { font-size: 13px; color: var(--muted); margin: 12px 0 0; }

.fll-hero { margin: 18px 0 0; padding: 14px 0; border-top: 1px solid var(--hair); border-bottom: 1px solid var(--hair); }
.fll-herolabel { font-size: 12.5px; color: var(--muted); margin: 0 0 2px; }
.fll-herotime {
  font-family: var(--display); font-size: 46px; font-weight: 600;
  line-height: 1; letter-spacing: -0.02em; color: var(--dawn); margin: 0;
}
.fll-herozone { font-family: var(--ui); font-size: 14px; font-weight: 500; color: var(--muted); margin-left: 8px; letter-spacing: 0; }
.fll-herohint { font-size: 12.5px; color: var(--faint); margin: 7px 0 0; }

.fll-rows { margin: 14px 0 0; }
.fll-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  padding: 7px 0; font-size: 13.5px;
}
.fll-row + .fll-row { border-top: 1px solid var(--hair-soft); }
.fll-row dt { color: var(--muted); margin: 0; }
.fll-row dd { margin: 0; font-weight: 500; font-variant-numeric: tabular-nums; }

/* ---- Score ---- */
.fll-scorehead { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.fll-scorenum { font-family: var(--display); font-size: 30px; font-weight: 600; line-height: 1; }
.fll-scoregrade { font-size: 13px; color: var(--eucalypt); }
.fll-bars { margin-top: 12px; }
.fll-bar { display: grid; grid-template-columns: 74px 1fr 30px; align-items: center; gap: 9px; font-size: 12px; padding: 3px 0; }
.fll-bar span:first-child { color: var(--muted); }
.fll-bartrack { height: 4px; background: var(--ink-2); border-radius: 2px; overflow: hidden; }
.fll-barfill { height: 100%; background: var(--eucalypt-deep); border-radius: 2px; }
.fll-bar span:last-child { color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }

/* ---- Ranked list ---- */
.fll-rank { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.fll-rank th {
  text-align: left; font-size: 12px; font-weight: 500; color: var(--faint);
  padding: 0 10px 8px 0; border-bottom: 1px solid var(--hair);
}
.fll-rank th:last-child, .fll-rank td:last-child { text-align: right; padding-right: 0; }
.fll-rank td { padding: 9px 10px 9px 0; border-bottom: 1px solid var(--hair-soft); }
.fll-rank tbody tr { cursor: pointer; }
.fll-rank tbody tr:hover td { background: var(--ink-1); }
.fll-rank tbody tr[aria-selected='true'] td { background: var(--ink-2); }
.fll-rankpos { color: var(--faint); width: 26px; font-variant-numeric: tabular-nums; }
.fll-rankname { font-weight: 500; }
.fll-rankregion { color: var(--faint); font-size: 12px; margin-left: 7px; font-weight: 400; }
.fll-rankscore { font-variant-numeric: tabular-nums; }

/* ---- Saved list ---- */
.fll-saved { display: flex; align-items: center; gap: 10px; padding: 9px 0; font-size: 13.5px; }
.fll-saved + .fll-saved { border-top: 1px solid var(--hair-soft); }
.fll-savedmain { flex: 1; min-width: 0; text-align: left; background: none; border: 0; color: inherit; font: inherit; cursor: pointer; padding: 0; }
.fll-savedmain:hover { color: var(--eucalypt); }
.fll-savedname { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fll-savedmeta { display: block; font-size: 11.5px; color: var(--faint); }
.fll-iconbtn {
  background: none; border: 0; color: var(--faint); cursor: pointer;
  padding: 4px; display: inline-flex; border-radius: 2px;
}
.fll-iconbtn:hover { color: var(--ember); }

/* ---- Forms ---- */
.fll-field { display: block; margin-top: 12px; font-size: 12.5px; color: var(--muted); }
.fll-field input, .fll-field select {
  display: block; width: 100%; margin-top: 5px;
  font: inherit; font-size: 13.5px; font-variant-numeric: tabular-nums;
  background: var(--ink-2); color: var(--paper);
  border: 1px solid var(--hair); border-radius: 3px; padding: 8px 10px;
}
.fll-fieldrow { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.fll-err { color: var(--ember); font-size: 12px; margin-top: 6px; display: flex; gap: 6px; align-items: flex-start; }

/* ---- Notices ---- */
.fll-notice {
  display: flex; gap: 10px; align-items: flex-start;
  font-size: 12.5px; color: var(--muted);
  border: 1px solid var(--hair); border-left: 2px solid var(--dawn);
  background: var(--ink-1); padding: 11px 13px; border-radius: 3px; margin-bottom: 18px;
}
.fll-notice svg { flex: none; margin-top: 1px; color: var(--dawn); }

.fll-foot { margin-top: 26px; padding-top: 16px; border-top: 1px solid var(--hair); font-size: 12px; color: var(--faint); max-width: 78ch; }
.fll-foot p { margin: 0 0 7px; }

/* ---- Toast ---- */
.fll-toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  z-index: 40; max-width: min(92vw, 460px);
  display: flex; gap: 10px; align-items: flex-start;
  background: var(--ink-2); color: var(--paper);
  border: 1px solid var(--hair); border-radius: 3px;
  padding: 12px 14px; font-size: 13px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.45);
}
.fll-toast--bad { border-left: 2px solid var(--ember); }
.fll-toast--good { border-left: 2px solid var(--eucalypt); }
.fll-toast textarea {
  width: 100%; margin-top: 8px; min-height: 88px;
  font: inherit; font-size: 12px;
  background: var(--ink); color: var(--paper);
  border: 1px solid var(--hair); border-radius: 3px; padding: 8px;
}

/* ---- Error boundary ---- */
.fll-crash { max-width: 60ch; margin: 60px auto; padding: 26px; border: 1px solid var(--hair); border-radius: 3px; }
.fll-crash h2 { font-family: var(--display); font-size: 24px; font-weight: 600; margin: 0 0 10px; }
.fll-crash pre {
  font-size: 12px; color: var(--muted); background: var(--ink-1);
  padding: 12px; border-radius: 3px; overflow-x: auto; white-space: pre-wrap;
}

@media (prefers-reduced-motion: reduce) {
  .fll * { transition: none !important; animation: none !important; }
}

@media (max-width: 560px) {
  .fll { padding: 14px; }
  .fll-title { font-size: 27px; }
  .fll-herotime { font-size: 38px; }
  .fll-head { gap: 12px; }
  .fll-datebar { width: 100%; }
  .fll-date { flex: 1; min-width: 0; }
}
`;

/* ==========================================================================
 * SECTION 7 — Small helpers
 * ========================================================================== */

/** 'YYYY-MM-DD' -> {year, month, day}, or null if malformed. */
function parseDateInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject 31 February and friends by round-tripping through Date.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

const toDateInput = (d) =>
  `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

/** Shift a civil date by whole days without timezone surprises. */
function shiftCivilDate(civil, days) {
  const d = new Date(Date.UTC(civil.year, civil.month - 1, civil.day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const formatDuration = (minutes) =>
  minutes === null || minutes === undefined
    ? '—'
    : `${Math.floor(minutes / 60)}h ${String(Math.abs(minutes) % 60).padStart(2, '0')}m`;

/** Compass point for a bearing, e.g. 247 -> 'WSW'. */
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compassPoint = (bearing) => COMPASS[Math.round(norm360(bearing) / 22.5) % 16];

/** Horizon presets offered for a dropped pin, since we have no terrain data. */
const HORIZON_PRESETS = {
  open: { label: 'Open in every direction', arcs: [[0, 359]], factor: 1 },
  coastEast: { label: 'Open to the east (coast or plain)', arcs: [[20, 190]], factor: 1 },
  coastWest: { label: 'Open to the west (coast or plain)', arcs: [[200, 340]], factor: 1 },
  enclosed: { label: 'Enclosed (valley, forest, or town)', arcs: [[70, 110], [250, 290]], factor: 1 },
};

/* ==========================================================================
 * SECTION 8 — Error boundary
 * ========================================================================== */

/**
 * Catches render-time exceptions anywhere below it so a single bad coordinate
 * cannot leave the user staring at a blank page.
 */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // In a real deployment this is where you would forward to your own
    // error reporting. Nothing leaves the device in this build.
    console.error('First & Last Light crashed:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fll">
          <style>{STYLES}</style>
          <div className="fll-crash">
            <h2>Something in the calculation broke</h2>
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>
              Reload to start again. Your saved spots are untouched.
            </p>
            <pre>{String(this.state.error && this.state.error.message)}</pre>
            <button
              className="fll-btn"
              style={{ marginTop: 14 }}
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ==========================================================================
 * SECTION 9 — Map
 * ========================================================================== */

/**
 * The map. A canvas underneath paints the terminator by evaluating solar
 * elevation on a coarse grid; an SVG on top draws the coastline, the site
 * markers, the pin and its horizon wedge.
 *
 * Both layers are stretched to the same box and share one linear projection,
 * so they stay aligned at any size without a resize observer.
 */
const GRID_W = 150;
const GRID_H = Math.round((GRID_W * VB_H) / VB_W);

function SunMap({
  mapTime,
  site,
  ranked,
  onPick,
  onSelectSpot,
  eventMode,
  eventAzimuth,
}) {
  const canvasRef = useRef(null);
  const svgRef = useRef(null);

  /**
   * Paint the terminator.
   *
   * Performance note: declination and the equation of time depend only on the
   * instant, and cos(hourAngle) depends only on longitude, so both are hoisted
   * out of the inner loop. What remains per cell is two multiplies, an add and
   * one acos — about 22,000 of them, which comfortably holds 60fps.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let ctx;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      return; // Canvas unavailable; the SVG layer still renders on its own.
    }
    if (!ctx) return;

    try {
      const image = ctx.createImageData(GRID_W, GRID_H);
      const data = image.data;

      const jd = toJulianDay(mapTime);
      const t = julianCentury(jd);
      const decl = sunDeclination(t) * RAD;
      const sinDecl = Math.sin(decl);
      const cosDecl = Math.cos(decl);
      const eqTime = equationOfTime(t);
      const utcMinutes = ((((jd + 0.5) % 1) + 1) % 1) * 1440;

      // cos(hour angle) varies with longitude only.
      const cosHa = new Float64Array(GRID_W);
      for (let x = 0; x < GRID_W; x++) {
        const lon = BOUNDS.lonMin + ((x + 0.5) / GRID_W) * LON_SPAN;
        const trueSolarTime = (((utcMinutes + eqTime + 4 * lon) % 1440) + 1440) % 1440;
        let ha = trueSolarTime / 4 - 180;
        if (ha < -180) ha += 360;
        cosHa[x] = Math.cos(ha * RAD);
      }

      for (let y = 0; y < GRID_H; y++) {
        const lat = (BOUNDS.latMax - ((y + 0.5) / GRID_H) * LAT_SPAN) * RAD;
        const sinLat = Math.sin(lat);
        const cosLat = Math.cos(lat);
        const rowBase = y * GRID_W * 4;

        for (let x = 0; x < GRID_W; x++) {
          const cosZ = clamp(sinDecl * sinLat + cosDecl * cosLat * cosHa[x], -1, 1);
          const elevation = 90 - Math.acos(cosZ) * DEG;
          const lut = lutIndex(elevation) * 4;
          const px = rowBase + x * 4;
          data[px] = TWILIGHT_LUT[lut];
          data[px + 1] = TWILIGHT_LUT[lut + 1];
          data[px + 2] = TWILIGHT_LUT[lut + 2];
          data[px + 3] = TWILIGHT_LUT[lut + 3];
        }
      }

      ctx.putImageData(image, 0, 0);
    } catch (err) {
      console.error('Terminator render failed:', err);
    }
  }, [mapTime]);

  /**
   * Translate a pointer or keyboard event into coordinates.
   * `getBoundingClientRect` keeps this correct under any CSS scaling, which
   * `offsetX` would not.
   */
  const eventToCoords = useCallback((clientX, clientY) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = ((clientX - rect.left) / rect.width) * VB_W;
    const y = ((clientY - rect.top) / rect.height) * VB_H;
    return { lat: unprojectLat(y), lon: unprojectLon(x) };
  }, []);

  const handleClick = useCallback(
    (e) => {
      const coords = eventToCoords(e.clientX, e.clientY);
      if (coords) onPick(coords.lat, coords.lon);
    },
    [eventToCoords, onPick]
  );

  /** Arrow keys nudge the pin; the step is a tenth of a degree, Shift makes it a whole degree. */
  const handleKeyDown = useCallback(
    (e) => {
      const step = e.shiftKey ? 1 : 0.1;
      const moves = {
        ArrowUp: [step, 0], ArrowDown: [-step, 0],
        ArrowLeft: [0, -step], ArrowRight: [0, step],
      };
      const move = moves[e.key];
      if (!move) return;
      e.preventDefault();
      onPick(
        clamp(site.lat + move[0], BOUNDS.latMin, BOUNDS.latMax),
        clamp(site.lon + move[1], BOUNDS.lonMin, BOUNDS.lonMax)
      );
    },
    [onPick, site.lat, site.lon]
  );

  // Where the sun is directly overhead. Between roughly October and March this
  // falls inside the frame, which is a nice confirmation that the shading and
  // the geometry agree.
  const subsolar = useMemo(() => {
    const t = julianCentury(toJulianDay(mapTime));
    const decl = sunDeclination(t);
    const eqTime = equationOfTime(t);
    const jd = toJulianDay(mapTime);
    const utcMinutes = ((((jd + 0.5) % 1) + 1) % 1) * 1440;
    // Solar noon happens where true solar time is 720 minutes.
    const lon = norm360((720 - utcMinutes - eqTime) / 4 + 180) - 180;
    return isInFrame(decl, lon) ? { lat: decl, lon } : null;
  }, [mapTime]);

  const topFive = useMemo(() => new Set(ranked.slice(0, 5).map((r) => r.spot.id)), [ranked]);

  const pinX = projectX(site.lon);
  const pinY = projectY(site.lat);

  // Horizon wedge: the arcs the site can actually see, drawn as thin rays.
  const horizonRays = useMemo(() => {
    const rays = [];
    for (const arc of site.openArcs || []) {
      const start = arc[0];
      const span = norm360(arc[1] - arc[0]);
      const steps = Math.max(2, Math.round(span / 12));
      for (let i = 0; i <= steps; i++) {
        rays.push(norm360(start + (span * i) / steps));
      }
    }
    return rays;
  }, [site.openArcs]);

  /**
   * End point of a ray of screen length `length` at a compass bearing.
   *
   * No aspect correction is needed. The viewBox height was derived as
   * VB_W * LAT_SPAN / (LON_SPAN * cos(midLat)), which makes one kilometre north
   * exactly as long on screen as one kilometre east at the middle of the frame.
   * The projection is therefore conformal there, and bearings can be drawn with
   * plain sine and cosine. Screen y grows downward while north is up, hence the
   * negative cosine.
   */
  const rayEnd = (bearing, length) => ({
    x: pinX + Math.sin(bearing * RAD) * length,
    y: pinY - Math.cos(bearing * RAD) * length,
  });

  return (
    <div>
      <div className="fll-mapwrap">
        {/* Padding-ratio box: works in every target browser, unlike aspect-ratio. */}
        <div className="fll-mapratio" style={{ paddingTop: `${(VB_H / VB_W) * 100}%` }} />

        <canvas
          ref={canvasRef}
          className="fll-maplayer fll-mapcanvas"
          width={GRID_W}
          height={GRID_H}
          aria-hidden="true"
        />

        <svg
          ref={svgRef}
          className="fll-maplayer fll-mapsvg"
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          preserveAspectRatio="none"
          role="application"
          tabIndex={0}
          aria-label="Map of Australia. Click to drop a pin, or use the arrow keys to move it."
          onClick={handleClick}
          onKeyDown={handleKeyDown}
        >
          <title>Sun position over Australia</title>

          {/* Coastline. Drawn twice: a filled body, then a light rim so the
              land stays legible under the darkest part of the terminator. */}
          {LAND_PATHS.map((d, i) => (
            <path key={`land-${i}`} d={d} className="fll-land" />
          ))}
          {LAND_PATHS.map((d, i) => (
            <path key={`rim-${i}`} d={d} className="fll-landtop" />
          ))}

          {/* Curated sites. The current top five are picked out in eucalypt. */}
          {SPOTS.map((spot) => (
            <g key={spot.id}>
              <circle
                className="fll-spothit"
                cx={projectX(spot.lon)}
                cy={projectY(spot.lat)}
                r={14}
                role="button"
                tabIndex={0}
                aria-label={`${spot.name}, ${spot.region}`}
                onClick={(e) => { e.stopPropagation(); onSelectSpot(spot.id); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onSelectSpot(spot.id);
                  }
                }}
              />
              <circle
                className={`fll-spotdot${topFive.has(spot.id) ? ' fll-spotdot--top' : ''}`}
                cx={projectX(spot.lon)}
                cy={projectY(spot.lat)}
                r={topFive.has(spot.id) ? 4.5 : 3}
                pointerEvents="none"
              />
            </g>
          ))}

          {/* Subsolar point: where the sun is straight overhead right now. */}
          {subsolar && (
            <g pointerEvents="none">
              <circle cx={projectX(subsolar.lon)} cy={projectY(subsolar.lat)} r={16} fill="rgba(255,214,140,0.16)" />
              <circle cx={projectX(subsolar.lon)} cy={projectY(subsolar.lat)} r={5} fill="#FFE2A8" />
            </g>
          )}

          {/* The selected site: horizon rays, then the event bearing, then the pin. */}
          <g pointerEvents="none">
            {horizonRays.map((bearing, i) => {
              const end = rayEnd(bearing, 26);
              return (
                <line
                  key={`ray-${i}`}
                  x1={pinX} y1={pinY} x2={end.x} y2={end.y}
                  stroke="rgba(147,195,168,0.45)" strokeWidth={1.2}
                />
              );
            })}

            {Number.isFinite(eventAzimuth) && (() => {
              const end = rayEnd(eventAzimuth, 62);
              return (
                <line
                  x1={pinX} y1={pinY} x2={end.x} y2={end.y}
                  stroke={eventMode === 'sunrise' ? '#FFB067' : '#F2764C'}
                  strokeWidth={2.6} strokeLinecap="round"
                />
              );
            })()}

            <circle cx={pinX} cy={pinY} r={9} fill="none" stroke="#0D1124" strokeWidth={4} />
            <circle cx={pinX} cy={pinY} r={9} fill="none" stroke="#FFFFFF" strokeWidth={2} />
            <circle cx={pinX} cy={pinY} r={2.6} fill="#FFFFFF" />
          </g>
        </svg>

        <div className="fll-maplegend">
          <span>Day</span>
          <span
            className="fll-legendramp"
            style={{
              background:
                'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,214,140,0.6) 22%, rgba(244,118,76,0.85) 42%, rgba(139,111,209,0.9) 62%, rgba(38,46,112,0.95) 80%, #0A0D22 100%)',
            }}
          />
          <span>Night</span>
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
 * SECTION 10 — Day ribbon
 * ========================================================================== */

/**
 * A twenty-four hour strip of the sky's colour at the selected site, running
 * local midnight to local midnight, with the event markers laid over it.
 *
 * This is the piece that makes the twenty-minute rule legible: you can see the
 * peak-colour marker sitting inside the coloured band rather than at the moment
 * the sun touches the horizon.
 */
const RIBBON_SAMPLES = 240;
const RIBBON_W = 1000;
const RIBBON_H = 76;
const BAND_TOP = 8;
const BAND_H = 30;

function DayRibbon({ site, times, dayStart, timeZone, mapTime, eventMode, onScrub }) {
  const samples = useMemo(() => {
    const out = [];
    try {
      for (let i = 0; i < RIBBON_SAMPLES; i++) {
        const at = new Date(dayStart.getTime() + (i / RIBBON_SAMPLES) * MS_PER_DAY);
        const { elevation } = solarPosition(at, site.lat, site.lon);
        const c = twilightColour(elevation);
        // The ramp is designed to sit *over* a daylight background, so
        // composite it against a pale sky here to get a standalone strip.
        const bg = [214, 226, 240];
        out.push(
          `rgb(${Math.round(lerp(bg[0], c.r, c.a))},${Math.round(lerp(bg[1], c.g, c.a))},${Math.round(lerp(bg[2], c.b, c.a))})`
        );
      }
    } catch (err) {
      console.error('Ribbon sampling failed:', err);
    }
    return out;
  }, [site.lat, site.lon, dayStart]);

  /** Fraction of the day, 0..1, for an instant. Null if it falls outside. */
  const fraction = useCallback(
    (date) => {
      if (!date) return null;
      const f = (date.getTime() - dayStart.getTime()) / MS_PER_DAY;
      return f >= 0 && f <= 1 ? f : null;
    },
    [dayStart]
  );

  const isRise = eventMode === 'sunrise';
  const markers = [
    { at: isRise ? times.peakColourSunrise : times.peakColourSunset, label: 'Peak colour', colour: '#FFD27A', strong: true },
    { at: isRise ? times.sunrise : times.sunset, label: isRise ? 'Sunrise' : 'Sunset', colour: '#F2764C', strong: true },
    { at: isRise ? times.civilDawn : times.civilDusk, label: isRise ? 'Civil dawn' : 'Civil dusk', colour: '#8B6FD1', strong: false },
  ];

  const nowF = fraction(mapTime);

  const handleScrub = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const f = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    onScrub(new Date(dayStart.getTime() + f * MS_PER_DAY));
  };

  return (
    <div className="fll-ribbonwrap">
      <svg
        className="fll-ribbon"
        viewBox={`0 0 ${RIBBON_W} ${RIBBON_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Sky colour across the day at ${site.name}`}
        onClick={handleScrub}
        style={{ cursor: 'pointer' }}
      >
        {samples.map((fill, i) => (
          <rect
            key={i}
            x={(i / RIBBON_SAMPLES) * RIBBON_W}
            y={BAND_TOP}
            width={RIBBON_W / RIBBON_SAMPLES + 0.6}
            height={BAND_H}
            fill={fill}
          />
        ))}

        {/* Three-hourly ticks give the strip a readable time axis. */}
        {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((hour) => {
          const x = (hour / 24) * RIBBON_W;
          return (
            <g key={hour}>
              <line
                x1={x} y1={BAND_TOP + BAND_H} x2={x} y2={BAND_TOP + BAND_H + 5}
                stroke="#3B4680" strokeWidth={1}
              />
              <text
                x={clamp(x, 12, RIBBON_W - 12)} y={BAND_TOP + BAND_H + 17}
                fill="#6B6F98" fontSize={11} textAnchor="middle" fontFamily="Archivo, system-ui, sans-serif"
              >
                {hour === 24 ? '24' : String(hour).padStart(2, '0')}
              </text>
            </g>
          );
        })}

        {markers.map((m) => {
          const f = fraction(m.at);
          if (f === null) return null;
          const x = f * RIBBON_W;
          return (
            <g key={m.label}>
              <line
                x1={x} y1={BAND_TOP - 5} x2={x} y2={BAND_TOP + BAND_H}
                stroke={m.colour} strokeWidth={m.strong ? 2 : 1.2}
              />
              <circle cx={x} cy={BAND_TOP - 5} r={m.strong ? 3.5 : 2.5} fill={m.colour} />
              <text
                x={clamp(x, 40, RIBBON_W - 40)} y={BAND_TOP + BAND_H + 32}
                fill={m.colour} fontSize={11.5} textAnchor="middle" fontFamily="Archivo, system-ui, sans-serif"
              >
                {`${m.label} ${formatInZone(m.at, timeZone)}`}
              </text>
            </g>
          );
        })}

        {nowF !== null && (
          <g>
            <line
              x1={nowF * RIBBON_W} y1={BAND_TOP - 8} x2={nowF * RIBBON_W} y2={BAND_TOP + BAND_H + 6}
              stroke="#EAE9F4" strokeWidth={1.5}
            />
          </g>
        )}
      </svg>
    </div>
  );
}

/* ==========================================================================
 * SECTION 11 — Main application
 * ========================================================================== */

function FirstAndLastLightInner() {
  // The storage adapter is created once and never replaced.
  const storage = useRef(null);
  if (storage.current === null) storage.current = createStorage();
  const store = storage.current;

  // ---- Persistent preferences -------------------------------------------
  const [eventMode, setEventMode] = useState(() => {
    const v = store.get('eventMode', 'sunset');
    return v === 'sunrise' || v === 'sunset' ? v : 'sunset';
  });
  const [peakOffset, setPeakOffset] = useState(() => {
    const v = store.get('peakOffset', DEFAULT_PEAK_OFFSET_MIN);
    return Number.isFinite(v) && v >= 0 && v <= 120 ? v : DEFAULT_PEAK_OFFSET_MIN;
  });
  const [saved, setSaved] = useState(() => {
    const v = store.get('saved', []);
    return Array.isArray(v) ? v.filter((s) => s && Number.isFinite(s.lat) && Number.isFinite(s.lon)) : [];
  });
  const [selection, setSelection] = useState(() => {
    const v = store.get('selection', null);
    if (v && v.kind === 'spot' && SPOTS_BY_ID[v.id]) return v;
    if (v && v.kind === 'pin' && Number.isFinite(v.lat) && Number.isFinite(v.lon)) return v;
    return { kind: 'spot', id: 'uluru' };
  });

  // ---- Session state -----------------------------------------------------
  const [dateStr, setDateStr] = useState(() =>
    toDateInput(civilDateInZone(new Date(), 'Australia/Sydney'))
  );
  const [dateError, setDateError] = useState(null);
  const [pinHorizon, setPinHorizon] = useState('open');
  const [pinElevation, setPinElevation] = useState(0);
  const [mapTime, setMapTime] = useState(() => new Date());
  const [playing, setPlaying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState(null);
  const [latInput, setLatInput] = useState('');
  const [lonInput, setLonInput] = useState('');
  const [coordError, setCoordError] = useState(null);

  // Write preferences back on change. Each is independent so a quota failure
  // on one does not lose the others.
  useEffect(() => { store.set('eventMode', eventMode); }, [store, eventMode]);
  useEffect(() => { store.set('peakOffset', peakOffset); }, [store, peakOffset]);
  useEffect(() => { store.set('saved', saved); }, [store, saved]);
  useEffect(() => { store.set('selection', selection); }, [store, selection]);

  // ---- Derived: the civil date ------------------------------------------
  const civilDate = useMemo(() => {
    const parsed = parseDateInput(dateStr);
    return parsed || civilDateInZone(new Date(), 'Australia/Sydney');
  }, [dateStr]);

  // ---- Derived: the selected site ---------------------------------------
  /**
   * Resolve the selection into a full site record. Curated spots carry real
   * horizon and clarity metadata; a dropped pin gets estimates plus whatever
   * the user tells us about their horizon and height.
   */
  const site = useMemo(() => {
    if (selection.kind === 'spot') {
      const spot = SPOTS_BY_ID[selection.id];
      if (spot) return { ...spot, isCustom: false };
    }
    const lat = clamp(Number(selection.lat) || -25.345, -90, 90);
    const lon = clamp(Number(selection.lon) || 131.036, -180, 180);
    const preset = HORIZON_PRESETS[pinHorizon] || HORIZON_PRESETS.open;
    return {
      id: 'custom',
      name: 'Dropped pin',
      region: isOnLand(lat, lon) ? 'Australia' : 'Offshore',
      lat, lon,
      elevationM: Number.isFinite(pinElevation) ? pinElevation : 0,
      openArcs: preset.arcs,
      waterHorizon: !isOnLand(lat, lon),
      clarity: estimateClarity(lat, lon, CITIES),
      note: '',
      isCustom: true,
    };
  }, [selection, pinHorizon, pinElevation]);

  const timeZone = useMemo(() => {
    try {
      return timezoneForPoint(site.lat, site.lon);
    } catch {
      return 'Australia/Sydney';
    }
  }, [site.lat, site.lon]);

  const times = useMemo(() => {
    try {
      return dayTimes(civilDate, site.lat, site.lon, { peakOffsetMinutes: peakOffset });
    } catch (err) {
      console.error('Failed to compute times:', err);
      return null;
    }
  }, [civilDate, site.lat, site.lon, peakOffset]);

  const dayStart = useMemo(() => localMidnight(civilDate, timeZone), [civilDate, timeZone]);

  const isRise = eventMode === 'sunrise';
  const eventTime = times ? (isRise ? times.sunrise : times.sunset) : null;
  const peakTime = times ? (isRise ? times.peakColourSunrise : times.peakColourSunset) : null;

  const eventAzimuth = useMemo(() => {
    if (!eventTime) return null;
    try {
      return solarPosition(eventTime, site.lat, site.lon).azimuth;
    } catch {
      return null;
    }
  }, [eventTime, site.lat, site.lon]);

  const score = useMemo(() => {
    if (!Number.isFinite(eventAzimuth) || !times) return null;
    return scoreEvent({
      azimuth: eventAzimuth,
      openArcs: site.openArcs,
      twilightMinutes: isRise ? times.civilTwilightMorningMinutes : times.civilTwilightEveningMinutes,
      elevationM: site.elevationM,
      clarity: site.clarity,
      waterHorizon: site.waterHorizon,
    });
  }, [eventAzimuth, times, site, isRise]);

  // ---- Derived: the ranking ---------------------------------------------
  /**
   * Score every curated site for the chosen date and event. Roughly 300 event
   * solves, which measures in single-digit milliseconds, so there is no need
   * for a worker or memoised per-spot caching.
   */
  const ranked = useMemo(() => {
    const rows = [];
    for (const spot of SPOTS) {
      try {
        const t = dayTimes(civilDate, spot.lat, spot.lon, { peakOffsetMinutes: peakOffset });
        const main = isRise ? t.sunrise : t.sunset;
        if (!main) continue;
        const azimuth = solarPosition(main, spot.lat, spot.lon).azimuth;
        rows.push({
          spot,
          times: t,
          eventTime: main,
          timeZone: timezoneForPoint(spot.lat, spot.lon),
          score: scoreEvent({
            azimuth,
            openArcs: spot.openArcs,
            twilightMinutes: isRise ? t.civilTwilightMorningMinutes : t.civilTwilightEveningMinutes,
            elevationM: spot.elevationM,
            clarity: spot.clarity,
            waterHorizon: spot.waterHorizon,
          }),
        });
      } catch (err) {
        // One bad site should never blank the whole table.
        console.error(`Scoring failed for ${spot.id}:`, err);
      }
    }
    return rows.sort((a, b) => b.score.total - a.score.total);
  }, [civilDate, isRise, peakOffset]);

  // ---- Animation ---------------------------------------------------------
  const prefersReducedMotion = useMemo(() => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }, []);

  /**
   * Step the map clock while playing. Driven by requestAnimationFrame rather
   * than setInterval so it pauses with the tab and stays smooth. Three minutes
   * of sky per frame runs a whole day in about eight seconds.
   */
  useEffect(() => {
    if (!playing) return undefined;
    let frame;
    const tick = () => {
      setMapTime((prev) => {
        const next = prev.getTime() + 3 * 60000;
        const end = dayStart.getTime() + MS_PER_DAY;
        return new Date(next >= end ? dayStart.getTime() : next);
      });
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, dayStart]);

  // Keep the map clock inside the selected day when the date or place changes.
  useEffect(() => {
    setMapTime((prev) => {
      const start = dayStart.getTime();
      const t = prev.getTime();
      if (t >= start && t < start + MS_PER_DAY) return prev;
      // Land on the event itself: that is the moment people actually want.
      return eventTime || new Date(start + 12 * 3600000);
    });
  }, [dayStart, eventTime]);

  const scrubMinutes = clamp(
    Math.round((mapTime.getTime() - dayStart.getTime()) / 60000), 0, 1439
  );

  // ---- Actions -----------------------------------------------------------

  const shiftDate = useCallback(
    (days) => {
      setDateError(null);
      setDateStr(toDateInput(shiftCivilDate(civilDate, days)));
    },
    [civilDate]
  );

  const handleDateChange = useCallback((value) => {
    setDateStr(value);
    setDateError(parseDateInput(value) ? null : 'Enter a real date as YYYY-MM-DD.');
  }, []);

  const dropPin = useCallback((lat, lon) => {
    setSelection({ kind: 'pin', lat: Number(lat.toFixed(4)), lon: Number(lon.toFixed(4)) });
    setLatInput('');
    setLonInput('');
    setCoordError(null);
  }, []);

  const selectSpot = useCallback((id) => {
    if (SPOTS_BY_ID[id]) setSelection({ kind: 'spot', id });
  }, []);

  /** Validate the typed coordinate boxes before moving the pin. */
  const applyTypedCoords = useCallback(() => {
    const lat = Number(latInput);
    const lon = Number(lonInput);
    if (latInput.trim() === '' || lonInput.trim() === '') {
      setCoordError('Enter both a latitude and a longitude.');
      return;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      setCoordError('Coordinates must be numbers, for example -33.87 and 151.21.');
      return;
    }
    if (lat < -90 || lat > 90) {
      setCoordError('Latitude has to sit between -90 and 90.');
      return;
    }
    if (lon < -180 || lon > 180) {
      setCoordError('Longitude has to sit between -180 and 180.');
      return;
    }
    if (!isInFrame(lat, lon)) {
      setCoordError('That point is off the map. Australia runs about -10 to -44 and 113 to 154.');
      return;
    }
    setCoordError(null);
    setSelection({ kind: 'pin', lat, lon });
  }, [latInput, lonInput]);

  const handleCopy = useCallback(async () => {
    if (!times || !eventTime) {
      setToast({ kind: 'bad', message: 'There is no sunrise or sunset here on this date, so there is nothing to copy.' });
      return;
    }
    const text = buildClipboardText({
      name: site.name,
      lat: site.lat,
      lon: site.lon,
      event: eventMode,
      times,
      timeZone,
      score,
      peakOffsetMinutes: peakOffset,
    });

    const result = await copyText(text);
    if (result.ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      setToast({ kind: 'good', message: `${site.name} ${eventMode} plan copied.` });
    } else {
      // Give people the text so they can copy it by hand rather than a dead end.
      setToast({ kind: 'bad', message: 'Your browser blocked the copy. Select the text below and copy it manually.', text });
    }
  }, [times, eventTime, site, eventMode, timeZone, score, peakOffset]);

  const saveCurrent = useCallback(() => {
    const entry = {
      key: `${site.lat.toFixed(4)},${site.lon.toFixed(4)}`,
      name: site.name,
      lat: site.lat,
      lon: site.lon,
      spotId: site.isCustom ? null : site.id,
    };
    setSaved((prev) => {
      if (prev.some((s) => s.key === entry.key)) return prev;
      return [entry, ...prev].slice(0, 30);
    });
    setToast({ kind: 'good', message: `${site.name} saved to this device.` });
  }, [site]);

  const removeSaved = useCallback((key) => {
    setSaved((prev) => prev.filter((s) => s.key !== key));
  }, []);

  // Toasts clear themselves, except the manual-copy one which needs to stay.
  useEffect(() => {
    if (!toast || toast.text) return undefined;
    const id = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(id);
  }, [toast]);

  const zone = zoneAbbreviation(eventTime || mapTime, timeZone);
  const alreadySaved = saved.some((s) => s.key === `${site.lat.toFixed(4)},${site.lon.toFixed(4)}`);
  const offMap = !isInFrame(site.lat, site.lon);

  // ---- Render ------------------------------------------------------------

  return (
    <div className="fll">
      <style>{STYLES}</style>

      <header className="fll-head">
        <div>
          <h1 className="fll-title">First &amp; Last Light</h1>
          <p className="fll-sub">
            Sunrise and sunset timing for anywhere in Australia, worked out on your device.
            Nothing is sent anywhere.
          </p>
        </div>

        <div className="fll-datebar">
          <button
            className="fll-btn fll-btn--icon"
            onClick={() => shiftDate(-1)}
            aria-label="Previous day"
          >
            <ChevronLeft size={16} />
          </button>
          <input
            className="fll-date"
            type="date"
            value={dateStr}
            onChange={(e) => handleDateChange(e.target.value)}
            aria-label="Date"
          />
          <button
            className="fll-btn fll-btn--icon"
            onClick={() => shiftDate(1)}
            aria-label="Next day"
          >
            <ChevronRight size={16} />
          </button>
          <div className="fll-seg" role="group" aria-label="Choose sunrise or sunset">
            <button
              type="button"
              aria-pressed={isRise}
              onClick={() => setEventMode('sunrise')}
            >
              <Sunrise size={15} /> Sunrise
            </button>
            <button
              type="button"
              aria-pressed={!isRise}
              onClick={() => setEventMode('sunset')}
            >
              <Sunset size={15} /> Sunset
            </button>
          </div>
        </div>
      </header>

      {dateError && (
        <div className="fll-notice" role="alert">
          <AlertTriangle size={15} />
          <span>{dateError} Showing today instead.</span>
        </div>
      )}

      {store.mode === 'memory' && (
        <div className="fll-notice">
          <Info size={15} />
          <span>
            This browser will not let the page store data, so saved spots last only until you
            close the tab. Private browsing and embedded previews both do this.
          </span>
        </div>
      )}

      <div className="fll-grid">
        {/* ---------------- Left column: map, transport, ribbon ------------- */}
        <div>
          <SunMap
            mapTime={mapTime}
            site={site}
            ranked={ranked}
            onPick={dropPin}
            onSelectSpot={selectSpot}
            eventMode={eventMode}
            eventAzimuth={eventAzimuth}
          />

          <div className="fll-transport">
            <button
              className="fll-btn fll-btn--icon"
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? 'Pause the day' : 'Play the day'}
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>

            <div>
              <div className="fll-clock">{formatInZone(mapTime, timeZone)}</div>
              <div className="fll-clocknote">
                map time at {site.name}, {zone}
              </div>
            </div>

            <div className="fll-range">
              <input
                type="range"
                min={0}
                max={1439}
                step={1}
                value={scrubMinutes}
                onChange={(e) =>
                  setMapTime(new Date(dayStart.getTime() + Number(e.target.value) * 60000))
                }
                aria-label="Time of day"
                aria-valuetext={formatInZone(mapTime, timeZone)}
              />
            </div>

            <button
              className="fll-btn"
              onClick={() => { setPlaying(false); if (eventTime) setMapTime(eventTime); }}
              disabled={!eventTime}
            >
              {isRise ? <Sunrise size={15} /> : <Sunset size={15} />}
              Jump to {eventMode}
            </button>

            <button
              className="fll-btn"
              onClick={() => {
                setPlaying(false);
                setDateStr(toDateInput(civilDateInZone(new Date(), timeZone)));
                setMapTime(new Date());
              }}
            >
              <Crosshair size={15} /> Now
            </button>
          </div>

          {times && times.regime === 'normal' && (
            <DayRibbon
              site={site}
              times={times}
              dayStart={dayStart}
              timeZone={timeZone}
              mapTime={mapTime}
              eventMode={eventMode}
              onScrub={(d) => { setPlaying(false); setMapTime(d); }}
            />
          )}

          {/* ---------------- Ranking ---------------- */}
          <div className="fll-panel" style={{ marginTop: 20 }}>
            <p className="fll-eyebrow">
              Ranked for {isRise ? 'sunrise' : 'sunset'} on {formatInZone(eventTime || mapTime, timeZone, {
                weekday: 'short', day: 'numeric', month: 'short',
                hour: undefined, minute: undefined, hour12: undefined,
              })}
            </p>
            <h2 className="fll-place" style={{ marginBottom: 14 }}>Where the light should be best</h2>

            <table className="fll-rank">
              <thead>
                <tr>
                  <th aria-label="Rank" />
                  <th>Place</th>
                  <th>{isRise ? 'Sunrise' : 'Sunset'}</th>
                  <th>Peak colour</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {ranked.slice(0, 10).map((row, i) => (
                  <tr
                    key={row.spot.id}
                    onClick={() => selectSpot(row.spot.id)}
                    aria-selected={selection.kind === 'spot' && selection.id === row.spot.id}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        selectSpot(row.spot.id);
                      }
                    }}
                  >
                    <td className="fll-rankpos">{i + 1}</td>
                    <td>
                      <span className="fll-rankname">{row.spot.name}</span>
                      <span className="fll-rankregion">{row.spot.region}</span>
                    </td>
                    <td className="fll-rankscore">
                      {formatInZone(row.eventTime, row.timeZone)}
                    </td>
                    <td className="fll-rankscore">
                      {formatInZone(
                        isRise ? row.times.peakColourSunrise : row.times.peakColourSunset,
                        row.timeZone
                      )}
                    </td>
                    <td className="fll-rankscore">{row.score.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="fll-note">
              Times are shown in each place&rsquo;s own zone. The score covers horizon
              alignment, twilight length, air clarity and height — not cloud, which no
              offline tool can know.
            </p>
          </div>
        </div>

        {/* ---------------- Right column: the readout ---------------------- */}
        <div>
          <div className="fll-panel">
            <p className="fll-eyebrow">{site.region}</p>
            <h2 className="fll-place">{site.name}</h2>
            <p className="fll-coords">
              {site.lat.toFixed(4)}, {site.lon.toFixed(4)} · {timeZone.split('/')[1]}
            </p>

            {offMap && (
              <div className="fll-notice" style={{ marginTop: 12, marginBottom: 0 }}>
                <AlertTriangle size={15} />
                <span>This pin sits outside the map frame. The maths still holds, but nothing will be drawn.</span>
              </div>
            )}

            {times && times.regime !== 'normal' ? (
              <div className="fll-hero">
                <p className="fll-herolabel">
                  {times.regime === 'polar-day' ? 'The sun never sets here today' : 'The sun never rises here today'}
                </p>
                <p className="fll-herohint">
                  Pick a point inside Australia, where every day has both a sunrise and a sunset.
                </p>
              </div>
            ) : (
              <>
                <div className="fll-hero">
                  <p className="fll-herolabel">Peak colour</p>
                  <p className="fll-herotime">
                    {formatInZone(peakTime, timeZone)}
                    <span className="fll-herozone">{zone}</span>
                  </p>
                  <p className="fll-herohint">
                    {peakOffset} minutes {isRise ? 'before sunrise' : 'after sunset'}, when the sky
                    is usually at its most saturated. Be set up ten minutes earlier.
                  </p>
                </div>

                <dl className="fll-rows">
                  <div className="fll-row">
                    <dt>{isRise ? 'Sunrise' : 'Sunset'}</dt>
                    <dd>{formatInZone(eventTime, timeZone)}</dd>
                  </div>
                  <div className="fll-row">
                    <dt>Golden hour</dt>
                    <dd>
                      {isRise
                        ? `${formatInZone(times.sunrise, timeZone)} – ${formatInZone(times.goldenMorningEnd, timeZone)}`
                        : `${formatInZone(times.goldenEveningStart, timeZone)} – ${formatInZone(times.sunset, timeZone)}`}
                    </dd>
                  </div>
                  <div className="fll-row">
                    <dt>Blue hour</dt>
                    <dd>
                      {isRise
                        ? `${formatInZone(times.civilDawn, timeZone)} – ${formatInZone(times.sunrise, timeZone)}`
                        : `${formatInZone(times.sunset, timeZone)} – ${formatInZone(times.civilDusk, timeZone)}`}
                    </dd>
                  </div>
                  <div className="fll-row">
                    <dt>Sun bearing</dt>
                    <dd>
                      {Number.isFinite(eventAzimuth)
                        ? `${Math.round(eventAzimuth)}° ${compassPoint(eventAzimuth)}`
                        : '—'}
                    </dd>
                  </div>
                  <div className="fll-row">
                    <dt>Colour window</dt>
                    <dd>
                      {formatDuration(
                        isRise ? times.civilTwilightMorningMinutes : times.civilTwilightEveningMinutes
                      )}
                    </dd>
                  </div>
                  <div className="fll-row">
                    <dt>Day length</dt>
                    <dd>{formatDuration(times.dayLengthMinutes)}</dd>
                  </div>
                </dl>

                <div style={{ marginTop: 16 }}>
                  <button
                    className={`fll-btn fll-btn--primary${copied ? ' fll-btn--done' : ''}`}
                    onClick={handleCopy}
                  >
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                    {copied ? 'Copied' : `Copy the ${eventMode} plan`}
                  </button>
                  <button
                    className="fll-btn"
                    style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                    onClick={saveCurrent}
                    disabled={alreadySaved}
                  >
                    <Star size={15} />
                    {alreadySaved ? 'Saved to this device' : 'Save this spot'}
                  </button>
                </div>
              </>
            )}

            {site.note && <p className="fll-note">{site.note}</p>}
          </div>

          {/* ---- Score ---- */}
          {score && times && times.regime === 'normal' && (
            <div className="fll-panel">
              <div className="fll-scorehead">
                <div>
                  <p className="fll-eyebrow">Light score</p>
                  <p className="fll-scorenum">
                    {score.total}
                    <span style={{ fontSize: 15, color: 'var(--faint)' }}> /100</span>
                  </p>
                </div>
                <span className="fll-scoregrade">{score.grade}</span>
              </div>

              <div className="fll-bars">
                {[
                  ['Alignment', score.parts.alignment, 40],
                  ['Twilight', score.parts.twilight, 25],
                  ['Clarity', score.parts.clarity, 20],
                  ['Vantage', score.parts.vantage, 15],
                ].map(([label, value, max]) => (
                  <div className="fll-bar" key={label}>
                    <span>{label}</span>
                    <span className="fll-bartrack">
                      <span className="fll-barfill" style={{ width: `${(value / max) * 100}%` }} />
                    </span>
                    <span>{value}</span>
                  </div>
                ))}
              </div>

              <p className="fll-note">{score.headline}</p>
            </div>
          )}

          {/* ---- Pin refinement ---- */}
          {site.isCustom && (
            <div className="fll-panel">
              <p className="fll-eyebrow">Refine this pin</p>
              <h3 className="fll-place" style={{ fontSize: 18 }}>What can you see from here?</h3>
              <p className="fll-note" style={{ marginTop: 6 }}>
                There is no terrain data on board, so the score uses your answers instead of guessing.
              </p>

              <label className="fll-field">
                Horizon
                <select value={pinHorizon} onChange={(e) => setPinHorizon(e.target.value)}>
                  {Object.entries(HORIZON_PRESETS).map(([key, preset]) => (
                    <option key={key} value={key}>{preset.label}</option>
                  ))}
                </select>
              </label>

              <label className="fll-field">
                Height above sea level (metres)
                <input
                  type="number"
                  min={0}
                  max={3000}
                  step={10}
                  value={pinElevation}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setPinElevation(Number.isFinite(v) ? clamp(v, 0, 3000) : 0);
                  }}
                />
              </label>
            </div>
          )}

          {/* ---- Typed coordinates ---- */}
          <div className="fll-panel">
            <p className="fll-eyebrow">Somewhere specific</p>
            <h3 className="fll-place" style={{ fontSize: 18 }}>Type a coordinate</h3>

            <div className="fll-fieldrow">
              <label className="fll-field">
                Latitude
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="-33.87"
                  value={latInput}
                  onChange={(e) => setLatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') applyTypedCoords(); }}
                />
              </label>
              <label className="fll-field">
                Longitude
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="151.21"
                  value={lonInput}
                  onChange={(e) => setLonInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') applyTypedCoords(); }}
                />
              </label>
            </div>

            {coordError && (
              <p className="fll-err" role="alert">
                <AlertTriangle size={14} /> {coordError}
              </p>
            )}

            <button
              className="fll-btn"
              style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
              onClick={applyTypedCoords}
            >
              <MapPin size={15} /> Move the pin here
            </button>
          </div>

          {/* ---- Peak offset ---- */}
          <div className="fll-panel">
            <p className="fll-eyebrow">Peak colour rule</p>
            <label className="fll-field" style={{ marginTop: 8 }}>
              Minutes either side of the event
              <input
                type="number"
                min={0}
                max={120}
                step={1}
                value={peakOffset}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setPeakOffset(Number.isFinite(v) ? clamp(Math.round(v), 0, 120) : DEFAULT_PEAK_OFFSET_MIN);
                }}
              />
            </label>
            <p className="fll-note">
              Twenty minutes is the usual rule of thumb. Push it out towards forty in Tasmania
              in midsummer, and pull it back towards twelve in the tropics, where twilight is
              far shorter.
            </p>
          </div>

          {/* ---- Saved ---- */}
          <div className="fll-panel">
            <p className="fll-eyebrow">On this device</p>
            <h3 className="fll-place" style={{ fontSize: 18, marginBottom: 6 }}>Saved spots</h3>

            {saved.length === 0 ? (
              <p className="fll-note">
                Nothing saved yet. Drop a pin anywhere on the map, or pick a place from the
                ranking, then use Save this spot.
              </p>
            ) : (
              <div>
                {saved.map((entry) => (
                  <div className="fll-saved" key={entry.key}>
                    <button
                      className="fll-savedmain"
                      onClick={() =>
                        entry.spotId && SPOTS_BY_ID[entry.spotId]
                          ? selectSpot(entry.spotId)
                          : setSelection({ kind: 'pin', lat: entry.lat, lon: entry.lon })
                      }
                    >
                      <span className="fll-savedname">{entry.name}</span>
                      <span className="fll-savedmeta">
                        {entry.lat.toFixed(3)}, {entry.lon.toFixed(3)}
                      </span>
                    </button>
                    <button
                      className="fll-iconbtn"
                      onClick={() => removeSaved(entry.key)}
                      aria-label={`Remove ${entry.name}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="fll-foot">
        <p>
          <Camera size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
          Positions use the NOAA solar algorithm, accurate to about a minute. Sunrise and
          sunset assume a sea-level horizon, so a mountain to your east will delay first
          light by more than this can predict.
        </p>
        <p>
          Cloud decides whether a sunset is spectacular, and this tool has no way to see it.
          Treat the score as a guide to the place, then check a forecast before you drive.
        </p>
      </footer>

      {toast && (
        <div className={`fll-toast fll-toast--${toast.kind === 'bad' ? 'bad' : 'good'}`} role="status">
          <div style={{ flex: 1 }}>
            {toast.message}
            {toast.text && (
              <textarea readOnly value={toast.text} onFocus={(e) => e.target.select()} />
            )}
          </div>
          <button className="fll-iconbtn" onClick={() => setToast(null)} aria-label="Dismiss">
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Public entry point. Takes no props, so it can be dropped anywhere.
 */
export default function FirstAndLastLight() {
  return (
    <ErrorBoundary>
      <FirstAndLastLightInner />
    </ErrorBoundary>
  );
}
