/**
 * solar.js — pure, dependency-free astronomy + planning maths.
 *
 * Everything in this file is a pure function: same inputs -> same outputs, no
 * DOM, no network, no clock reads. That is deliberate. It makes the whole
 * engine unit-testable (see solar.test.js) and safe to run inside a Web Worker
 * later if the grid rendering ever needs to move off the main thread.
 *
 * The position algorithm is NOAA's Solar Calculator (itself derived from
 * Meeus, "Astronomical Algorithms", 2nd ed.). Accuracy for the range of dates
 * and latitudes this app cares about (Australia, +/- a few decades) is around
 * one minute for rise/set, which is well inside the uncertainty introduced by
 * local terrain anyway.
 *
 * CONVENTIONS USED THROUGHOUT
 *   - Longitude is positive EAST. NOAA's own reference code uses positive west,
 *     so the sign flip is baked into `eventMinutesUTC` below. Do not "fix" it.
 *   - Latitude is positive north, so all Australian latitudes are negative.
 *   - Azimuth is compass bearing in degrees: 0 = north, 90 = east, 180 = south.
 *   - Elevation (altitude) is degrees above the horizon; negative = below.
 *   - All Date objects are real instants. Local time only ever appears at the
 *     formatting boundary, via Intl.DateTimeFormat with an IANA zone.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Degrees -> radians. */
export const RAD = Math.PI / 180;

/** Radians -> degrees. */
export const DEG = 180 / Math.PI;

/** Milliseconds in a day, used for Julian date conversion. */
const MS_PER_DAY = 86400000;

/** Julian date of the Unix epoch (1970-01-01T00:00:00Z). */
const UNIX_EPOCH_JD = 2440587.5;

/**
 * Zenith angles (degrees from straight up) that define the standard solar
 * events. 90.833 rather than 90 accounts for atmospheric refraction at the
 * horizon (~34') plus the sun's apparent radius (~16').
 */
export const ZENITH = {
  SUNRISE_SUNSET: 90.833,
  CIVIL: 96,
  NAUTICAL: 102,
  ASTRONOMICAL: 108,
  /** Upper edge of the golden window: sun 6 degrees above the horizon. */
  GOLDEN_UPPER: 84,
};

/**
 * Default number of minutes between the official sunrise/sunset time and the
 * moment the sky colour usually peaks. The brief specifies 20 minutes before
 * sunrise; the symmetric case is 20 minutes after sunset. Users can change
 * this in the app because the real figure drifts with latitude and season.
 */
export const DEFAULT_PEAK_OFFSET_MIN = 20;

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/** Constrain `v` to the inclusive range [lo, hi]. */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Normalise any angle in degrees into [0, 360). */
export function norm360(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Linear interpolation between a and b. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Guard against the single most common source of NaN in this file: a caller
 * passing a string, a null, or a Date that failed to parse.
 *
 * @param {number} v
 * @param {string} label - used in the thrown message so failures are traceable
 * @returns {number}
 */
function requireFinite(v, label) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) {
    throw new TypeError(`solar.js: ${label} must be a finite number, received ${JSON.stringify(v)}`);
  }
  return n;
}

/**
 * Validate a geographic coordinate pair.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {{lat: number, lon: number}}
 * @throws {RangeError} if either value is outside the valid range
 */
export function assertCoords(lat, lon) {
  const la = requireFinite(lat, 'latitude');
  const lo = requireFinite(lon, 'longitude');
  if (la < -90 || la > 90) throw new RangeError(`Latitude ${la} is outside -90..90`);
  if (lo < -180 || lo > 180) throw new RangeError(`Longitude ${lo} is outside -180..180`);
  return { lat: la, lon: lo };
}

// ---------------------------------------------------------------------------
// Julian date
// ---------------------------------------------------------------------------

/**
 * Convert a JavaScript Date (an instant) into a Julian Day number.
 * @param {Date} date
 * @returns {number}
 */
export function toJulianDay(date) {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(ms)) throw new TypeError('solar.js: toJulianDay needs a valid Date');
  return ms / MS_PER_DAY + UNIX_EPOCH_JD;
}

