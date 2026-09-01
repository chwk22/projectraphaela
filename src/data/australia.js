/**
 * australia.js — static geography. No network, no runtime cost beyond parsing.
 *
 * The coastline is a deliberately coarse generalisation (roughly 1:10m scale,
 * around 100 vertices). It exists to give people a recognisable shape to click
 * on and to test whether a dropped pin is on land. It is not survey data and
 * should never be used for navigation.
 *
 * Coordinates are [longitude, latitude] pairs, positive east / positive north,
 * so every Australian latitude is negative.
 */

/**
 * Map bounds. Chosen to frame the mainland and Tasmania with a little margin,
 * and to keep Cape York and the Bass Strait islands inside the frame.
 */
export const BOUNDS = {
  lonMin: 111,
  lonMax: 155.5,
  latMin: -44.5,
  latMax: -9.5,
};

/**
 * Mainland outline, traced clockwise from Cape York.
 * Notable features preserved: the Gulf of Carpentaria, Arnhem Land, the
 * Kimberley, Shark Bay, the Great Australian Bight, Spencer and St Vincent
 * gulfs, Wilsons Promontory, and the east-coast bulge at Cape Byron.
 */
export const MAINLAND = [
  // Cape York down the western side of the peninsula into the Gulf
  [142.5, -10.7], [141.9, -12.0], [141.6, -13.2], [141.6, -15.0], [140.8, -17.0],
  [139.9, -17.6], [138.6, -16.8], [137.5, -16.4], [136.4, -15.6], [135.4, -14.9],
  // Arnhem Land and the Top End
  [136.8, -12.2], [135.9, -12.1], [135.0, -12.4], [133.5, -11.8], [132.6, -12.1],
  [131.8, -11.4], [130.8, -12.4], [130.0, -13.2], [129.6, -14.8],
  // The Kimberley
  [128.6, -15.2], [128.0, -15.4], [127.4, -13.9], [126.2, -14.0], [125.0, -14.6],
  [124.1, -15.5], [123.6, -16.4], [122.2, -18.0], [121.6, -19.0], [120.7, -19.6],
  // Pilbara to North West Cape
  [119.6, -20.0], [118.6, -20.4], [117.2, -20.8], [115.9, -21.1], [114.9, -21.5],
  [114.1, -21.8], [113.7, -22.6], [114.4, -23.2], [113.8, -24.5],
  // Shark Bay and the mid-west
  [113.4, -25.5], [114.1, -26.3], [113.7, -27.7], [114.6, -28.8], [114.9, -30.0],
  [115.2, -31.2], [115.7, -32.1], [115.6, -33.3],
  // South-west corner: Cape Leeuwin, then east along the south coast
  [115.1, -34.4], [116.6, -35.1], [117.9, -35.1], [119.4, -34.5], [120.6, -33.9],
  [121.9, -33.9], [123.6, -33.9], [125.5, -32.6], [127.3, -32.1], [128.9, -31.7],
  [131.2, -31.5], [132.6, -31.9], [133.7, -32.1], [134.3, -32.9], [135.2, -34.2],
  // Eyre Peninsula, Spencer Gulf, Yorke Peninsula, St Vincent Gulf
  [135.9, -34.7], [136.9, -35.2], [137.0, -33.5], [137.8, -32.6], [137.9, -34.0],
  [137.6, -35.3], [138.2, -34.1], [138.5, -34.9], [138.1, -35.6],
  // The Coorong, western Victoria, the Great Ocean Road
  [139.3, -35.7], [139.8, -37.2], [140.9, -38.1], [141.6, -38.4], [142.9, -38.6],
  [143.5, -38.9], [144.5, -38.4], [144.9, -38.1], [145.1, -38.5],
  // Wilsons Promontory, Gippsland, the far south coast of New South Wales
  [146.4, -39.1], [147.0, -38.4], [147.9, -37.9], [149.2, -37.6], [149.9, -37.5],
  [150.2, -36.4], [150.9, -35.1], [151.3, -33.9], [152.5, -32.7], [153.1, -30.5],
  // Northern rivers, Cape Byron, south-east Queensland
  [153.6, -28.6], [153.5, -27.5], [153.2, -26.3], [152.5, -24.9], [151.6, -24.1],
  // Central and north Queensland coast
  [150.8, -23.4], [149.5, -22.4], [148.5, -20.8], [147.4, -19.6], [146.4, -19.0],
  [145.8, -16.9], [145.3, -15.0], [144.3, -14.5], [143.6, -14.4], [143.5, -12.8],
  [142.8, -11.5], [142.5, -10.7],
];

