import { expect, test, describe } from "vitest";
import { createJimp } from "@jimp/core";
import jpeg from "@jimp/js-jpeg";
import { methods as hash } from "@jimp/plugin-hash";
import { methods as color } from "@jimp/plugin-color";
import type { Bitmap } from "@jimp/types";
import { getTestImagePath } from "@jimp/test-utils";

import {
  methods as threshold,
  GreyscaleMethodSchema,
  type AdaptiveThresholdOptions,
  type GlobalThresholdOptions,
  type GreyscaleMethod,
  type ThresholdOptions,
} from "./index.js";

// Compile-time checks that the public types describe both modes.
const globalOptions: GlobalThresholdOptions = { max: 128 };
const adaptiveOptions: AdaptiveThresholdOptions = {
  mode: "adaptive",
  windowWidth: 3,
  windowHeight: 3,
};
const method: GreyscaleMethod = "luminance";
const eitherMode: ThresholdOptions[] = [globalOptions, adaptiveOptions];
void method;
void eitherMode;

const jimp = createJimp({
  formats: [jpeg],
  plugins: [threshold, color, hash],
});

// A second class that exposes only the threshold plugin, so the plugin is
// proven to work as a direct import without the rest of Jimp's plugins.
const thresholdOnlyJimp = createJimp({ plugins: [threshold] });

const GREYSCALE_METHODS = {
  luminance: (r: number, g: number, b: number) =>
    0.2126 * r + 0.7152 * g + 0.0722 * b,
  bt601: (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b,
  average: (r: number, g: number, b: number) => (r + g + b) / 3,
  lightness: (r: number, g: number, b: number) =>
    (Math.max(r, g, b) + Math.min(r, g, b)) / 2,
} as const;

/** Build a bitmap from a flat list of [r, g, b, a] pixels. */
function bitmap(width: number, height: number, pixels: number[][]): Bitmap {
  const data = Buffer.alloc(width * height * 4);

  pixels.forEach(([r, g, b, a], index) => {
    data[index * 4] = r!;
    data[index * 4 + 1] = g!;
    data[index * 4 + 2] = b!;
    data[index * 4 + 3] = a!;
  });

  return { width, height, data };
}

/**
 * The naive reference algorithm. It recomputes every window from scratch and
 * is intentionally the slow, obvious version the optimised implementation must
 * match pixel for pixel.
 *
 * Returns the expected RGB values (and leaves alpha alone).
 */
function naiveAdaptiveThreshold(
  source: Bitmap,
  {
    windowWidth,
    windowHeight,
    offset = 0,
    varianceFactor = 0,
    greyscale = "luminance",
    light = 255,
    dark = 0,
  }: Omit<AdaptiveThresholdOptions, "mode">,
) {
  const toLuminance = GREYSCALE_METHODS[greyscale];
  const { width, height, data } = source;
  const luminance = new Float64Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      // The reference rounds to 8-bit luminance, exactly like the plugin.
      luminance[y * width + x] = Math.max(
        0,
        Math.min(
          255,
          Math.round(toLuminance(data[idx]!, data[idx + 1]!, data[idx + 2]!)),
        ),
      );
    }
  }

  const halfWidth = Math.floor(windowWidth / 2);
  const halfHeight = Math.floor(windowHeight / 2);
  const output = Buffer.from(source.data);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - halfWidth);
      const right = Math.min(width, x - halfWidth + windowWidth);
      const top = Math.max(0, y - halfHeight);
      const bottom = Math.min(height, y - halfHeight + windowHeight);

      let total = 0;
      let totalSquared = 0;

      for (let wy = top; wy < bottom; wy++) {
        for (let wx = left; wx < right; wx++) {
          const value = luminance[wy * width + wx]!;
          total += value;
          totalSquared += value * value;
        }
      }

      const count = (right - left) * (bottom - top);
      const mean = total / count;
      const threshold = varianceFactor
        ? mean +
          offset +
          varianceFactor *
            Math.sqrt(Math.max(0, totalSquared / count - mean * mean))
        : mean + offset;

      const value = luminance[y * width + x]! > threshold ? light : dark;
      const idx = (y * width + x) * 4;

      output[idx] = value;
      output[idx + 1] = value;
      output[idx + 2] = value;
    }
  }

  return output;
}