/** Inverse of {@link toJulianDay}. */
export function fromJulianDay(jd) {
  return new Date((jd - UNIX_EPOCH_JD) * MS_PER_DAY);
}

/**
 * Julian Day number for 00:00 UTC on the given calendar date.
 * Used as the anchor for a day's rise/set solve.
 *
 * @param {number} year - full year, e.g. 2026
 * @param {number} month - 1-12 (not the JS 0-11 convention; this is a public API)
 * @param {number} day - 1-31
 */
export function julianDayForUTCDate(year, month, day) {
  return toJulianDay(new Date(Date.UTC(year, month - 1, day)));
}

/** Julian centuries since J2000.0. The independent variable for everything below. */
export function julianCentury(jd) {
  return (jd - 2451545) / 36525;
}

// ---------------------------------------------------------------------------
// Solar orbital elements (NOAA / Meeus)
// ---------------------------------------------------------------------------

/** Geometric mean longitude of the sun, degrees, normalised to [0,360). */
export function geomMeanLongSun(t) {
  return norm360(280.46646 + t * (36000.76983 + t * 0.0003032));
}

/** Geometric mean anomaly of the sun, degrees. */
export function geomMeanAnomalySun(t) {
  return 357.52911 + t * (35999.05029 - 0.0001537 * t);
}

/** Eccentricity of Earth's orbit (dimensionless). */
export function earthOrbitEccentricity(t) {
  return 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
}

/** Sun's equation of centre, degrees. */
export function sunEqOfCentre(t) {
  const m = geomMeanAnomalySun(t) * RAD;
  return (
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289
  );
}

/** Sun's apparent longitude, degrees (true longitude corrected for nutation/aberration). */
export function sunApparentLong(t) {
  const trueLong = geomMeanLongSun(t) + sunEqOfCentre(t);
  return trueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * RAD);
}

/** Obliquity of the ecliptic corrected for nutation, degrees. */
export function obliquityCorrection(t) {
  const seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
  const meanObliquity = 23 + (26 + seconds / 60) / 60;
  return meanObliquity + 0.00256 * Math.cos((125.04 - 1934.136 * t) * RAD);
}

/** Solar declination, degrees. Ranges roughly -23.44 .. +23.44 over a year. */
export function sunDeclination(t) {
  const e = obliquityCorrection(t) * RAD;
  const lambda = sunApparentLong(t) * RAD;
  return Math.asin(Math.sin(e) * Math.sin(lambda)) * DEG;
}

/**
 * Equation of time, in minutes. This is the difference between apparent solar
 * time and mean solar time, and it is why solar noon wanders by up to a
 * quarter of an hour across the year.
 */
export function equationOfTime(t) {
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

  return eTime * DEG * 4; // radians -> degrees -> minutes of time
}

/**
 * Hour angle, in degrees, at which the sun reaches a given zenith angle.
 *
 * Returns null when the sun never reaches that zenith on this date at this
 * latitude — polar day or polar night. Callers must handle null; inside
 * Australia it only happens for the astronomical-twilight thresholds in
 * far-southern Tasmania around midsummer, but the app also lets people paste
 * arbitrary coordinates.
 *
 * @param {number} latDeg
 * @param {number} declDeg
 * @param {number} zenithDeg
 * @returns {number|null}
 */
export function hourAngle(latDeg, declDeg, zenithDeg) {
  const lat = latDeg * RAD;
  const decl = declDeg * RAD;
  const z = zenithDeg * RAD;

  const cosH =
    (Math.cos(z) - Math.sin(lat) * Math.sin(decl)) / (Math.cos(lat) * Math.cos(decl));

  if (cosH > 1 || cosH < -1 || !Number.isFinite(cosH)) return null;
  return Math.acos(cosH) * DEG;
}

/**
 * Atmospheric refraction correction in degrees, to be added to the geometric
 * elevation. Near the horizon this is worth over half a degree, which is the
 * difference between "the sun is setting" and "the sun has set".
 */
