/**
 * solar.test.js — unit tests for the astronomy and planning engine.
 *
 * Runs on the Node built-in test runner, no dependencies:
 *     node --test src/lib/
 *
 * The same file runs unchanged under Vitest if you prefer a watcher:
 *     npx vitest run
 * (Vitest provides `describe`/`it`; swap the import line for
 *  `import { describe, it } from 'vitest'` and `assert` still works.)
 *
 * Reference times are published values from Geoscience Australia and the NOAA
 * Solar Calculator. Tolerances are stated per assertion: rise/set is allowed a
 * few minutes because published tables assume a sea-level horizon and we do
 * not model terrain.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PEAK_OFFSET_MIN,
  ZENITH,
  bearingDistanceToArc,
  buildClipboardText,
  civilDateInZone,
  clamp,
  dayTimes,
  equationOfTime,
  estimateClarity,
  formatInZone,
  haversineKm,
  hourAngle,
  julianCentury,
  julianDayForUTCDate,
  localMidnight,
  norm360,
  refractionCorrection,
  scoreEvent,
  solarPosition,
  solveEvent,
  sunDeclination,
  timezoneForPoint,
  toJulianDay,
  twilightColour,
  zoneOffsetMinutes,
} from './solar.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Assert two numbers agree within `tol`. */
function near(actual, expected, tol, label) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label}: expected ${expected} +/- ${tol}, got ${actual}`
  );
}

/**
 * Assert two bearings agree within `tol`, accounting for the wrap at 360.
 * Without this, an azimuth of 359.98 "fails" a comparison against 0.
 */
function nearAngle(actual, expected, tol, label) {
  const diff = Math.abs(((actual - expected + 540) % 360) - 180);
  assert.ok(diff <= tol, `${label}: expected ${expected} +/- ${tol}, got ${actual}`);
}

/** Minutes between two Dates. */
function minutesApart(a, b) {
  return Math.abs(a.getTime() - b.getTime()) / 60000;
}

/** Build a Date from a local wall time in a zone, for comparison purposes. */
function utc(y, m, d, hh = 0, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm));
}

// ---------------------------------------------------------------------------

describe('numeric helpers', () => {
  it('clamps to the given range', () => {
    assert.equal(clamp(5, 0, 3), 3);
    assert.equal(clamp(-5, 0, 3), 0);
    assert.equal(clamp(1.5, 0, 3), 1.5);
  });

  it('normalises angles into [0, 360)', () => {
    assert.equal(norm360(370), 10);
    assert.equal(norm360(-10), 350);
    assert.equal(norm360(0), 0);
    assert.equal(norm360(720), 0);
  });
});

describe('julian dates', () => {
  it('maps the J2000.0 epoch to 2451545', () => {
    // J2000.0 is 2000-01-01 12:00 TT, close enough to UTC noon for this test.
    near(toJulianDay(utc(2000, 1, 1, 12, 0)), 2451545, 0.001, 'J2000');
  });

  it('gives zero julian centuries at J2000.0', () => {
    near(julianCentury(2451545), 0, 1e-9, 'T');
  });

  it('advances one unit per day', () => {
    const a = julianDayForUTCDate(2026, 3, 1);
    const b = julianDayForUTCDate(2026, 3, 2);
    near(b - a, 1, 1e-9, 'one day');
  });
});

describe('solar orbital elements', () => {
  it('puts the June solstice declination near +23.44 degrees', () => {
    const t = julianCentury(toJulianDay(utc(2024, 6, 21, 0, 0)));
    near(sunDeclination(t), 23.44, 0.05, 'June declination');
  });

  it('puts the December solstice declination near -23.44 degrees', () => {
    const t = julianCentury(toJulianDay(utc(2024, 12, 21, 12, 0)));
    near(sunDeclination(t), -23.44, 0.05, 'December declination');
  });

  it('crosses zero declination at the equinoxes', () => {
    const t = julianCentury(toJulianDay(utc(2024, 3, 20, 3, 6)));
    near(sunDeclination(t), 0, 0.05, 'March equinox declination');
  });

  it('peaks the equation of time near +16.4 minutes in early November', () => {
    const t = julianCentury(toJulianDay(utc(2024, 11, 3, 0, 0)));
    near(equationOfTime(t), 16.4, 0.4, 'EoT November peak');
  });

  it('troughs the equation of time near -14.2 minutes in mid February', () => {
    const t = julianCentury(toJulianDay(utc(2024, 2, 11, 0, 0)));
    near(equationOfTime(t), -14.2, 0.4, 'EoT February trough');
  });
});

describe('hour angle', () => {
  it('returns null when the sun never reaches the zenith angle', () => {
    // Deep Antarctic midsummer: the sun never gets down to the horizon.
    const t = julianCentury(toJulianDay(utc(2024, 12, 21, 0, 0)));
    assert.equal(hourAngle(-85, sunDeclination(t), ZENITH.SUNRISE_SUNSET), null);
  });

  it('gives a ~9.9 hour day at Sydney on the June solstice', () => {
    const t = julianCentury(toJulianDay(utc(2024, 6, 21, 0, 0)));
    const ha = hourAngle(-33.8688, sunDeclination(t), ZENITH.SUNRISE_SUNSET);
    const dayLengthHours = (2 * ha) / 15;
    near(dayLengthHours, 9.9, 0.1, 'Sydney June day length');
  });

  it('gives a ~14.2 hour day at Perth on the December solstice', () => {
    const t = julianCentury(toJulianDay(utc(2024, 12, 21, 12, 0)));
    const ha = hourAngle(-31.9523, sunDeclination(t), ZENITH.SUNRISE_SUNSET);
    near((2 * ha) / 15, 14.24, 0.1, 'Perth December day length');
  });
});

describe('refraction', () => {
  it('lifts a horizon sun by roughly half a degree', () => {
    near(refractionCorrection(0), 0.48, 0.06, 'horizon refraction');
  });

  it('is negligible near the zenith', () => {
    assert.ok(refractionCorrection(88) === 0);
  });
});

describe('solveEvent — published rise and set times', () => {
  // Sydney, June solstice. Published: sunrise 07:00, sunset 16:54 AEST (UTC+10).
  it('matches Sydney sunrise on 2024-06-21', () => {
    const d = solveEvent({ year: 2024, month: 6, day: 21 }, -33.8688, 151.2093, ZENITH.SUNRISE_SUNSET, true);
    // 07:00 AEST == 21:00 UTC on the previous day.
    near(minutesApart(d, utc(2024, 6, 20, 21, 0)), 0, 3, 'Sydney sunrise');
  });

  it('matches Sydney sunset on 2024-06-21', () => {
    const d = solveEvent({ year: 2024, month: 6, day: 21 }, -33.8688, 151.2093, ZENITH.SUNRISE_SUNSET, false);
    // 16:54 AEST == 06:54 UTC same day.
    near(minutesApart(d, utc(2024, 6, 21, 6, 54)), 0, 3, 'Sydney sunset');
  });

  // Perth, December solstice. Published: sunrise 05:07, sunset 19:22 AWST (UTC+8).
  it('matches Perth sunrise on 2024-12-21', () => {
    const d = solveEvent({ year: 2024, month: 12, day: 21 }, -31.9523, 115.8613, ZENITH.SUNRISE_SUNSET, true);
    near(minutesApart(d, utc(2024, 12, 20, 21, 7)), 0, 4, 'Perth sunrise');
  });

  it('matches Perth sunset on 2024-12-21', () => {
    const d = solveEvent({ year: 2024, month: 12, day: 21 }, -31.9523, 115.8613, ZENITH.SUNRISE_SUNSET, false);
    near(minutesApart(d, utc(2024, 12, 21, 11, 22)), 0, 4, 'Perth sunset');
  });

  it('orders the twilight events correctly at Hobart', () => {
    const date = { year: 2026, month: 4, day: 12 };
    const [astro, naut, civil, rise] = [
      ZENITH.ASTRONOMICAL, ZENITH.NAUTICAL, ZENITH.CIVIL, ZENITH.SUNRISE_SUNSET,
    ].map((z) => solveEvent(date, -42.8821, 147.3272, z, true));

    assert.ok(astro < naut, 'astronomical dawn precedes nautical dawn');
    assert.ok(naut < civil, 'nautical dawn precedes civil dawn');
    assert.ok(civil < rise, 'civil dawn precedes sunrise');
  });

  it('rejects impossible coordinates', () => {
    assert.throws(
      () => solveEvent({ year: 2026, month: 1, day: 1 }, 95, 150, ZENITH.SUNRISE_SUNSET, true),
      RangeError
    );
    assert.throws(
      () => solveEvent({ year: 2026, month: 1, day: 1 }, -30, 'east', ZENITH.SUNRISE_SUNSET, true),
      TypeError
    );
  });
});

describe('solarPosition', () => {
  it('puts the sun near due north at Sydney solar noon in winter', () => {
    const times = dayTimes({ year: 2024, month: 6, day: 21 }, -33.8688, 151.2093);
    const pos = solarPosition(times.solarNoon, -33.8688, 151.2093);
    nearAngle(pos.azimuth, 0, 1.5, 'noon azimuth (north, southern hemisphere)');
    near(pos.elevation, 32.7, 0.6, 'noon elevation');
  });

  it('places the sun below the horizon at local midnight', () => {
    const pos = solarPosition(utc(2026, 1, 15, 14, 0), -33.8688, 151.2093); // 01:00 AEDT
    assert.ok(pos.elevation < 0, `expected night, got elevation ${pos.elevation}`);
  });

  it('sits exactly on the sunset zenith at the solved sunset time', () => {
    // The 90.833 degree zenith already bakes in refraction and the sun's
    // semi-diameter, so the *geometric* centre must land on -0.833 exactly.
    // This is the round-trip check between solveEvent and solarPosition.
    const t = dayTimes({ year: 2026, month: 9, day: 1 }, -25.3444, 131.0369);
    const pos = solarPosition(t.sunset, -25.3444, 131.0369);
    near(pos.geometricElevation, -0.833, 0.01, 'geometric elevation at sunset');
    assert.ok(pos.elevation < 0, 'apparent centre is below the horizon at sunset');
  });

  it('has the sun rising in the east and setting in the west', () => {
    const t = dayTimes({ year: 2026, month: 9, day: 23 }, -25.3444, 131.0369);
    const rise = solarPosition(t.sunrise, -25.3444, 131.0369);
    const set = solarPosition(t.sunset, -25.3444, 131.0369);
    nearAngle(rise.azimuth, 90, 3, 'equinox sunrise azimuth');
    nearAngle(set.azimuth, 270, 3, 'equinox sunset azimuth');
  });
});

describe('dayTimes', () => {
  it('derives peak colour from the configured offset', () => {
    const t = dayTimes({ year: 2026, month: 9, day: 1 }, -28.644, 153.638);
    near(
      (t.sunrise - t.peakColourSunrise) / 60000,
      DEFAULT_PEAK_OFFSET_MIN,
      0.001,
      'peak colour precedes sunrise'
    );
    near(
      (t.peakColourSunset - t.sunset) / 60000,
      DEFAULT_PEAK_OFFSET_MIN,
      0.001,
      'peak colour follows sunset'
    );
  });

  it('honours a custom offset', () => {
    const t = dayTimes({ year: 2026, month: 9, day: 1 }, -28.644, 153.638, {
      peakOffsetMinutes: 35,
    });
    near((t.sunrise - t.peakColourSunrise) / 60000, 35, 0.001, 'custom offset');
  });

  it('reports day length that matches sunrise-to-sunset', () => {
    const t = dayTimes({ year: 2026, month: 12, day: 21 }, -12.4634, 130.8456);
    near(t.dayLengthMinutes, (t.sunset - t.sunrise) / 60000, 1, 'day length');
    // Darwin sits at 12.5 degrees south, so the December solstice day runs to
    // about 12 h 52 m — the tropics get far less seasonal swing than Hobart.
    near(t.dayLengthMinutes / 60, 12.87, 0.1, 'Darwin December day length');
  });

  it('gives longer twilight at high latitude than in the tropics', () => {
    const date = { year: 2026, month: 6, day: 21 };
    const hobart = dayTimes(date, -42.8821, 147.3272);
    const darwin = dayTimes(date, -12.4634, 130.8456);
    assert.ok(
      hobart.civilTwilightEveningMinutes > darwin.civilTwilightEveningMinutes,
      `Hobart ${hobart.civilTwilightEveningMinutes} should exceed Darwin ${darwin.civilTwilightEveningMinutes}`
    );
  });

  it('flags polar day instead of returning broken times', () => {
    const t = dayTimes({ year: 2026, month: 12, day: 21 }, -85, 0);
    assert.equal(t.sunrise, null);
    assert.equal(t.sunset, null);
    assert.equal(t.regime, 'polar-day');
    assert.equal(t.dayLengthMinutes, null);
  });

  it('flags polar night', () => {
    const t = dayTimes({ year: 2026, month: 6, day: 21 }, -85, 0);
    assert.equal(t.regime, 'polar-night');
  });
});

describe('timezoneForPoint', () => {
  const cases = [
    ['Perth', -31.95, 115.86, 'Australia/Perth'],
    ['Broome', -17.96, 122.21, 'Australia/Perth'],
    ['Darwin', -12.46, 130.85, 'Australia/Darwin'],
    ['Alice Springs', -23.70, 133.88, 'Australia/Darwin'],
    ['Adelaide', -34.93, 138.60, 'Australia/Adelaide'],
    ['Uluru', -25.34, 131.04, 'Australia/Darwin'],
    ['Brisbane', -27.47, 153.03, 'Australia/Brisbane'],
    ['Cairns', -16.92, 145.77, 'Australia/Brisbane'],
    ['Sydney', -33.87, 151.21, 'Australia/Sydney'],
    ['Melbourne', -37.81, 144.96, 'Australia/Sydney'],
    ['Hobart', -42.88, 147.33, 'Australia/Hobart'],
  ];

  for (const [name, lat, lon, expected] of cases) {
    it(`places ${name} in ${expected}`, () => {
      assert.equal(timezoneForPoint(lat, lon), expected);
    });
  }
});

describe('formatting', () => {
  it('formats an instant in the requested zone', () => {
    // 06:54 UTC on 21 June 2024 is 16:54 in Sydney (AEST, UTC+10).
    assert.equal(formatInZone(utc(2024, 6, 21, 6, 54), 'Australia/Sydney'), '16:54');
  });

  it('respects daylight saving', () => {
    // 06:54 UTC in January is 17:54 AEDT (UTC+11).
    assert.equal(formatInZone(utc(2024, 1, 21, 6, 54), 'Australia/Sydney'), '17:54');
  });

  it('renders a placeholder for a null instant', () => {
    assert.equal(formatInZone(null, 'Australia/Sydney'), '--:--');
  });

  it('resolves the civil date in the target zone, not UTC', () => {
    // 21:00 UTC on 30 June is already 07:00 on 1 July in Sydney.
    const d = civilDateInZone(utc(2024, 6, 30, 21, 0), 'Australia/Sydney');
    assert.deepEqual(d, { year: 2024, month: 7, day: 1 });
  });
});

describe('bearingDistanceToArc', () => {
  it('returns zero inside a simple arc', () => {
    assert.equal(bearingDistanceToArc(270, [200, 340]), 0);
  });

  it('returns zero inside an arc that wraps through north', () => {
    assert.equal(bearingDistanceToArc(0, [340, 20]), 0);
    assert.equal(bearingDistanceToArc(355, [340, 20]), 0);
    assert.equal(bearingDistanceToArc(15, [340, 20]), 0);
  });

  it('measures to the nearest edge outside the arc', () => {
    assert.equal(bearingDistanceToArc(30, [340, 20]), 10);
    assert.equal(bearingDistanceToArc(330, [340, 20]), 10);
  });

  it('never exceeds 180 degrees', () => {
    for (let b = 0; b < 360; b += 7) {
      const d = bearingDistanceToArc(b, [90, 100]);
      assert.ok(d >= 0 && d <= 180, `bearing ${b} gave ${d}`);
    }
  });
});

describe('haversineKm', () => {
  it('measures Sydney to Melbourne at about 714 km', () => {
    near(haversineKm(-33.8688, 151.2093, -37.8136, 144.9631), 714, 12, 'SYD-MEL');
  });

  it('is zero for identical points', () => {
    assert.equal(haversineKm(-25, 133, -25, 133), 0);
  });
});

describe('scoreEvent', () => {
  const base = {
    azimuth: 270,
    openArcs: [[200, 340]],
    twilightMinutes: 30,
    elevationM: 0,
    clarity: 0.8,
    waterHorizon: true,
  };

  it('produces a score in range with a grade', () => {
    const s = scoreEvent(base);
    assert.ok(s.total >= 0 && s.total <= 100, `total out of range: ${s.total}`);
    assert.ok(typeof s.grade === 'string' && s.grade.length > 0);
  });

  it('awards full alignment when the sun sets into the open arc', () => {
    assert.equal(scoreEvent(base).parts.alignment, 40);
  });

  it('penalises a sun that sets behind the obstructed side', () => {
    const blocked = scoreEvent({ ...base, azimuth: 90 });
    assert.ok(
      blocked.parts.alignment < scoreEvent(base).parts.alignment,
      'blocked horizon should score lower'
    );
    assert.equal(blocked.parts.alignment, 0);
  });

  it('rewards longer twilight', () => {
    const short = scoreEvent({ ...base, twilightMinutes: 21 });
    const long = scoreEvent({ ...base, twilightMinutes: 44 });
    assert.ok(long.total > short.total, 'longer twilight should score higher');
  });

  it('rewards elevation', () => {
    const low = scoreEvent({ ...base, elevationM: 0 });
    const high = scoreEvent({ ...base, elevationM: 1200 });
    assert.equal(high.parts.vantage - low.parts.vantage, 10);
  });

  it('caps every component at its weight', () => {
    const maxed = scoreEvent({
      azimuth: 270,
      openArcs: [[0, 359]],
      twilightMinutes: 999,
      elevationM: 99999,
      clarity: 5,
      waterHorizon: true,
    });
    assert.equal(maxed.parts.alignment, 40);
    assert.equal(maxed.parts.twilight, 25);
    assert.equal(maxed.parts.vantage, 15);
    assert.equal(maxed.parts.clarity, 20);
    assert.equal(maxed.total, 100);
  });

  it('survives an empty horizon definition', () => {
    const s = scoreEvent({ ...base, openArcs: [] });
    assert.equal(s.parts.alignment, 0);
    assert.ok(Number.isFinite(s.total));
  });
});

describe('estimateClarity', () => {
  const cities = [{ lat: -33.87, lon: 151.21 }, { lat: -31.95, lon: 115.86 }];

  it('rates a remote point higher than an urban one', () => {
    const remote = estimateClarity(-25.34, 131.04, cities);
    const urban = estimateClarity(-33.87, 151.21, cities);
    assert.ok(remote > urban, `${remote} should exceed ${urban}`);
  });

  it('stays within the documented bounds', () => {
    assert.equal(estimateClarity(-33.87, 151.21, cities), 0.45);
    assert.ok(estimateClarity(-25.34, 131.04, cities) <= 0.95);
  });

  it('falls back to a neutral value with no reference cities', () => {
    assert.equal(estimateClarity(-25, 133, []), 0.7);
  });
});

describe('twilightColour', () => {
  it('is fully transparent in broad daylight', () => {
    assert.equal(twilightColour(45).a, 0);
  });

  it('is dark and opaque deep in the night', () => {
    const night = twilightColour(-40);
    assert.ok(night.a > 0.8, 'night should be near opaque');
    assert.ok(night.r < 30 && night.g < 30 && night.b < 60, 'night should be dark');
  });

  it('is warm at the horizon', () => {
    const horizon = twilightColour(0);
    assert.ok(horizon.r > horizon.b, 'horizon colour should be warm');
  });

  it('increases opacity monotonically as the sun drops', () => {
    let prev = -1;
    for (let e = 12; e >= -30; e -= 0.5) {
      const a = twilightColour(e).a;
      assert.ok(a >= prev - 1e-9, `alpha decreased at elevation ${e}`);
      prev = a;
    }
  });
});

describe('buildClipboardText', () => {
  const times = dayTimes({ year: 2026, month: 9, day: 1 }, -28.644, 153.638);
  const text = buildClipboardText({
    name: 'Cape Byron',
    lat: -28.644,
    lon: 153.638,
    event: 'sunset',
    times,
    timeZone: 'Australia/Sydney',
    score: scoreEvent({
      azimuth: 270, openArcs: [[200, 340]], twilightMinutes: 28,
      elevationM: 100, clarity: 0.8, waterHorizon: true,
    }),
    peakOffsetMinutes: 20,
  });

  it('leads with the place and the event', () => {
    assert.ok(text.startsWith('Cape Byron — sunset plan'), text.slice(0, 60));
  });

  it('includes coordinates to four decimals', () => {
    assert.ok(text.includes('-28.6440, 153.6380'), 'coordinates missing');
  });

  it('states the peak colour rule', () => {
    assert.ok(/Peak colour: \d{2}:\d{2}/.test(text), 'peak colour line missing');
    assert.ok(text.includes('20 min after sunset'), 'offset explanation missing');
  });

  it('includes golden and blue hour windows', () => {
    assert.ok(text.includes('Golden hour:'), 'golden hour missing');
    assert.ok(text.includes('Blue hour:'), 'blue hour missing');
  });

  it('carries a caveat about cloud', () => {
    assert.ok(/cloud/i.test(text), 'cloud caveat missing');
  });

  it('handles a sunrise plan symmetrically', () => {
    const rise = buildClipboardText({
      name: 'Cape Byron', lat: -28.644, lon: 153.638, event: 'sunrise',
      times, timeZone: 'Australia/Sydney', score: null, peakOffsetMinutes: 20,
    });
    assert.ok(rise.includes('20 min before sunrise'), 'sunrise offset wording');
    assert.ok(!rise.includes('Light score'), 'score line should be omitted when null');
  });
});

describe('local day anchoring', () => {
  it('reports the standard-time offset for eastern Australia in winter', () => {
    assert.equal(zoneOffsetMinutes(utc(2026, 6, 15, 0, 0), 'Australia/Sydney'), 600);
  });

  it('reports the daylight-saving offset in summer', () => {
    assert.equal(zoneOffsetMinutes(utc(2026, 1, 15, 0, 0), 'Australia/Sydney'), 660);
  });

  it('reports Perth as a fixed ten hours behind nothing in particular', () => {
    // Western Australia does not observe daylight saving, so the offset is
    // +8:00 all year round.
    assert.equal(zoneOffsetMinutes(utc(2026, 1, 15, 0, 0), 'Australia/Perth'), 480);
    assert.equal(zoneOffsetMinutes(utc(2026, 6, 15, 0, 0), 'Australia/Perth'), 480);
  });

  it('finds the instant of local midnight', () => {
    const m = localMidnight({ year: 2026, month: 6, day: 15 }, 'Australia/Sydney');
    assert.equal(formatInZone(m, 'Australia/Sydney'), '00:00');
    // 00:00 AEST is 14:00 UTC the previous day.
    assert.equal(m.toISOString(), '2026-06-14T14:00:00.000Z');
  });

  it('finds local midnight across a daylight-saving transition', () => {
    // Clocks go forward in Sydney on the first Sunday of October.
    const m = localMidnight({ year: 2026, month: 10, day: 4 }, 'Australia/Sydney');
    assert.equal(formatInZone(m, 'Australia/Sydney'), '00:00');
  });

  it('spans exactly one local day for a non-transition date', () => {
    const a = localMidnight({ year: 2026, month: 5, day: 1 }, 'Australia/Perth');
    const b = localMidnight({ year: 2026, month: 5, day: 2 }, 'Australia/Perth');
    assert.equal((b - a) / 3600000, 24);
  });
});
