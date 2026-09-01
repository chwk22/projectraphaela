/**
 * types.d.ts — TypeScript declarations for RaphaelaProject.
 *
 * The implementation is JavaScript with JSDoc annotations, so `tsc --checkJs`
 * already validates it. These declarations exist for consumers who import the
 * library from a TypeScript project.
 *
 * Add to tsconfig.json:
 *     { "include": ["src/**\/*.ts", "src/**\/*.d.ts", "src/**\/*.js"] }
 */

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/** A calendar date with no timezone attached. Months are 1-12, not 0-11. */
export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** Latitude positive north, longitude positive east. Australia is negative/positive. */
export interface Coordinates {
  lat: number;
  lon: number;
}

/** An IANA timezone identifier, e.g. 'Australia/Perth'. */
export type TimeZone = string;

/** Which end of the day is being planned. */
export type EventMode = 'sunrise' | 'sunset';

/**
 * A clockwise range of compass bearings in degrees, allowed to wrap through
 * north: `[340, 20]` is a 40-degree arc centred on due north.
 */
export type BearingArc = [number, number];

/** Whether the sun rises and sets normally on this date at this latitude. */
export type DayRegime = 'normal' | 'polar-day' | 'polar-night';

/** Descending bands of the 0-100 light score. */
export type ScoreGrade = 'exceptional' | 'strong' | 'good' | 'fair' | 'poor';

// ---------------------------------------------------------------------------
// Solar position
// ---------------------------------------------------------------------------

export interface SolarPosition {
  /** Apparent altitude above the horizon in degrees, refraction included. */
  elevation: number;
  /** Altitude before the refraction correction. */
  geometricElevation: number;
  /** Compass bearing 0-360, where 0 is north and 90 is east. */
  azimuth: number;
  /** Solar declination in degrees, roughly -23.44 to +23.44 across a year. */
  declination: number;
  /** Local hour angle in degrees; negative before solar noon. */
  hourAngle: number;
}

/**
 * Every solar time for one day at one place.
 *
 * Any field may be `null` during polar day or polar night; check `regime`
 * before rendering. Inside Australia only the astronomical-twilight fields
 * ever come back null, and only in far-southern Tasmania around midsummer.
 */
export interface DayTimes {
  sunrise: Date | null;
  sunset: Date | null;
  /** Always present: solar noon needs no hour-angle solve. */
  solarNoon: Date;
  civilDawn: Date | null;
  civilDusk: Date | null;
  nauticalDawn: Date | null;
  nauticalDusk: Date | null;
  astronomicalDawn: Date | null;
  astronomicalDusk: Date | null;
  /** Sun reaches 6 degrees up in the morning: the top of the golden window. */
  goldenMorningEnd: Date | null;
  /** Sun drops back to 6 degrees in the evening. */
  goldenEveningStart: Date | null;
  /** Sunrise minus the peak-colour offset. */
  peakColourSunrise: Date | null;
  /** Sunset plus the peak-colour offset. */
  peakColourSunset: Date | null;
  dayLengthMinutes: number | null;
  civilTwilightMorningMinutes: number | null;
  civilTwilightEveningMinutes: number | null;
  regime: DayRegime;
}

export interface DayTimesOptions {
  /** Minutes either side of the event at which colour peaks. Defaults to 20. */
  peakOffsetMinutes?: number;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoreInput {
  /** Solar bearing at the moment of the event. */
  azimuth: number;
  /** Bearings over which the horizon is unobstructed. */
  openArcs: BearingArc[];
  /** Civil twilight duration for this event, in minutes. */
  twilightMinutes: number | null;
  /** Height above sea level in metres. */
  elevationM: number;
  /** Static air-clarity index, 0 to 1. */
  clarity: number;
  /** True when the horizon is sea, or a lake wide enough to behave like one. */
  waterHorizon: boolean;
}

export interface ScoreParts {
  /** 0-40: does the sun land in the visible part of the sky? */
  alignment: number;
  /** 0-25: how long the colour holds. */
  twilight: number;
  /** 0-15: height and an unbroken horizon line. */
  vantage: number;
  /** 0-20: haze, dust and light pollution. */
  clarity: number;
}

export interface ScoreResult {
  /** 0-100. */
  total: number;
  grade: ScoreGrade;
  parts: ScoreParts;
  /** One sentence naming the dominant factor, for display under the bars. */
  headline: string;
}

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

/** A curated shooting location. */
export interface Spot {
  id: string;
  name: string;
  /** State or territory abbreviation, e.g. 'NSW'. */
  region: string;
  lat: number;
  lon: number;
  /** Typical shooting elevation, not the summit height. */
  elevationM: number;
  openArcs: BearingArc[];
  waterHorizon: boolean;
  /** 0-1, where desert sites sit near 0.95 and city beaches near 0.5. */
  clarity: number;
  note: string;
}

/** A `Spot` resolved for display, which may be a user-dropped pin. */
export interface ResolvedSite extends Spot {
  /** True when this came from the map rather than the curated list. */
  isCustom: boolean;
}

export interface City {
  name: string;
  lat: number;
  lon: number;
}

/** A saved entry in local storage. */
export interface SavedSpot {
  /** Coordinate string used for deduplication. */
  key: string;
  name: string;
  lat: number;
  lon: number;
  /** The curated spot id, or null for a dropped pin. */
  spotId: string | null;
}

/** Map frame, in degrees. */
export interface MapBounds {
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
}

// ---------------------------------------------------------------------------
// Module: src/lib/solar.js
// ---------------------------------------------------------------------------

declare module './lib/solar.js' {
  export const RAD: number;
  export const DEG: number;
  export const DEFAULT_PEAK_OFFSET_MIN: number;