/** Deterministic pseudo-random pixels, including partial and zero alpha. */
function gradientBitmap(width: number, height: number) {
  const pixels: number[][] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.push([
        (x * 37 + y * 11) % 256,
        (x * 5 + y * 53) % 256,
        (x * 97 + y * 7) % 256,
        // A mix of opaque, semi-transparent and fully transparent pixels.
        [255, 128, 1, 0][(x + y) % 4]!,
      ]);
    }
  }

  return bitmap(width, height, pixels);
}

describe("threshold (global)", () => {
  test("defines default threshold for lighter backgrounds", async () => {
    const testImage = await jimp.read(getTestImagePath("hands.jpg"));
    const expectedImage = await jimp.read(
      getTestImagePath("hands_mx200_rp255.jpg"),
    );
    const output = testImage.threshold({ max: 200, replace: 255 }).hash();

    expect(output).toStrictEqual(expectedImage.hash());
  });

  test("keeps the original whole-image behaviour on a known bitmap", () => {
    const source = bitmap(2, 2, [
      [10, 20, 30, 255],
      [200, 210, 220, 255],
      [99, 100, 101, 255],
      [250, 250, 250, 0],
    ]);
    const image = jimp.fromBitmap(source);

    image.threshold({ max: 100, autoGreyscale: false });

    // The global path compares the red channel only, exactly as before.
    expect([...image.bitmap.data]).toStrictEqual([
      10, 10, 10, 255, 255, 255, 255, 255, 99, 99, 99, 255, 255, 255, 255, 0,
    ]);
  });

  test("greyscales with BT.709 by default", () => {
    const source = bitmap(1, 1, [[255, 0, 0, 64]]);
    const image = jimp.fromBitmap(source);

    image.threshold({ max: 200 });

    const grey = Math.round(0.2126 * 255);
    expect([...image.bitmap.data]).toStrictEqual([grey, grey, grey, 64]);
  });

  test("an explicit global mode matches the implicit one", () => {
    const source = gradientBitmap(5, 4);
    const implicit = jimp.fromBitmap(source).threshold({ max: 120 });
    const explicit = jimp
      .fromBitmap(source)
      .threshold({ mode: "global", max: 120 });

    expect([...explicit.bitmap.data]).toStrictEqual([...implicit.bitmap.data]);
  });

  test("rejects invalid global options without touching pixels", () => {
    const source = gradientBitmap(3, 3);
    const image = jimp.fromBitmap(source);
    const before = [...image.bitmap.data];

    expect(() => image.threshold({ max: 300 })).toThrow();
    expect(() => image.threshold({} as never)).toThrow();
    expect([...image.bitmap.data]).toStrictEqual(before);
  });
});