export function refractionCorrection(elevationDeg) {
  if (elevationDeg > 85) return 0;
  const te = Math.tan(elevationDeg * RAD);
  let corrArcSec;
  if (elevationDeg > 5) {
    corrArcSec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  } else if (elevationDeg > -0.575) {
    corrArcSec =
      1735 +
      elevationDeg *
        (-518.2 + elevationDeg * (103.4 + elevationDeg * (-12.79 + elevationDeg * 0.711)));
  } else {
    corrArcSec = -20.772 / te;
  }
  return corrArcSec / 3600;
}

// ---------------------------------------------------------------------------
// Solar position
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SolarPosition
 * @property {number} elevation - apparent (refracted) altitude in degrees
 * @property {number} geometricElevation - unrefracted altitude in degrees
 * @property {number} azimuth - compass bearing 0-360, 0 = north
 * @property {number} declination - solar declination in degrees
 * @property {number} hourAngle - local hour angle in degrees, negative = morning
 */

/**
 * Where is the sun, as seen from (lat, lon), at this instant?
 *
 * @param {Date} date
 * @param {number} lat
 * @param {number} lon - positive east
 * @returns {SolarPosition}
 */
export function solarPosition(date, lat, lon) {
  assertCoords(lat, lon);

  const jd = toJulianDay(date);
  const t = julianCentury(jd);
  const decl = sunDeclination(t);
  const eqTime = equationOfTime(t);

  // Minutes elapsed since 00:00 UTC. (jd + 0.5) % 1 gives the fraction of the
  // UTC day, because Julian days start at noon.
  const utcMinutes = (((jd + 0.5) % 1) + 1) % 1 * 1440;

  // True solar time: mean time, shifted by the equation of time and by how far
  // east of Greenwich we are (4 minutes per degree).
  const trueSolarTime = ((utcMinutes + eqTime + 4 * lon) % 1440 + 1440) % 1440;

  let ha = trueSolarTime / 4 - 180;
  if (ha < -180) ha += 360;

  const latR = lat * RAD;
  const declR = decl * RAD;
  const haR = ha * RAD;

  const cosZenith = clamp(
    Math.sin(latR) * Math.sin(declR) + Math.cos(latR) * Math.cos(declR) * Math.cos(haR),
    -1,
    1
  );
  const zenith = Math.acos(cosZenith) * DEG;
  const geometricElevation = 90 - zenith;

  // Azimuth, NOAA formulation. The denominator collapses at the poles, hence
  // the guard.
  let azimuth;
  const azDenom = Math.cos(latR) * Math.sin(zenith * RAD);
  if (Math.abs(azDenom) > 0.001) {
    const azRad = clamp((Math.sin(latR) * cosZenith - Math.sin(declR)) / azDenom, -1, 1);
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

// ---------------------------------------------------------------------------
// Rise / set solving
// ---------------------------------------------------------------------------

/**
 * Minutes after 00:00 UTC at which the sun crosses `zenith`, on the UTC day
 * anchored by `jd`. The result may be negative or exceed 1440 — that simply
 * means the event falls on the neighbouring UTC day, which is normal for
 * Australia where local time runs 8 to 11 hours ahead of UTC.
 *
 * Two passes: the first estimates the time, the second re-evaluates the sun's
 * declination and equation of time at that estimate. A third pass changes the
 * answer by well under a second.
 *
 * @returns {number|null} null when the sun never reaches that zenith
 */
function eventMinutesUTC(jd, lat, lon, zenith, isRise) {
  let minutes = null;

  for (let pass = 0; pass < 2; pass++) {
    const t = julianCentury(pass === 0 ? jd : jd + minutes / 1440);
    const decl = sunDeclination(t);
    const eqTime = equationOfTime(t);
    const ha = hourAngle(lat, decl, zenith);
    if (ha === null) return null;

    // NOAA works in positive-west longitude; we store positive-east, so the
    // longitude term is subtracted rather than added.
    const signedHa = isRise ? ha : -ha;
    minutes = 720 - 4 * (lon + signedHa) - eqTime;
  }

  return minutes;
}

/**
 * Solve for one solar event as a real Date.
 *
 * @param {{year:number, month:number, day:number}} civilDate - the calendar day,
 *   interpreted as the local Australian day (see the note in the README about
 *   why anchoring on the UTC date is correct for eastern longitudes).
 * @param {number} lat
 * @param {number} lon
 * @param {number} zenith - one of the ZENITH constants
 * @param {boolean} isRise - true for the morning crossing
 * @returns {Date|null}
 */
export function solveEvent(civilDate, lat, lon, zenith, isRise) {
  assertCoords(lat, lon);
  const jd = julianDayForUTCDate(civilDate.year, civilDate.month, civilDate.day);
  const minutes = eventMinutesUTC(jd, lat, lon, zenith, isRise);
  if (minutes === null) return null;
  return fromJulianDay(jd + minutes / 1440);
}

/**
 * @typedef {Object} DayTimes
 * @property {Date|null} sunrise
 * @property {Date|null} sunset
 * @property {Date} solarNoon
 * @property {Date|null} civilDawn        - sun reaches -6 degrees, morning
 * @property {Date|null} civilDusk        - sun reaches -6 degrees, evening
 * @property {Date|null} nauticalDawn
 * @property {Date|null} nauticalDusk
 * @property {Date|null} astronomicalDawn
 * @property {Date|null} astronomicalDusk
 * @property {Date|null} goldenMorningEnd - sun reaches +6 degrees, morning
 * @property {Date|null} goldenEveningStart
 * @property {Date|null} peakColourSunrise
 * @property {Date|null} peakColourSunset
 * @property {number|null} dayLengthMinutes
 * @property {number|null} civilTwilightMorningMinutes
 * @property {number|null} civilTwilightEveningMinutes
 * @property {'normal'|'polar-day'|'polar-night'} regime
 */

/**
 * Everything the UI needs about one day at one place.
 *
 * @param {{year:number, month:number, day:number}} civilDate
 * @param {number} lat
 * @param {number} lon
 * @param {{peakOffsetMinutes?: number}} [options]
 * @returns {DayTimes}
 */
export function dayTimes(civilDate, lat, lon, options = {}) {
  assertCoords(lat, lon);
  const peakOffset = Number.isFinite(options.peakOffsetMinutes)
    ? options.peakOffsetMinutes
    : DEFAULT_PEAK_OFFSET_MIN;

  const jd = julianDayForUTCDate(civilDate.year, civilDate.month, civilDate.day);
  const at = (zenith, isRise) => solveEvent(civilDate, lat, lon, zenith, isRise);

  const sunrise = at(ZENITH.SUNRISE_SUNSET, true);
  const sunset = at(ZENITH.SUNRISE_SUNSET, false);

  // Solar noon needs no iteration on the hour angle; it is purely longitude
  // and the equation of time.
  const noonEq = equationOfTime(julianCentury(jd + 0.5));
  const solarNoon = fromJulianDay(jd + (720 - 4 * lon - noonEq) / 1440);

  const civilDawn = at(ZENITH.CIVIL, true);
  const civilDusk = at(ZENITH.CIVIL, false);

  const minutesBetween = (a, b) =>
    a && b ? Math.round((b.getTime() - a.getTime()) / 60000) : null;

  // Determine the regime so the UI can say something useful instead of
  // rendering blank fields.
  let regime = 'normal';
  if (!sunrise || !sunset) {
    const noonPos = solarPosition(solarNoon, lat, lon);
    regime = noonPos.elevation > 0 ? 'polar-day' : 'polar-night';
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

    // The brief's rule: colour peaks `peakOffset` minutes before sunrise, and
    // by symmetry the same interval after sunset.
    peakColourSunrise: sunrise ? new Date(sunrise.getTime() - offsetMs) : null,
    peakColourSunset: sunset ? new Date(sunset.getTime() + offsetMs) : null,

    dayLengthMinutes: minutesBetween(sunrise, sunset),
    civilTwilightMorningMinutes: minutesBetween(civilDawn, sunrise),
    civilTwilightEveningMinutes: minutesBetween(sunset, civilDusk),
    regime,
  };
}

// ---------------------------------------------------------------------------
// Timezones
// ---------------------------------------------------------------------------

/**
 * Australian timezone boundaries, evaluated in order. This is a deliberate
 * simplification: a full shapefile lookup would be tens of thousands of
 * vertices, and the app is explicitly offline-only. Known approximations are
 * listed in the README (Broken Hill, Eucla, the Eyre Highway roadhouses).
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {string} an IANA timezone identifier
 */
export function timezoneForPoint(lat, lon) {
  assertCoords(lat, lon);

  // Tasmania and the Bass Strait islands.
  if (lat < -39.2 && lon > 143.5 && lon < 149.5) return 'Australia/Hobart';

  // Western Australia: everything west of the WA/NT/SA border meridian.
  if (lon < 129) return 'Australia/Perth';

  // Northern Territory sits above the 26th parallel; South Australia below it.
  if (lon < 141) return lat > -26 ? 'Australia/Darwin' : 'Australia/Adelaide';

  // East of the 141st meridian: Queensland above the 29th parallel, then the
  // south-eastern states.
  if (lat > -29) return 'Australia/Brisbane';
  return 'Australia/Sydney';
}

/**
 * Format an instant in a given IANA zone, with a graceful fallback for
 * environments where the zone is unknown to Intl.
 *
 * @param {Date|null} date
 * @param {string} timeZone
 * @param {Intl.DateTimeFormatOptions} [opts]
 * @returns {string} '--:--' when the date is null
 */
export function formatInZone(date, timeZone, opts = {}) {
  if (!date) return '--:--';
  const base = { hour: '2-digit', minute: '2-digit', hour12: false };
  try {
    return new Intl.DateTimeFormat('en-AU', { ...base, ...opts, timeZone }).format(date);
  } catch {
    // Very old Safari, or a zone the runtime does not carry. Fall back to UTC
    // rather than throwing and taking the panel down with us.
    try {
      return new Intl.DateTimeFormat('en-AU', { ...base, ...opts, timeZone: 'UTC' }).format(date) + ' UTC';
    } catch {
      return date.toISOString().slice(11, 16) + ' UTC';
    }
  }
}

/**
 * Short zone label, e.g. 'AEST', 'ACDT', 'AWST'. Falls back to a UTC offset
 * string if the runtime cannot produce a name.
 */
export function zoneAbbreviation(date, timeZone) {
  if (!date) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-AU', {
      timeZone,
      timeZoneName: 'short',
    }).formatToParts(date);
    const name = parts.find((p) => p.type === 'timeZoneName');
    if (name && name.value) return name.value;
  } catch {
    /* fall through */
  }
  return 'UTC';
}