  export const ZENITH: {
    SUNRISE_SUNSET: number;
    CIVIL: number;
    NAUTICAL: number;
    ASTRONOMICAL: number;
    GOLDEN_UPPER: number;
  };

  export const TWILIGHT_STOPS: ReadonlyArray<
    readonly [number, number, number, number, number]
  >;

  // Numeric helpers
  export function clamp(v: number, lo: number, hi: number): number;
  export function norm360(deg: number): number;
  export function lerp(a: number, b: number, t: number): number;

  /** @throws {TypeError | RangeError} on a non-finite or out-of-range value. */
  export function assertCoords(lat: number, lon: number): Coordinates;

  // Julian dates
  export function toJulianDay(date: Date): number;
  export function fromJulianDay(jd: number): Date;
  export function julianDayForUTCDate(year: number, month: number, day: number): number;
  export function julianCentury(jd: number): number;

  // Orbital elements, all taking Julian centuries since J2000.0
  export function geomMeanLongSun(t: number): number;
  export function geomMeanAnomalySun(t: number): number;
  export function earthOrbitEccentricity(t: number): number;
  export function sunEqOfCentre(t: number): number;
  export function sunApparentLong(t: number): number;
  export function obliquityCorrection(t: number): number;
  export function sunDeclination(t: number): number;
  export function equationOfTime(t: number): number;

  /** @returns null during polar day or polar night. */
  export function hourAngle(
    latDeg: number,
    declDeg: number,
    zenithDeg: number
  ): number | null;

  export function refractionCorrection(elevationDeg: number): number;

  // Position and events
  export function solarPosition(date: Date, lat: number, lon: number): SolarPosition;

  /** @returns null when the sun never reaches that zenith on this date. */
  export function solveEvent(
    civilDate: CivilDate,
    lat: number,
    lon: number,
    zenith: number,
    isRise: boolean
  ): Date | null;

  export function dayTimes(
    civilDate: CivilDate,
    lat: number,
    lon: number,
    options?: DayTimesOptions
  ): DayTimes;

  // Timezones
  export function timezoneForPoint(lat: number, lon: number): TimeZone;
  export function formatInZone(
    date: Date | null,
    timeZone: TimeZone,
    opts?: Intl.DateTimeFormatOptions
  ): string;
  export function zoneAbbreviation(date: Date | null, timeZone: TimeZone): string;
  export function civilDateInZone(date: Date, timeZone: TimeZone): CivilDate;
  export function zoneOffsetMinutes(date: Date, timeZone: TimeZone): number;
  export function localMidnight(civilDate: CivilDate, timeZone: TimeZone): Date;

  // Geometry and scoring
  export function bearingDistanceToArc(bearing: number, arc: BearingArc): number;
  export function haversineKm(
    lat1: number, lon1: number, lat2: number, lon2: number
  ): number;
  export function scoreEvent(input: ScoreInput): ScoreResult;
  export function estimateClarity(lat: number, lon: number, cities: City[]): number;

  // Colour
  export function twilightColour(elevation: number): {
    r: number; g: number; b: number; a: number;
  };

  // Clipboard
  export function buildClipboardText(args: {
    name: string;
    lat: number;
    lon: number;
    event: EventMode;
    times: DayTimes;
    timeZone: TimeZone;
    score: ScoreResult | null;
    peakOffsetMinutes: number;
  }): string;
}

// ---------------------------------------------------------------------------
// Module: src/data/australia.js
// ---------------------------------------------------------------------------

declare module './data/australia.js' {
  export const BOUNDS: MapBounds;

  /** Rings of [longitude, latitude]. */
  export const MAINLAND: Array<[number, number]>;
  export const TASMANIA: Array<[number, number]>;
  export const KANGAROO_ISLAND: Array<[number, number]>;
  export const TIWI_ISLANDS: Array<[number, number]>;
  export const LANDMASSES: Array<Array<[number, number]>>;

  export function pointInPolygon(
    lon: number,
    lat: number,
    polygon: Array<[number, number]>
  ): boolean;

  /** Coarse land test. Warn on a false result; never block on it. */
  export function isOnLand(lat: number, lon: number): boolean;
  export function isInFrame(lat: number, lon: number): boolean;

  export const CITIES: City[];
  export const SPOTS: Spot[];
  export const SPOTS_BY_ID: Record<string, Spot>;
}

// ---------------------------------------------------------------------------
// Module: src/RaphaelaProject.jsx
// ---------------------------------------------------------------------------

declare module './RaphaelaProject.jsx' {
  import type { ComponentType } from 'react';

  /**
   * The whole application. Takes no props and owns its own persistence, so it
   * can be mounted anywhere without configuration.
   */
  const RaphaelaProject: ComponentType<Record<string, never>>;
  export default RaphaelaProject;
}
