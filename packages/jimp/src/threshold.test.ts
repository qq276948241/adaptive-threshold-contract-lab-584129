import { describe, expect, test } from "vitest";
import { Jimp } from "./index.js";
import type {
  AdaptiveThresholdOptions,
  GreyscaleMethod,
  ThresholdOptions,
} from "./index.js";
import "@jimp/test-utils";

// The declarations shipped by the package must describe both modes, so this
// file (which imports from the public entry point) type-checks them.
const adaptive: AdaptiveThresholdOptions = {
  mode: "adaptive",
  windowWidth: 3,
  windowHeight: 3,
  greyscale: "bt601",
  offset: 2,
};
const method: GreyscaleMethod = "average";
const options: ThresholdOptions[] = [{ max: 128 }, adaptive];
void method;
void options;

/** A flat list of [r, g, b, a] pixels into a Buffer. */
function pixels(width: number, height: number, values: number[][]) {
  const data = Buffer.alloc(width * height * 4);

  values.forEach(([r, g, b, a], index) => {
    data[index * 4] = r!;
    data[index * 4 + 1] = g!;
    data[index * 4 + 2] = b!;
    data[index * 4 + 3] = a!;
  });

  return { width, height, data };
}

describe("threshold (from the main package)", () => {
  test("global threshold is still available on the default Jimp class", () => {
    const image = Jimp.fromBitmap(
      pixels(2, 1, [
        [10, 20, 30, 255],
        [200, 210, 220, 255],
      ]),
    );

    image.threshold({ max: 100, autoGreyscale: false });

    expect([...image.bitmap.data]).toStrictEqual([
      10, 10, 10, 255, 255, 255, 255, 255,
    ]);
  });

  test("adaptive threshold is wired into the default Jimp class", () => {
    const image = Jimp.fromBitmap(
      pixels(4, 1, [
        [0, 0, 0, 255],
        [0, 0, 0, 255],
        [255, 255, 255, 255],
        [255, 255, 255, 255],
      ]),
    );

    image.threshold({
      mode: "adaptive",
      windowWidth: 3,
      windowHeight: 1,
    });

    // Local mean of a 3-wide window; see the plugin reference for the math.
    expect([...image.bitmap.data]).toStrictEqual([
      0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255,
    ]);
  });

  test("is chainable and returns the same image instance", () => {
    const image = Jimp.fromBitmap(
      pixels(3, 3, Array(9).fill([128, 128, 128, 40])),
    );

    const result = image.threshold({
      mode: "adaptive",
      windowWidth: 3,
      windowHeight: 3,
    });

    expect(result).toBe(image);
    // Alpha survives the chain.
    for (let i = 0; i < 9; i++) {
      expect(image.bitmap.data[i * 4 + 3]).toBe(40);
    }
  });

  test("consecutive calls with different windows stay independent", () => {
    const build = () =>
      pixels(5, 2, [
        [0, 0, 0, 255],
        [50, 50, 50, 255],
        [100, 100, 100, 255],
        [150, 150, 150, 255],
        [200, 200, 200, 255],
        [255, 255, 255, 255],
        [70, 70, 70, 128],
        [80, 80, 80, 128],
        [90, 90, 90, 0],
        [100, 100, 100, 0],
      ]);

    const first = Jimp.fromBitmap(build()).threshold({
      mode: "adaptive",
      windowWidth: 1,
      windowHeight: 1,
    });
    const firstResult = [...first.bitmap.data];

    const second = Jimp.fromBitmap(build()).threshold({
      mode: "adaptive",
      windowWidth: 5,
      windowHeight: 2,
    });
    const secondResult = [...second.bitmap.data];

    // Re-running each configuration reproduces its earlier output exactly.
    expect([
      ...Jimp.fromBitmap(build()).threshold({
        mode: "adaptive",
        windowWidth: 1,
        windowHeight: 1,
      }).bitmap.data,
    ]).toStrictEqual(firstResult);
    expect([
      ...Jimp.fromBitmap(build()).threshold({
        mode: "adaptive",
        windowWidth: 5,
        windowHeight: 2,
      }).bitmap.data,
    ]).toStrictEqual(secondResult);
  });
});