/**
 * The calendar date, in a given zone, for an instant. Needed because "today"
 * in Perth and "today" in Sydney are not always the same day.
 *
 * @returns {{year:number, month:number, day:number}}
 */
export function civilDateInZone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return { year: get('year'), month: get('month'), day: get('day') };
  } catch {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
  }
}

// ---------------------------------------------------------------------------
// Horizon geometry
// ---------------------------------------------------------------------------

/**
 * Angular distance in degrees from a bearing to the nearest edge of a
 * clockwise arc. Returns 0 when the bearing falls inside the arc.
 *
 * Arcs are written as [startBearing, endBearing] going clockwise, and may wrap
 * through north: [340, 20] is a 40-degree arc centred on due north.
 *
 * @param {number} bearing
 * @param {[number, number]} arc
 * @returns {number}
 */
export function bearingDistanceToArc(bearing, arc) {
  const start = norm360(arc[0]);
  const span = norm360(arc[1] - arc[0]);
  const rel = norm360(bearing - start);
  if (rel <= span) return 0;
  // Outside: it is either just past the end, or just before the start.
  return Math.min(rel - span, 360 - rel);
}

/** Great-circle distance in kilometres between two points. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------------------------------------------------------------------------
// Light scoring
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ScoreInput
 * @property {number} azimuth - solar bearing at the event
 * @property {Array<[number,number]>} openArcs - unobstructed horizon arcs
 * @property {number|null} twilightMinutes - civil twilight duration for this event
 * @property {number} elevationM - height above sea level, metres
 * @property {number} clarity - 0..1 static air-clarity index for the site
 * @property {boolean} waterHorizon - true when the horizon is sea or a large lake
 */

