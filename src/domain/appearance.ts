export interface FocusPoint {
  x: number;
  y: number;
}
export interface ImageAnalysis {
  columns: number[];
  rows: number[];
}
export const DEFAULT_OPACITY = 54;
export const MIN_OPACITY = 28;
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function analyzePixels(pixels: Uint8ClampedArray, width: number, height: number): ImageAnalysis {
  const columns = new Array<number>(width).fill(0);
  const rows = new Array<number>(height).fill(0);
  const light = (x: number, y: number) => {
    const i = (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;
    return (pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722) / 255;
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const edge = Math.abs(light(x + 1, y) - light(x - 1, y)) + Math.abs(light(x, y + 1) - light(x, y - 1));
      const chroma =
        (Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) -
          Math.min(pixels[index], pixels[index + 1], pixels[index + 2])) /
        255;
      const prior = 0.5 + 0.5 * (1 - Math.min(1, Math.hypot(x / width - 0.5, y / height - 0.5)));
      const score = ((edge + chroma * 0.08 + 0.002) * prior * pixels[index + 3]) / 255;
      columns[x] += score;
      rows[y] += score;
    }
  return { columns, rows };
}

function bestCenter(energy: number[], fraction: number): number {
  if (!energy.length || fraction >= 0.999) return 0.5;
  const length = Math.max(1, Math.round(energy.length * fraction));
  const total = energy.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0.5;
  let sum = energy.slice(0, length).reduce((a, b) => a + b, 0);
  let best = -Infinity,
    center = 0.5;
  for (let start = 0; start <= energy.length - length; start++) {
    if (start) sum += energy[start + length - 1] - energy[start - 1];
    const candidate = (start + length / 2) / energy.length;
    const score = sum - total * 0.06 * Math.abs(candidate - 0.5);
    if (score > best) {
      best = score;
      center = candidate;
    }
  }
  return center;
}

export function coverCrop(
  imageWidth: number,
  imageHeight: number,
  frameWidth: number,
  frameHeight: number,
  point?: FocusPoint,
  analysis?: ImageAnalysis,
) {
  const imageAspect = imageWidth / Math.max(1, imageHeight);
  const frameAspect = frameWidth / Math.max(1, frameHeight);
  const width = Math.min(1, frameAspect / imageAspect);
  const height = Math.min(1, imageAspect / frameAspect);
  const focus = point
    ? {
        x: clamp(Number.isFinite(point.x) ? point.x : 0.5, 0, 1),
        y: clamp(Number.isFinite(point.y) ? point.y : 0.5, 0, 1),
      }
    : {
        x: analysis ? bestCenter(analysis.columns, width) : 0.5,
        y: analysis ? bestCenter(analysis.rows, height) : 0.5,
      };
  const x = clamp(focus.x - width / 2, 0, 1 - width);
  const y = clamp(focus.y - height / 2, 0, 1 - height);
  return {
    x,
    y,
    width,
    height,
    focus,
    positionX: width >= 0.999999 ? 50 : (x / (1 - width)) * 100,
    positionY: height >= 0.999999 ? 50 : (y / (1 - height)) * 100,
  };
}
