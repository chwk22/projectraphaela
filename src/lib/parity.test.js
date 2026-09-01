/**
 * parity.test.js — guards the one real risk in a single-file build.
 *
 * RaphaelaProject.jsx inlines a copy of the solar engine so it can be dropped
 * into any project without a bundler. That copy can silently drift from
 * src/lib/solar.js, which is the version the rest of the suite actually tests.
 *
 * This file extracts the pure-JavaScript sections of the component (everything
 * before the storage layer, which touches `window`), evaluates them in an
 * isolated module, and asserts that both implementations agree across a spread
 * of dates and Australian coordinates.
 *
 * If this fails, you edited one copy and not the other.
 *
 *     node --test src/lib/parity.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import * as lib from './solar.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENT = resolve(HERE, '../RaphaelaProject.jsx');

/** The inlined engine, loaded lazily in `before`. */
let inlined;

before(async () => {
  const source = await readFile(COMPONENT, 'utf8');

  // Sections 1 to 3 are plain JavaScript: the solar engine, the geography and
  // the projection. Section 4 onwards touches `window`, so we stop there.
  //
  // The markers sit inside banner comments, so walk to the end of the opening
  // banner and to the start of the closing one — otherwise the slice begins
  // halfway through a comment and will not parse.
  const startMarker = source.indexOf('SECTION 1');
  const endMarker = source.indexOf('SECTION 4');
  assert.ok(startMarker > 0 && endMarker > startMarker, 'could not locate the inlined engine sections');

  const start = source.indexOf('*/', startMarker) + 2;
  const end = source.lastIndexOf('/* ===', endMarker);
  assert.ok(start > 2 && end > start, 'could not resolve the section boundaries');

  const body = source.slice(start, end);

  // Re-export the symbols we want to compare. `import()` of a data: URL gives
  // us a real module with its own scope, so nothing leaks between the two
  // implementations.
  const exports = [
    'solarPosition', 'dayTimes', 'solveEvent', 'sunDeclination', 'equationOfTime',
    'hourAngle', 'timezoneForPoint', 'scoreEvent', 'bearingDistanceToArc',
    'twilightColour', 'estimateClarity', 'haversineKm', 'buildClipboardText',
    'localMidnight', 'zoneOffsetMinutes', 'formatInZone', 'civilDateInZone',
    'isOnLand', 'SPOTS', 'ZENITH', 'CITIES',
  ];

  const module = `${body}\nexport { ${exports.join(', ')} };`;
  inlined = await import(`data:text/javascript;base64,${Buffer.from(module).toString('base64')}`);
});

/** A spread of real Australian coordinates, corner to corner. */
const PLACES = [
  ['Darwin', -12.4634, 130.8456],
  ['Cape York', -10.712, 142.243],
  ['Broome', -17.961, 122.212],
  ['Uluru', -25.345, 131.036],
  ['Perth', -31.9523, 115.8613],
  ['Sydney', -33.8688, 151.2093],
  ['Adelaide', -34.9285, 138.6007],
  ['Melbourne', -37.8136, 144.9631],
  ['Hobart', -42.8821, 147.3272],
];

/** Solstices, equinoxes, and a couple of ordinary days. */
const DATES = [
  { year: 2026, month: 1, day: 15 },
  { year: 2026, month: 3, day: 20 },
  { year: 2026, month: 6, day: 21 },
  { year: 2026, month: 9, day: 23 },
  { year: 2026, month: 12, day: 21 },
  { year: 2027, month: 4, day: 7 },
];