describe("threshold (adaptive)", () => {
  const cases: Array<{
    name: string;
    width: number;
    height: number;
    options: Omit<AdaptiveThresholdOptions, "mode">;
  }> = [
    {
      name: "odd 3x3 window",
      width: 7,
      height: 5,
      options: { windowWidth: 3, windowHeight: 3 },
    },
    {
      name: "even 4x6 window (top-left bias)",
      width: 8,
      height: 6,
      options: { windowWidth: 4, windowHeight: 6 },
    },
    {
      name: "window larger than the image (edge clipping)",
      width: 5,
      height: 4,
      options: { windowWidth: 99, windowHeight: 99, offset: 12 },
    },
    {
      name: "1x1 window",
      width: 4,
      height: 3,
      options: { windowWidth: 1, windowHeight: 1 },
    },
    {
      name: "single-row image",
      width: 9,
      height: 1,
      options: { windowWidth: 3, windowHeight: 3, offset: -4 },
    },
    {
      name: "single-column image",
      width: 1,
      height: 9,
      options: { windowWidth: 5, windowHeight: 5, offset: 4 },
    },
    {
      name: "negative offset with variance factor",
      width: 6,
      height: 6,
      options: {
        windowWidth: 5,
        windowHeight: 5,
        offset: -3,
        varianceFactor: 0.5,
      },
    },
    {
      name: "bt601 greyscale",
      width: 6,
      height: 5,
      options: { windowWidth: 3, windowHeight: 3, greyscale: "bt601" },
    },
    {
      name: "average greyscale",
      width: 6,
      height: 5,
      options: { windowWidth: 3, windowHeight: 3, greyscale: "average" },
    },
    {
      name: "lightness greyscale",
      width: 6,
      height: 5,
      options: { windowWidth: 3, windowHeight: 3, greyscale: "lightness" },
    },
    {
      name: "custom light and dark values",
      width: 7,
      height: 4,
      options: { windowWidth: 3, windowHeight: 3, light: 240, dark: 15 },
    },
  ];

  for (const { name, width, height, options } of cases) {
    test(`matches the naive reference: ${name}`, () => {
      const source = gradientBitmap(width, height);
      const expected = naiveAdaptiveThreshold(source, options);
      const image = jimp.fromBitmap(source);

      image.threshold({ mode: "adaptive", ...options });

      // Exact byte comparison: binary pixels, alpha and everything else.
      expect([...image.bitmap.data]).toStrictEqual([...expected]);
    });
  }

  test("window options alone select the adaptive mode", () => {
    const options = { windowWidth: 3, windowHeight: 3, offset: 2 } as const;
    // `fromBitmap` wraps the buffer it is given, so each call needs its own.
    const implicit = jimp.fromBitmap(gradientBitmap(6, 5)).threshold(options);
    const explicit = jimp
      .fromBitmap(gradientBitmap(6, 5))
      .threshold({ mode: "adaptive", ...options });

    expect([...implicit.bitmap.data]).toStrictEqual([...explicit.bitmap.data]);
  });

  test("preserves alpha and only rewrites RGB", () => {
    const source = bitmap(3, 2, [
      [0, 0, 0, 0],
      [255, 255, 255, 1],
      [128, 128, 128, 64],
      [10, 10, 10, 128],
      [240, 240, 240, 200],
      [100, 100, 100, 255],
    ]);
    const image = jimp.fromBitmap(source);

    image.threshold({
      mode: "adaptive",
      windowWidth: 3,
      windowHeight: 3,
    });

    for (let i = 0; i < source.width * source.height; i++) {
      expect(image.bitmap.data[i * 4 + 3]).toBe(source.data[i * 4 + 3]);
    }

    for (let i = 0; i < source.width * source.height; i++) {
      expect(image.bitmap.data[i * 4]).toBe(image.bitmap.data[i * 4 + 1]);
      expect(image.bitmap.data[i * 4]).toBe(image.bitmap.data[i * 4 + 2]);
      expect([0, 255]).toContain(image.bitmap.data[i * 4]);
    }
  });

  test("alpha does not change the luminance statistics", () => {
    const rgb = [
      [0, 0, 0],
      [255, 255, 255],
      [60, 120, 180],
      [200, 30, 90],
      [128, 128, 128],
      [10, 220, 40],
      [250, 250, 10],
      [90, 90, 90],
      [15, 15, 15],
    ];
    const opaque = bitmap(
      3,
      3,
      rgb.map(([r, g, b]) => [r!, g!, b!, 255]),
    );
    const transparent = bitmap(
      3,
      3,
      rgb.map(([r, g, b], index) => [r!, g!, b!, index % 2 === 0 ? 0 : 96]),
    );
    const options = { windowWidth: 3, windowHeight: 3, offset: 5 } as const;

    const opaqueImage = jimp.fromBitmap(opaque).threshold(options);
    const transparentImage = jimp.fromBitmap(transparent).threshold(options);

    const rgbOf = (image: { bitmap: Bitmap }) =>
      [...image.bitmap.data].filter((_, index) => index % 4 !== 3);

    expect(rgbOf(transparentImage)).toStrictEqual(rgbOf(opaqueImage));
    // The transparent sample keeps exactly the alpha bytes it was given.
    for (let i = 0; i < 9; i++) {
      expect(transparentImage.bitmap.data[i * 4 + 3]).toBe(
        transparent.data[i * 4 + 3],
      );
    }
  });

  test("fully transparent pixels are still measured by their RGB", () => {
    // Every pixel is fully transparent, so an implementation that weights by
    // alpha (or skips transparent pixels entirely) would see a uniform image
    // and produce no light pixels. Their RGB still spans black to white.
    const source = bitmap(4, 1, [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [255, 255, 255, 0],
      [255, 255, 255, 0],
    ]);
    const image = jimp.fromBitmap(source);

    image.threshold({
      mode: "adaptive",
      windowWidth: 3,
      windowHeight: 1,
    });

    // x=0: window [0, 2) mean 0     -> 0 > 0 false -> dark
    // x=1: window [0, 3) mean 85    -> 0 > 85 false -> dark
    // x=2: window [1, 4) mean 170   -> 255 > 170 -> light
    // x=3: window [2, 4) mean 255   -> 255 > 255 false -> dark
    expect([...image.bitmap.data]).toStrictEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 0, 0, 0, 0, 0,
    ]);
  });

  test("a high-contrast edge is resolved from the local window", () => {
    // A dark half and a light half at the centre. With a 3x3 window and no
    // offset, the pixels right of the edge see a local mean below white and
    // become light, the ones left of it see a mean above black and stay dark.
    const pixels: number[][] = [];

    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 6; x++) {
        const value = x < 3 ? 0 : 255;
        pixels.push([value, value, value, 255]);
      }
    }

    const image = jimp.fromBitmap(bitmap(6, 3, pixels));

    image.threshold({ mode: "adaptive", windowWidth: 3, windowHeight: 3 });

    const values: number[][] = [];
    for (let y = 0; y < 3; y++) {
      const row: number[] = [];
      for (let x = 0; x < 6; x++) {
        row.push(image.bitmap.data[(y * 6 + x) * 4]!);
      }
      values.push(row);
    }

    // x=2 has its 3-wide window over columns 1-3 (0, 0, 255): local mean 85,
    // so the black pixel stays dark. x=3 has its window over columns 2-4
    // (0, 255, 255): local mean 170, so the white pixel becomes light. x=4 is
    // surrounded by white (mean 255) and does not exceed it, so it stays dark.
    expect(values).toStrictEqual([
      [0, 0, 0, 255, 0, 0],
      [0, 0, 0, 255, 0, 0],
      [0, 0, 0, 255, 0, 0],
    ]);
  });

  test("only RGB bytes are modified, and only inside the bitmap", () => {
    const source = gradientBitmap(5, 4);
    const image = jimp.fromBitmap(source);
    const { data, width, height } = image.bitmap;
    const length = data.length;
    const original = Buffer.from(data);

    image.threshold({ mode: "adaptive", windowWidth: 3, windowHeight: 3 });

    // The bitmap is the same object, same size; nothing outside it grew.
    expect(image.bitmap.data).toBe(data);
    expect(image.bitmap.data.length).toBe(length);
    expect(image.bitmap.data.length).toBe(width * height * 4);

    // Per pixel: alpha byte unchanged, all three RGB bytes changed together.
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      expect(data[idx + 3]).toBe(original[idx + 3]);
      expect(data[idx]).toBe(data[idx + 1]);
      expect(data[idx]).toBe(data[idx + 2]);
    }
  });

  test("a 1x1 window marks every pixel dark", () => {
    const source = gradientBitmap(4, 3);
    const image = jimp.fromBitmap(source);

    image.threshold({ mode: "adaptive", windowWidth: 1, windowHeight: 1 });

    // The local mean is the pixel itself, so `value > mean` is never true.
    // A zero offset therefore has to produce a deterministic all-dark result.
    for (let i = 0; i < source.width * source.height; i++) {
      expect(image.bitmap.data[i * 4]).toBe(0);
    }
  });

  test("an empty image is left untouched", () => {
    const image = jimp.fromBitmap({
      width: 0,
      height: 0,
      data: Buffer.alloc(0),
    });

    expect(() =>
      image.threshold({ mode: "adaptive", windowWidth: 3, windowHeight: 3 }),
    ).not.toThrow();
    expect(image.bitmap.data.length).toBe(0);
  });

  test("consecutive calls do not share state or change earlier results", () => {
    const image = jimp.fromBitmap(gradientBitmap(9, 7));

    image.threshold({ mode: "adaptive", windowWidth: 3, windowHeight: 3 });
    const first = [...image.bitmap.data];

    // The second call runs on the already-binarised pixels, so its expected
    // output is the naive algorithm applied to the first result.
    image.threshold({ mode: "adaptive", windowWidth: 7, windowHeight: 5 });
    const second = [...image.bitmap.data];

    expect(second).toStrictEqual([
      ...naiveAdaptiveThreshold(
        { width: 9, height: 7, data: Buffer.from(first) },
        { windowWidth: 7, windowHeight: 5 },
      ),
    ]);

    // A fresh image processed with the first parameters reproduces the first
    // result exactly; nothing leaked from the 7x5 call or the second image.
    // (A new bitmap is built because `fromBitmap` wraps the input buffer.)
    const other = jimp
      .fromBitmap(gradientBitmap(9, 7))
      .threshold({ mode: "adaptive", windowWidth: 3, windowHeight: 3 });

    expect([...other.bitmap.data]).toStrictEqual(first);
    // And the image that ran the 7x5 call is exactly where that call left it.
    expect([...image.bitmap.data]).toStrictEqual(second);
  });

  test("reprocessing a result is deterministic", () => {
    const source = gradientBitmap(5, 5);
    const image = jimp.fromBitmap(source);

    image.threshold({ mode: "adaptive", windowWidth: 3, windowHeight: 3 });
    const first = [...image.bitmap.data];

    image.threshold({ mode: "adaptive", windowWidth: 3, windowHeight: 3 });

    expect([...image.bitmap.data]).toStrictEqual(first);
  });

  test("large images do not rescan the window per pixel", () => {
    // A naive O(pixels * windowArea) implementation would need ~10^9 inner
    // operations here. The summed-area-table version is O(pixels).
    const size = 300;
    const source = gradientBitmap(size, size);
    const image = jimp.fromBitmap(source);

    const start = performance.now();
    image.threshold({
      mode: "adaptive",
      windowWidth: 151,
      windowHeight: 151,
    });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(3000);
  });

  test("rejects invalid sizes and offsets without touching pixels", () => {
    const source = gradientBitmap(4, 4);
    const image = jimp.fromBitmap(source);
    const before = [...image.bitmap.data];

    const invalidOptions: unknown[] = [
      { mode: "adaptive", windowWidth: 0, windowHeight: 3 },
      { mode: "adaptive", windowWidth: -2, windowHeight: 3 },
      { mode: "adaptive", windowWidth: 2.5, windowHeight: 3 },
      { mode: "adaptive", windowWidth: 3 },
      { mode: "adaptive", windowHeight: 3 },
      { mode: "adaptive", windowWidth: 3, windowHeight: 3, offset: NaN },
      {
        mode: "adaptive",
        windowWidth: 3,
        windowHeight: 3,
        offset: Infinity,
      },
      {
        mode: "adaptive",
        windowWidth: 3,
        windowHeight: 3,
        varianceFactor: NaN,
      },
      {
        mode: "adaptive",
        windowWidth: 3,
        windowHeight: 3,
        greyscale: "sepia",
      },
      { mode: "adaptive", windowWidth: 3, windowHeight: 3, max: 128 },
      { mode: "nope", max: 128 },
      { windowWidth: 0, windowHeight: 0 },
      { mode: "global", max: 128, windowWidth: 3, windowHeight: 3 },
      { mode: "global", max: 128, windowWidth: 3 },
    ];

    for (const options of invalidOptions) {
      expect(() => image.threshold(options as never)).toThrow();
      expect([...image.bitmap.data]).toStrictEqual(before);
    }
  });

  test("every supported greyscale method is exported", () => {
    expect(GreyscaleMethodSchema.options).toStrictEqual([
      "luminance",
      "bt601",
      "average",
      "lightness",
    ]);
  });

  test("works when the plugin is imported directly, without other plugins", () => {
    const source = gradientBitmap(6, 5);
    const options = { windowWidth: 3, windowHeight: 3, offset: 4 } as const;
    // Use the constructor rather than `fromBitmap`: small Buffers come from
    // Node's shared pool and `fromBitmap` wraps the pool's whole ArrayBuffer.
    const direct = new thresholdOnlyJimp(source).threshold(options);
    const assembled = new jimp({
      ...source,
      data: Buffer.from(source.data),
    }).threshold(options);

    expect([...direct.bitmap.data]).toStrictEqual([...assembled.bitmap.data]);
    expect([...direct.bitmap.data]).toStrictEqual([
      ...naiveAdaptiveThreshold(source, options),
    ]);
  });
});