/**
 * @typedef {Object} ScoreResult
 * @property {number} total - 0..100
 * @property {string} grade
 * @property {{alignment:number, twilight:number, vantage:number, clarity:number}} parts
 * @property {string} headline - one-line explanation of the dominant factor
 */

/**
 * Rate how promising an event is at a site, on astronomy and terrain alone.
 *
 * IMPORTANT AND DELIBERATE LIMITATION: cloud is the single largest driver of
 * whether a sunset is spectacular, and this app has no network access by
 * design, so cloud is not in the model. Read the score as "how good is this
 * place, geometrically, for this event on this date" — not as a forecast.
 *
 * Weighting: alignment 40, twilight duration 25, clarity 20, vantage 15.
 *
 * @param {ScoreInput} input
 * @returns {ScoreResult}
 */
export function scoreEvent(input) {
  const {
    azimuth,
    openArcs = [],
    twilightMinutes,
    elevationM = 0,
    clarity = 0.6,
    waterHorizon = false,
  } = input;

  // 1. Alignment (0-40). Does the sun actually rise or set into the part of
  // the sky you can see? Falls off linearly over 45 degrees of miss.
  let miss = 45;
  for (const arc of openArcs) {
    miss = Math.min(miss, bearingDistanceToArc(azimuth, arc));
  }
  const alignment = 40 * (1 - clamp(miss, 0, 45) / 45);

  // 2. Twilight duration (0-25). Longer civil twilight means the colour holds
  // for longer, which is why high-latitude sunsets feel more generous.
  // 20 minutes is about the tropical minimum, 45 the southern-Tasmanian summer.
  const dur = Number.isFinite(twilightMinutes) ? twilightMinutes : 25;
  const twilight = 25 * clamp((dur - 20) / 25, 0, 1);

  // 3. Vantage (0-15). Height buys you a lower horizon and a longer event;
  // a water horizon buys you a clean, unbroken line and reflections.
  const vantage = 10 * clamp(elevationM / 800, 0, 1) + (waterHorizon ? 5 : 0);

  // 4. Clarity (0-20). Static proxy for haze, dust and light pollution.
  const clarityScore = 20 * clamp(clarity, 0, 1);

  const total = Math.round(alignment + twilight + vantage + clarityScore);

  const grade =
    total >= 85 ? 'exceptional' :
    total >= 70 ? 'strong' :
    total >= 55 ? 'good' :
    total >= 40 ? 'fair' : 'poor';

  // Explain the result by naming the weakest link, or the strongest asset.
  let headline;
  if (alignment < 20) {
    headline = 'The sun is well off the open part of the horizon here.';
  } else if (clarityScore < 10) {
    headline = 'Good geometry, but hazier air than the inland sites.';
  } else if (twilight > 18 && alignment > 32) {
    headline = 'Sun lands in the open, and the colour holds for a long window.';
  } else if (waterHorizon && alignment > 30) {
    headline = 'Clean water horizon with the sun in the right place.';
  } else if (vantage >= 10) {
    headline = 'Height gives you a low horizon and a longer event.';
  } else {
    headline = 'Workable geometry without anything outstanding.';
  }

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

/**
 * Estimate an air-clarity index for a dropped pin from its distance to the
 * nearest capital, as a stand-in for haze and light pollution. Crude, but
 * better than assuming every pin is a pristine desert site.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {Array<{lat:number, lon:number}>} cities
 * @returns {number} 0.45 .. 0.95
 */
export function estimateClarity(lat, lon, cities) {
  if (!cities || cities.length === 0) return 0.7;
  let nearest = Infinity;
  for (const c of cities) {
    nearest = Math.min(nearest, haversineKm(lat, lon, c.lat, c.lon));
  }
  return clamp(0.45 + (nearest / 600) * 0.5, 0.45, 0.95);
}

// ---------------------------------------------------------------------------
// Twilight colour ramp
// ---------------------------------------------------------------------------

/**
 * Colour stops keyed by solar elevation, used to paint the terminator on the
 * map and the day ribbon. Ordered from high sun to deep night.
 * Each entry is [elevationDegrees, r, g, b, alpha].
 */
export const TWILIGHT_STOPS = [
  [ 10, 255, 255, 255, 0.00],
  [  6, 255, 214, 140, 0.20],
  [  2, 255, 168,  86, 0.38],
  [-0.833, 244, 118,  76, 0.50],
  [ -4, 186,  86, 122, 0.58],
  [ -6, 118,  78, 152, 0.64],
  [-12,  38,  46, 112, 0.76],
  [-18,  12,  16,  48, 0.86],
  [-90,   5,   7,  22, 0.90],
];

/**
 * Interpolate the twilight ramp at a given solar elevation.
 * @param {number} elevation - degrees
 * @returns {{r:number, g:number, b:number, a:number}}
 */
export function twilightColour(elevation) {
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

// ---------------------------------------------------------------------------
// Clipboard payload
// ---------------------------------------------------------------------------

/**
 * Build the plain-text block that the copy button puts on the clipboard.
 * Kept here, away from the DOM, so its exact shape can be asserted in tests.
 *
 * @param {Object} args
 * @param {string} args.name
 * @param {number} args.lat
 * @param {number} args.lon
 * @param {'sunrise'|'sunset'} args.event
 * @param {DayTimes} args.times
 * @param {string} args.timeZone
 * @param {ScoreResult|null} args.score
 * @param {number} args.peakOffsetMinutes
 * @returns {string}
 */
export function buildClipboardText({
  name,
  lat,
  lon,
  event,
  times,
  timeZone,
  score,
  peakOffsetMinutes,
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

  const coords = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  const peakWord = isRise ? 'before sunrise' : 'after sunset';

  const lines = [
    `${name} — ${event} plan`,
    dateLine,
    `Coordinates: ${coords}`,
    '',
    `${isRise ? 'Sunrise' : 'Sunset'}: ${t(main)} ${zone}`,
    `Peak colour: ${t(peak)} ${zone}  (${peakOffsetMinutes} min ${peakWord})`,
    `Golden hour: ${t(goldenA)} – ${t(goldenB)}`,
    `Blue hour: ${t(blueA)} – ${t(blueB)}`,
  ];

  if (score) {
    lines.push(`Light score: ${score.total}/100 (${score.grade})`);
  }

  lines.push('', `Map: https://www.google.com/maps?q=${lat.toFixed(5)},${lon.toFixed(5)}`);
  lines.push('Times are astronomical only — check cloud cover before you commit.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Local-day anchoring
// ---------------------------------------------------------------------------

/**
 * How many minutes local time in `timeZone` is ahead of UTC at this instant.
 * Positive everywhere in Australia. Handles daylight saving because it asks
 * Intl what the wall clock actually reads, rather than assuming a fixed offset.
 *
 * @param {Date} date
 * @param {string} timeZone
 * @returns {number}
 */
export function zoneOffsetMinutes(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date);
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    const asIfUTC = Date.UTC(
      get('year'), get('month') - 1, get('day'),
      get('hour'), get('minute'), get('second')
    );
    return Math.round((asIfUTC - date.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/**
 * The instant of 00:00 local time on a given calendar date in a given zone.
 *
 * Used as the origin for the day ribbon and the time scrubber, so that both
 * run local-midnight to local-midnight rather than across a UTC day boundary
 * that would cut awkwardly through the middle of an Australian afternoon.
 *
 * @param {{year:number, month:number, day:number}} civilDate
 * @param {string} timeZone
 * @returns {Date}
 */
export function localMidnight(civilDate, timeZone) {
  const naive = Date.UTC(civilDate.year, civilDate.month - 1, civilDate.day, 0, 0, 0);
  const firstGuess = zoneOffsetMinutes(new Date(naive), timeZone);
  let ms = naive - firstGuess * 60000;
  // One refinement pass catches the two days a year when the offset used for
  // the guess differs from the offset actually in force at local midnight.
  const refined = zoneOffsetMinutes(new Date(ms), timeZone);
  if (refined !== firstGuess) ms = naive - refined * 60000;
  return new Date(ms);
}
