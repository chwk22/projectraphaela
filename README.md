# RaphaelaProject

Offline sunrise and sunset planning for Australia. Pick a place, get the exact
times, copy them to your phone. Every calculation runs on the device and
nothing is ever sent anywhere.

---

## What it does

**Finds where the light should be best.** Twenty-nine curated sites are scored
for whichever date and event you choose, weighing horizon alignment, twilight
duration, air clarity and vantage height. The ranking changes with the season,
because the sun's bearing at sunset moves through about 60 degrees across the
year, and a west-facing beach that works in June may be pointing at nothing in
December.

**Tells you when the colour peaks.** The sky is usually at its most saturated a
fixed interval either side of the official event — 20 minutes before sunrise,
and the same interval after sunset. That offset is the headline number in the
interface and is adjustable, because the real figure runs shorter in the
tropics and longer in Tasmania.

**Shows the sun moving.** A terminator is computed on a grid and painted over a
map of Australia. Scrub it, or press play to run a whole day in about eight
seconds. The bright band sweeping across the continent is where sunrise or
sunset is happening at that instant.

**Copies a plan.** One button puts the place, coordinates, and every relevant
time on the clipboard as plain text.

---

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 90 unit tests, no dependencies
npm run build    # production bundle in dist/
```

Requires Node 18 or newer. The test runner is Node's built-in `node:test`, so
there is nothing to install for it.

---

## Using the component

It takes no props and owns its own persistence, so mounting it is the whole
integration:

```jsx
import RaphaelaProject from './RaphaelaProject.jsx';

export default function App() {
  return <RaphaelaProject />;
}
```

### Using the engine on its own

The astronomy is a separate, dependency-free module. Nothing in it touches the
DOM, the network or the clock, so it runs unchanged in Node, in a Web Worker,
or on a server.

```js
import {
  dayTimes,
  solarPosition,
  scoreEvent,
  timezoneForPoint,
  formatInZone,
} from './lib/solar.js';

const CAPE_BYRON = { lat: -28.644, lon: 153.638 };
const date = { year: 2026, month: 9, day: 1 };   // months are 1-12

const times = dayTimes(date, CAPE_BYRON.lat, CAPE_BYRON.lon, {
  peakOffsetMinutes: 20,
});

const tz = timezoneForPoint(CAPE_BYRON.lat, CAPE_BYRON.lon);

formatInZone(times.sunrise, tz);            // '06:00'
formatInZone(times.peakColourSunrise, tz);  // '05:40'
times.dayLengthMinutes;                     // 691
times.civilTwilightMorningMinutes;          // 24
```

Rating a site for an event:

```js
const azimuth = solarPosition(times.sunrise, CAPE_BYRON.lat, CAPE_BYRON.lon).azimuth;

