// Time-of-day lighting model. Not geographic — a stylized arc tuned for
// readable comic backgrounds at every hour.

export interface Daylight {
  sunIntensity: number;
  sunColor: string;
  elevationDeg: number; // 0 = horizon
  azimuthDeg: number; // -90 east, +90 west
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  background: string; // fallback bg when no sky image
}

interface Stop {
  t: number;
  sun: number;
  sunColor: [number, number, number];
  sky: [number, number, number];
  ground: [number, number, number];
  hemi: number;
  bg: [number, number, number];
}

const STOPS: Stop[] = [
  { t: 0.0, sun: 0.0, sunColor: [255, 255, 255], sky: [88, 105, 160],  ground: [38, 38, 52],  hemi: 0.45, bg: [22, 28, 52] },
  { t: 5.0, sun: 0.0, sunColor: [255, 170, 110], sky: [110, 120, 175], ground: [48, 44, 56],  hemi: 0.55, bg: [48, 56, 95] },
  { t: 6.0, sun: 1.3, sunColor: [255, 148, 80],  sky: [205, 175, 175], ground: [105, 80, 70], hemi: 0.8,  bg: [215, 160, 128] },
  { t: 8.0, sun: 1.7, sunColor: [255, 218, 175], sky: [205, 222, 250], ground: [130, 120, 108], hemi: 0.95, bg: [150, 190, 230] },
  { t: 12.0, sun: 2.0, sunColor: [255, 246, 232], sky: [210, 228, 255], ground: [140, 134, 122], hemi: 1.05, bg: [140, 185, 235] },
  { t: 16.0, sun: 1.8, sunColor: [255, 234, 198], sky: [206, 220, 248], ground: [134, 124, 110], hemi: 1.0, bg: [150, 185, 225] },
  { t: 18.0, sun: 1.5, sunColor: [255, 152, 76],  sky: [225, 175, 160], ground: [110, 82, 70], hemi: 0.85, bg: [232, 155, 108] },
  { t: 19.5, sun: 0.0, sunColor: [255, 120, 90],  sky: [115, 118, 170], ground: [50, 46, 60],  hemi: 0.6,  bg: [62, 64, 110] },
  { t: 24.0, sun: 0.0, sunColor: [255, 255, 255], sky: [88, 105, 160],  ground: [38, 38, 52],  hemi: 0.45, bg: [22, 28, 52] },
];

function lerp(a: number, b: number, k: number) {
  return a + (b - a) * k;
}
function lerp3(a: [number, number, number], b: [number, number, number], k: number): string {
  const r = Math.round(lerp(a[0], b[0], k));
  const g = Math.round(lerp(a[1], b[1], k));
  const bl = Math.round(lerp(a[2], b[2], k));
  return `rgb(${r},${g},${bl})`;
}

export function daylightAt(t: number): Daylight {
  const h = ((t % 24) + 24) % 24;
  let i = 0;
  while (i < STOPS.length - 2 && STOPS[i + 1].t <= h) i++;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  const k = (h - a.t) / (b.t - a.t);

  // Sun path: rises ~5:00, sets ~19:30, peaks 65 degrees at 12:00 — kept
  // high through the golden hours so dusk shots stay readable.
  const dayFrac = (h - 5) / 14.5;
  const elevation = Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, dayFrac))) * 65);
  const azimuth = lerp(-95, 95, Math.min(1, Math.max(0, dayFrac)));

  return {
    sunIntensity: lerp(a.sun, b.sun, k),
    sunColor: lerp3(a.sunColor, b.sunColor, k),
    elevationDeg: elevation,
    azimuthDeg: azimuth,
    hemiSky: lerp3(a.sky, b.sky, k),
    hemiGround: lerp3(a.ground, b.ground, k),
    hemiIntensity: lerp(a.hemi, b.hemi, k),
    background: lerp3(a.bg, b.bg, k),
  };
}

export function formatHour(t: number): string {
  const h = Math.floor(t);
  const m = Math.round((t - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