/** Tasmania. */
export const TASMANIA = [
  [144.7, -40.7], [145.3, -40.8], [146.4, -41.1], [147.4, -40.8], [148.3, -40.9],
  [148.3, -42.1], [147.9, -43.0], [147.5, -42.9], [146.9, -43.6], [146.0, -43.5],
  [145.5, -42.5], [145.2, -41.5], [144.7, -40.7],
];

/** Kangaroo Island. */
export const KANGAROO_ISLAND = [
  [136.5, -35.75], [137.4, -35.6], [138.1, -35.6], [137.9, -36.0], [136.6, -36.05],
  [136.5, -35.75],
];

/** Melville and Bathurst islands, north of Darwin. */
export const TIWI_ISLANDS = [
  [130.4, -11.2], [131.5, -11.2], [131.5, -11.8], [130.4, -11.7], [130.4, -11.2],
];

/** Every landmass polygon, in draw order. */
export const LANDMASSES = [MAINLAND, TASMANIA, KANGAROO_ISLAND, TIWI_ISLANDS];

/**
 * Ray-casting point-in-polygon test.
 *
 * @param {number} lon
 * @param {number} lat
 * @param {Array<[number, number]>} polygon
 * @returns {boolean}
 */
export function pointInPolygon(lon, lat, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Is this coordinate on Australian land, according to our coarse outline?
 * Used only to warn the user, never to block them — a pin a kilometre offshore
 * on a beach is a perfectly reasonable place to photograph a sunset.
 */
export function isOnLand(lat, lon) {
  return LANDMASSES.some((poly) => pointInPolygon(lon, lat, poly));
}

/** Is this coordinate inside the map frame at all? */
export function isInFrame(lat, lon) {
  return (
    lon >= BOUNDS.lonMin && lon <= BOUNDS.lonMax &&
    lat >= BOUNDS.latMin && lat <= BOUNDS.latMax
  );
}

/**
 * Capital cities and large regional centres, used as a light-pollution and
 * haze proxy when estimating air clarity for a user-dropped pin.
 */
export const CITIES = [
  { name: 'Sydney', lat: -33.8688, lon: 151.2093 },
  { name: 'Melbourne', lat: -37.8136, lon: 144.9631 },
  { name: 'Brisbane', lat: -27.4698, lon: 153.0251 },
  { name: 'Perth', lat: -31.9523, lon: 115.8613 },
  { name: 'Adelaide', lat: -34.9285, lon: 138.6007 },
  { name: 'Hobart', lat: -42.8821, lon: 147.3272 },
  { name: 'Darwin', lat: -12.4634, lon: 130.8456 },
  { name: 'Canberra', lat: -35.2809, lon: 149.1300 },
  { name: 'Gold Coast', lat: -28.0167, lon: 153.4000 },
  { name: 'Newcastle', lat: -32.9283, lon: 151.7817 },
  { name: 'Cairns', lat: -16.9186, lon: 145.7781 },
  { name: 'Alice Springs', lat: -23.6980, lon: 133.8807 },
];

/**
 * @typedef {Object} Spot
 * @property {string} id
 * @property {string} name
 * @property {string} region - state or territory
 * @property {number} lat
 * @property {number} lon
 * @property {number} elevationM - typical shooting elevation, not the summit
 * @property {Array<[number, number]>} openArcs - unobstructed horizon bearings
 * @property {boolean} waterHorizon - sea, or a lake wide enough to act like one
 * @property {number} clarity - 0..1 static air-clarity index
 * @property {string} note - what makes the place worth the drive
 */

/**
 * Curated shooting locations.
 *
 * `openArcs` are hand-estimated compass bearings over which the horizon is
 * open from the usual vantage point, written clockwise and allowed to wrap
 * through north. `clarity` is a subjective 0-1 index combining typical haze,
 * dust and light pollution: inland desert sites sit near 0.95, city beaches
 * near 0.5.
 *
 * @type {Spot[]}
 */
export const SPOTS = [
  {
    id: 'cape-byron', name: 'Cape Byron', region: 'NSW',
    lat: -28.6440, lon: 153.6380, elevationM: 100,
    openArcs: [[335, 200]], waterHorizon: true, clarity: 0.78,
    note: 'The mainland\u2019s easternmost point. First light in the country, with ocean on three sides.',
  },
  {
    id: 'bondi', name: 'Bondi Beach', region: 'NSW',
    lat: -33.8908, lon: 151.2743, elevationM: 8,
    openArcs: [[20, 190]], waterHorizon: true, clarity: 0.50,
    note: 'Easy access and a clean eastern horizon, at the cost of city haze.',
  },
  {
    id: 'echo-point', name: 'Echo Point, Blue Mountains', region: 'NSW',
    lat: -33.7320, lon: 150.3120, elevationM: 900,
    openArcs: [[130, 260]], waterHorizon: false, clarity: 0.70,
    note: 'Sandstone escarpment over the Jamison Valley. Valley fog is common at dawn.',
  },
  {
    id: 'kosciuszko', name: 'Mount Kosciuszko', region: 'NSW',
    lat: -36.4560, lon: 148.2630, elevationM: 2228,
    openArcs: [[0, 359]], waterHorizon: false, clarity: 0.92,
    note: 'The highest ground in the country and the thinnest air with it.',
  },
  {
    id: 'twelve-apostles', name: 'Twelve Apostles', region: 'VIC',
    lat: -38.6650, lon: 143.1050, elevationM: 70,
    openArcs: [[170, 320]], waterHorizon: true, clarity: 0.80,
    note: 'Limestone stacks on a south-facing coast. Best when the sun sets well to the south-west.',
  },
  {
    id: 'lake-tyrrell', name: 'Lake Tyrrell', region: 'VIC',
    lat: -35.3600, lon: 142.8000, elevationM: 60,
    openArcs: [[0, 359]], waterHorizon: true, clarity: 0.90,
    note: 'A salt lake that mirrors the entire sky when a film of water sits on the crust.',
  },
  {
    id: 'wilsons-prom', name: 'Wilsons Promontory', region: 'VIC',
    lat: -39.0300, lon: 146.3200, elevationM: 60,
    openArcs: [[200, 60]], waterHorizon: true, clarity: 0.86,
    note: 'Granite headlands at the southern tip of the mainland, open to the west and north.',
  },
  {
    id: 'kunanyi', name: 'kunanyi / Mount Wellington', region: 'TAS',
    lat: -42.8960, lon: 147.2370, elevationM: 1271,
    openArcs: [[0, 359]], waterHorizon: true, clarity: 0.85,
    note: 'A full 360 over the Derwent estuary. Cold, exposed, and worth it.',
  },
  {
    id: 'wineglass', name: 'Wineglass Bay Lookout', region: 'TAS',
    lat: -42.1570, lon: 148.2970, elevationM: 200,
    openArcs: [[20, 170]], waterHorizon: true, clarity: 0.90,
    note: 'Granite saddle above the bay, facing east into the Tasman Sea.',
  },
  {
    id: 'cradle-mountain', name: 'Dove Lake, Cradle Mountain', region: 'TAS',
    lat: -41.6840, lon: 145.9530, elevationM: 940,
    openArcs: [[190, 40]], waterHorizon: true, clarity: 0.88,
    note: 'Still water under dolerite spires. The long southern twilight holds colour for ages.',
  },
  {
    id: 'uluru', name: 'Uluru sunset viewing area', region: 'NT',
    lat: -25.3450, lon: 131.0360, elevationM: 500,
    openArcs: [[0, 359]], waterHorizon: false, clarity: 0.95,
    note: 'The rock takes the colour, not the sky. Desert air is about as clear as it gets.',
  },
  {
    id: 'kata-tjuta', name: 'Kata Tjuta dune viewing', region: 'NT',
    lat: -25.2980, lon: 130.7370, elevationM: 550,
    openArcs: [[0, 359]], waterHorizon: false, clarity: 0.95,
    note: 'Open dune platform with the domes to the west and Uluru behind you.',
  },
  {
    id: 'kings-canyon', name: 'Kings Canyon rim', region: 'NT',
    lat: -24.2560, lon: 131.5670, elevationM: 700,
    openArcs: [[0, 359]], waterHorizon: false, clarity: 0.94,
    note: 'Sandstone walls that go furnace-orange for about ten minutes.',
  },
  {
    id: 'mindil', name: 'Mindil Beach, Darwin', region: 'NT',
    lat: -12.4430, lon: 130.8290, elevationM: 5,
    openArcs: [[200, 340]], waterHorizon: true, clarity: 0.75,
    note: 'Straight west over the Timor Sea. Fast tropical twilight, so do not be late.',
  },
  {
    id: 'cable-beach', name: 'Cable Beach, Broome', region: 'WA',
    lat: -17.9610, lon: 122.2120, elevationM: 6,
    openArcs: [[190, 350]], waterHorizon: true, clarity: 0.88,
    note: 'Twenty-two kilometres of west-facing sand and famously clean dry-season air.',
  },
  {
    id: 'cape-leeuwin', name: 'Cape Leeuwin', region: 'WA',
    lat: -34.3720, lon: 115.1360, elevationM: 20,
    openArcs: [[130, 340]], waterHorizon: true, clarity: 0.85,
    note: 'Where the Indian and Southern oceans meet. Open from south-east right round to north-west.',
  },
  {
    id: 'cape-naturaliste', name: 'Cape Naturaliste', region: 'WA',
    lat: -33.5370, lon: 115.0170, elevationM: 40,
    openArcs: [[230, 60]], waterHorizon: true, clarity: 0.85,
    note: 'North-west facing headland, which keeps working through the summer months.',
  },
  {
    id: 'pinnacles', name: 'The Pinnacles, Nambung', region: 'WA',
    lat: -30.6040, lon: 115.1580, elevationM: 30,
    openArcs: [[200, 340]], waterHorizon: true, clarity: 0.90,
    note: 'Limestone spires that throw metre-long shadows in the last twenty minutes.',
  },
  {
    id: 'cottesloe', name: 'Cottesloe Beach, Perth', region: 'WA',
    lat: -31.9960, lon: 115.7520, elevationM: 5,
    openArcs: [[200, 340]], waterHorizon: true, clarity: 0.55,
    note: 'The most convenient clean western horizon in any Australian capital.',
  },
  {
    id: 'karijini', name: 'Oxer Lookout, Karijini', region: 'WA',
    lat: -22.4810, lon: 118.2900, elevationM: 700,
    openArcs: [[0, 359]], waterHorizon: false, clarity: 0.95,
    note: 'Four gorges meeting under an enormous Pilbara sky.',
  },
  {
    id: 'coral-bay', name: 'Coral Bay, Ningaloo', region: 'WA',
    lat: -23.1430, lon: 113.7660, elevationM: 5,
    openArcs: [[200, 340]], waterHorizon: true, clarity: 0.92,
    note: 'Reef-sheltered water to the west and almost no light pollution in any direction.',
  },
  {
    id: 'bunda-cliffs', name: 'Bunda Cliffs, Nullarbor', region: 'SA',
    lat: -31.5500, lon: 130.5000, elevationM: 90,
    openArcs: [[110, 300]], waterHorizon: true, clarity: 0.96,
    note: 'Ninety metres of vertical limestone above the Southern Ocean, and no one for miles.',
  },
  {
    id: 'wilpena', name: 'Wilpena Pound, Flinders Ranges', region: 'SA',
    lat: -31.5410, lon: 138.5930, elevationM: 500,
    openArcs: [[0, 359]], waterHorizon: false, clarity: 0.94,
    note: 'Ancient quartzite ridges that light up long before the sun clears the horizon.',
  },
  {
    id: 'remarkable-rocks', name: 'Remarkable Rocks, Kangaroo Island', region: 'SA',
    lat: -36.0490, lon: 136.7460, elevationM: 60,
    openArcs: [[160, 320]], waterHorizon: true, clarity: 0.88,
    note: 'Wind-carved granite on a south-west facing dome. Almost purpose-built for backlight.',
  },
  {
    id: 'lake-eyre', name: 'Halligan Point, Kati Thanda', region: 'SA',
    lat: -28.3600, lon: 137.3600, elevationM: 0,
    openArcs: [[0, 359]], waterHorizon: true, clarity: 0.96,
    note: 'Salt pan below sea level. In flood years the reflections are the whole photograph.',
  },
  {
    id: 'whitehaven', name: 'Whitehaven Beach', region: 'QLD',
    lat: -20.2830, lon: 149.0380, elevationM: 5,
    openArcs: [[30, 190]], waterHorizon: true, clarity: 0.88,
    note: 'Silica sand and tidal channels facing east across the Coral Sea.',
  },
  {
    id: 'cape-trib', name: 'Cape Tribulation', region: 'QLD',
    lat: -16.0840, lon: 145.4660, elevationM: 10,
    openArcs: [[20, 180]], waterHorizon: true, clarity: 0.82,
    note: 'Rainforest running into reef. Humid, so expect softer and warmer light.',
  },
  {
    id: 'glass-house', name: 'Glass House Mountains lookout', region: 'QLD',
    lat: -26.8980, lon: 152.9550, elevationM: 220,
    openArcs: [[120, 260]], waterHorizon: false, clarity: 0.70,
    note: 'Volcanic plugs that catch side light beautifully in the last half hour.',
  },
  {
    id: 'punsand', name: 'Punsand Bay, Cape York', region: 'QLD',
    lat: -10.7120, lon: 142.2430, elevationM: 5,
    openArcs: [[250, 30]], waterHorizon: true, clarity: 0.85,
    note: 'The top of the continent, looking north-west over the Torres Strait.',
  },
];

/** Fast lookup by id. */
export const SPOTS_BY_ID = Object.fromEntries(SPOTS.map((s) => [s.id, s]));