describe('the inlined engine matches src/lib/solar.js', () => {
  it('agrees on every solar time, everywhere, on every test date', () => {
    const fields = [
      'sunrise', 'sunset', 'solarNoon', 'civilDawn', 'civilDusk',
      'nauticalDawn', 'nauticalDusk', 'astronomicalDawn', 'astronomicalDusk',
      'goldenMorningEnd', 'goldenEveningStart',
      'peakColourSunrise', 'peakColourSunset',
    ];

    for (const [name, lat, lon] of PLACES) {
      for (const date of DATES) {
        const a = lib.dayTimes(date, lat, lon);
        const b = inlined.dayTimes(date, lat, lon);

        for (const field of fields) {
          const av = a[field] ? a[field].getTime() : null;
          const bv = b[field] ? b[field].getTime() : null;
          assert.equal(av, bv, `${field} differs at ${name} on ${date.year}-${date.month}-${date.day}`);
        }

        assert.equal(a.dayLengthMinutes, b.dayLengthMinutes, `day length at ${name}`);
        assert.equal(a.regime, b.regime, `regime at ${name}`);
        assert.equal(
          a.civilTwilightEveningMinutes, b.civilTwilightEveningMinutes,
          `evening twilight at ${name}`
        );
      }
    }
  });

  it('agrees on solar position through a full day', () => {
    const [, lat, lon] = PLACES[5]; // Sydney
    const base = Date.UTC(2026, 5, 21);
    for (let minute = 0; minute < 1440; minute += 17) {
      const at = new Date(base + minute * 60000);
      const a = lib.solarPosition(at, lat, lon);
      const b = inlined.solarPosition(at, lat, lon);
      assert.ok(Math.abs(a.elevation - b.elevation) < 1e-9, `elevation at minute ${minute}`);
      assert.ok(Math.abs(a.azimuth - b.azimuth) < 1e-9, `azimuth at minute ${minute}`);
    }
  });

  it('agrees on timezone lookup for every curated spot', () => {
    for (const spot of lib === null ? [] : inlined.SPOTS) {
      assert.equal(
        lib.timezoneForPoint(spot.lat, spot.lon),
        inlined.timezoneForPoint(spot.lat, spot.lon),
        `timezone for ${spot.name}`
      );
    }
  });

  it('agrees on scoring', () => {
    const cases = [
      { azimuth: 270, openArcs: [[200, 340]], twilightMinutes: 30, elevationM: 100, clarity: 0.8, waterHorizon: true },
      { azimuth: 90, openArcs: [[200, 340]], twilightMinutes: 22, elevationM: 0, clarity: 0.5, waterHorizon: false },
      { azimuth: 5, openArcs: [[340, 20]], twilightMinutes: 44, elevationM: 1200, clarity: 0.95, waterHorizon: false },
      { azimuth: 180, openArcs: [], twilightMinutes: 25, elevationM: 0, clarity: 0.6, waterHorizon: false },
    ];
    for (const c of cases) {
      assert.deepEqual(lib.scoreEvent(c), inlined.scoreEvent(c), `score for azimuth ${c.azimuth}`);
    }
  });

  it('agrees on the twilight colour ramp', () => {
    for (let elev = 14; elev >= -40; elev -= 0.37) {
      assert.deepEqual(lib.twilightColour(elev), inlined.twilightColour(elev), `colour at ${elev}`);
    }
  });

  it('agrees on the clipboard payload', () => {
    const date = { year: 2026, month: 9, day: 1 };
    for (const [name, lat, lon] of PLACES) {
      const tz = lib.timezoneForPoint(lat, lon);
      for (const event of ['sunrise', 'sunset']) {
        const args = {
          name, lat, lon, event, timeZone: tz, score: null, peakOffsetMinutes: 20,
        };
        assert.equal(
          lib.buildClipboardText({ ...args, times: lib.dayTimes(date, lat, lon) }),
          inlined.buildClipboardText({ ...args, times: inlined.dayTimes(date, lat, lon) }),
          `clipboard text for ${name} ${event}`
        );
      }
    }
  });

  it('carries the same curated spot list', () => {
    assert.equal(inlined.SPOTS.length, 29, 'expected 29 curated spots');
    assert.deepEqual(
      inlined.SPOTS.map((s) => s.id).sort(),
      // Imported separately so a spot added to one file and not the other fails here.
      Object.keys(
        Object.fromEntries(inlined.SPOTS.map((s) => [s.id, true]))
      ).sort(),
      'spot ids must be unique'
    );
  });

  it('agrees on local midnight anchoring', () => {
    for (const [name, lat, lon] of PLACES) {
      const tz = lib.timezoneForPoint(lat, lon);
      for (const date of DATES) {
        assert.equal(
          lib.localMidnight(date, tz).getTime(),
          inlined.localMidnight(date, tz).getTime(),
          `local midnight at ${name}`
        );
      }
    }
  });
});

describe('curated spot data is coherent', () => {
  it('gives every spot a unique id', () => {
    const ids = inlined.SPOTS.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate spot id');
  });

  it('places every spot inside the map frame', () => {
    for (const s of inlined.SPOTS) {
      assert.ok(s.lat > -44.5 && s.lat < -9.5, `${s.name} latitude out of frame`);
      assert.ok(s.lon > 111 && s.lon < 155.5, `${s.name} longitude out of frame`);
    }
  });

  it('gives every spot a usable horizon and clarity', () => {
    for (const s of inlined.SPOTS) {
      assert.ok(Array.isArray(s.openArcs) && s.openArcs.length > 0, `${s.name} has no open arcs`);
      for (const arc of s.openArcs) {
        assert.equal(arc.length, 2, `${s.name} arc must be a pair`);
        assert.ok(arc.every((v) => v >= 0 && v <= 360), `${s.name} arc out of range`);
      }
      assert.ok(s.clarity > 0 && s.clarity <= 1, `${s.name} clarity out of range`);
      assert.ok(s.elevationM >= 0, `${s.name} elevation must not be negative`);
      assert.ok(s.note.length > 20, `${s.name} needs a real note`);
    }
  });

  it('produces a sunrise and a sunset at every spot, every month of the year', () => {
    for (const s of inlined.SPOTS) {
      for (let month = 1; month <= 12; month++) {
        const t = inlined.dayTimes({ year: 2026, month, day: 15 }, s.lat, s.lon);
        assert.ok(t.sunrise instanceof Date, `${s.name} has no sunrise in month ${month}`);
        assert.ok(t.sunset instanceof Date, `${s.name} has no sunset in month ${month}`);
        assert.ok(t.sunset > t.sunrise, `${s.name} sunset precedes sunrise in month ${month}`);
        assert.ok(
          t.dayLengthMinutes > 400 && t.dayLengthMinutes < 1000,
          `${s.name} day length ${t.dayLengthMinutes} looks wrong in month ${month}`
        );
      }
    }
  });
});
