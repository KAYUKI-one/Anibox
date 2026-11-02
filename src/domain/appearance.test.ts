import { describe, it, expect } from 'vitest';
import { analyzePixels, coverCrop } from './appearance';
import { emptyData, parseData } from './storage';

describe('background crop and glass preferences', () => {
  it('covers wide and tall frames without changing image proportions', () => {
    for (const [iw, ih, fw, fh] of [
      [1600, 400, 900, 700],
      [400, 1600, 1100, 700],
      [1000, 1000, 900, 600],
    ]) {
      const crop = coverCrop(iw, ih, fw, fh);
      expect((iw * crop.width) / (ih * crop.height)).toBeCloseTo(fw / fh, 8);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(1.000001);
      expect(crop.y + crop.height).toBeLessThanOrEqual(1.000001);
    }
  });
  it('retains a detailed subject near the edge instead of blank image center', () => {
    const width = 120,
      height = 40,
      pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const shade = x > 85 && y > 5 && y < 35 ? ((x + y) % 2) * 255 : 30;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = shade;
        pixels[i + 3] = 255;
      }
    const crop = coverCrop(width, height, 500, 500, undefined, analyzePixels(pixels, width, height));
    expect(crop.focus.x).toBeGreaterThan(0.7);
    expect(crop.x + crop.width).toBeGreaterThan(0.95);
  });
  it('clamps manual focus while retaining a full cover crop', () => {
    const crop = coverCrop(400, 1600, 1000, 700, { x: 2, y: -1 });
    expect(crop.focus).toEqual({ x: 1, y: 0 });
    expect(crop.y).toBe(0);
    expect(crop.positionY).toBe(0);
  });
  it('updates the old default while retaining explicit custom opacity', () => {
    const data = emptyData();
    delete data.settings.appearanceVersion;
    data.settings.appearance = { home: { opacity: 78, blur: 0 }, nodes: { opacity: 90, blur: 0 } };
    const migrated = parseData(JSON.stringify(data));
    expect(migrated.settings.appearance.home!.opacity).toBe(54);
    expect(migrated.settings.appearance.nodes!.opacity).toBe(90);
    migrated.settings.appearance.home!.opacity = 78;
    expect(parseData(JSON.stringify(migrated)).settings.appearance.home!.opacity).toBe(78);
  });
});