scoreEvent({
  azimuth,
  openArcs: [[335, 200]],   // clockwise bearings you can actually see
  twilightMinutes: times.civilTwilightMorningMinutes,
  elevationM: 100,
  clarity: 0.78,
  waterHorizon: true,
});
// {
//   total: 66,
//   grade: 'good',
//   parts: { alignment: 40, twilight: 4, vantage: 6, clarity: 16 },
//   headline: 'Clean water horizon with the sun in the right place.'
// }
// Alignment is full marks: on 1 September the sun rises at 081 degrees, well
// inside the arc. Twilight scores low because subtropical dawn is brief.
```

Full signatures are in `src/types.d.ts`.

---

## How the numbers are produced

**Solar position** uses the NOAA Solar Calculator algorithm, derived from
Meeus. Rise and set are solved by computing the hour angle at which the sun
reaches a given zenith, then running a second pass that re-evaluates the
declination and equation of time at the first estimate. Accuracy is around a
minute, which is well inside the uncertainty introduced by local terrain.

The zenith angles used are the standard ones. Sunrise and sunset are taken at
90.833 degrees rather than 90, which accounts for atmospheric refraction at the
horizon and the sun's apparent radius. Civil, nautical and astronomical
twilight are 96, 102 and 108. The golden window closes when the sun reaches 6
degrees up.

**Longitude is positive east throughout.** NOAA's own reference code uses
positive west, so the sign is flipped once, inside `eventMinutesUTC`. It is
noted in the source because it looks like a bug if you are comparing against
NOAA line by line.

**Why the day is anchored on the UTC date.** Rise and set are solved from the
Julian day at 00:00 UTC. That is correct for Australia specifically: every
Australian longitude is east of Greenwich, so local solar noon on a given UTC
date falls on the same local calendar date. The 20:00 UTC instant that is
7 a.m. tomorrow in Sydney is found by the solver as a negative minute offset
from the anchor, which is exactly right. This would need rethinking before
using the engine in the Americas.

**Local midnight** is resolved separately, through `Intl.DateTimeFormat`, so
the day ribbon and the time scrubber run midnight to midnight in the selected
place rather than across a UTC boundary that would cut through the middle of an
Australian afternoon. Daylight saving is handled, including the two days a year
when the offset changes.

### The light score

| Component | Weight | What it measures |
|---|---|---|
| Alignment | 40 | Whether the sun rises or sets into the part of the sky you can see. Falls off linearly over 45 degrees of miss. |
| Twilight  | 25 | Civil twilight duration. Longer means the colour holds for longer, which is why Hobart beats Darwin. |
| Clarity   | 20 | Static index for haze, dust and light pollution. |
| Vantage   | 15 | Height, plus a bonus for an unbroken water horizon. |

For a dropped pin there is no terrain data on board, so the panel asks what you
can see instead of guessing, and clarity is estimated from distance to the
nearest city.

---

## Storage

Everything persists to `localStorage` under the `raphaela:v1:` prefix — saved spots,
the peak-colour offset, sunrise or sunset preference, and the last selection.
There is no server and no account.

Reading `window.localStorage` **throws** in Safari private browsing, in
sandboxed iframes, and when a user has blocked site data. It does not return
null. So the adapter in `createStorage()` probes with a real write inside a
`try`/`catch` and falls back to an in-memory `Map` when that fails. The
interface says so plainly rather than silently losing your saved spots.

If you are running this inside a preview sandbox and see the notice about
storage, that is expected. It works normally when served from a real origin.

---

## Browser support

Safari 14.1+, Chrome 90+, Firefox 90+, Edge 90+, and the mobile equivalents.

- Clipboard writes try the async API first and fall back to a hidden textarea
  with `execCommand`. The fallback matters: the async API needs a secure
  context, so it is missing on plain http, and iOS Safari needs an explicit
  `Range` selection rather than `select()`.
- Layout uses the padding-ratio technique rather than `aspect-ratio`, so the
  map keeps its shape on older Safari.
- The range input is styled for both WebKit and Gecko pseudo-elements.
- `prefers-reduced-motion` suppresses the animation loop.

Safari **14.0** specifically shipped a destructuring bug that build tools
decline to work around, which is why the floor is 14.1.

---

## Accessibility

The map is a focusable `application` region: arrow keys nudge the pin by a
tenth of a degree, Shift makes it a whole degree, and each site marker is its
own button. Every control has a label, focus is always visible, and the ranking
table rows are keyboard-activatable.

---

## Testing

```bash
npm test          # 90 tests
npm run test:watch
```

Three groups:

- **`solar.test.js`** checks the astronomy against published figures from
  Geoscience Australia and NOAA — Sydney and Perth at both solstices, solstice
  declinations, the equation of time at its annual peak and trough, twilight
  event ordering, daylight-saving formatting, and the polar-day and polar-night
  branches.
- **`parity.test.js`** guards the single-file build. `RaphaelaProject.jsx`
  inlines a copy of the engine so it can be dropped into any project without a
  bundler, and that copy could drift from the tested library. The test extracts
  the pure sections of the component, evaluates them in an isolated module, and
  asserts both implementations agree across nine coordinates and six dates.
  **If it fails, you edited one copy and not the other.**
- **Data coherence** confirms every curated site has a unique id, sits inside
  the map frame, carries a valid horizon and clarity, and produces a sensible
  sunrise and sunset in all twelve months.

The suite runs on Vitest unchanged if you prefer a watcher; swap the `node:test`
import for `vitest`.

---

## Known limitations

These are deliberate, not oversights.

**Cloud is not modelled, and it is the single biggest factor in whether a
sunset is spectacular.** The app has no network by design. Read the score as
"how good is this place, geometrically, for this event on this date" — never as
a forecast. Check a real forecast before you drive somewhere.

**Rise and set assume a sea-level horizon.** A mountain to your east will delay
first light by considerably more than this can predict. The published tables
this is tested against make the same assumption.

**Timezones are resolved by rectangle, not by shapefile.** A real boundary
lookup is tens of thousands of vertices and this app ships no data files. Known
misses: Broken Hill keeps South Australian time but falls in the New South
Wales box, and Eucla and the Eyre Highway roadhouses run their own unofficial
offset. Everywhere with a meaningful population is correct.

**The coastline is a roughly 100-vertex generalisation.** It exists to give you
a recognisable shape to click on. The land test is used only to warn, never to
block, because coastal vantage points legitimately sit on or just outside a
generalised line.

**Sites with a full 360-degree horizon always score maximum alignment**, which
is physically honest but means summits tend to dominate the ranking in both
directions. What would separate them is foreground, which cannot be modelled
without terrain data.

**Clarity and horizon arcs for curated sites are hand-estimated**, informed by
the geography but not surveyed.

---

## Project layout

```
index.html
vite.config.js
package.json
src/
  main.jsx                  browser entry point
  RaphaelaProject.jsx       the application (self-contained, inlines the engine)
  types.d.ts                TypeScript declarations
  lib/
    solar.js                astronomy, timezones, scoring — pure, no DOM
    solar.test.js           unit tests against published values
    parity.test.js          inlined copy vs library, plus data coherence
  data/
    australia.js            coastline, curated sites, cities
```

`RaphaelaProject.jsx` deliberately duplicates `lib/solar.js` and
`data/australia.js` so the component is a single droppable file. If you would
rather import than duplicate, delete sections 1 to 3 of the component and
import from the modules instead — the exported names already match.
