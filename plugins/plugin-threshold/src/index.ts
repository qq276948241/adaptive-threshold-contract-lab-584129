import { JimpClass } from "@jimp/types";
import { limit255 } from "@jimp/utils";
import { methods as color } from "@jimp/plugin-color";
import { z } from "zod";

/**
 * The ways to reduce an RGB pixel to a single luminance value.
 *
 * - `luminance`: ITU-R BT.709 (`0.2126 R + 0.7152 G + 0.0722 B`). This is the
 *   same conversion `greyscale()` uses, so it is the default.
 * - `bt601`: ITU-R BT.601 (`0.299 R + 0.587 G + 0.114 B`).
 * - `average`: the plain mean of the three channels.
 * - `lightness`: the midpoint between the brightest and darkest channel.
 *
 * None of the conversions look at alpha; the alpha channel is preserved byte
 * for byte.
 */
export const GreyscaleMethodSchema = z.enum([
  "luminance",
  "bt601",
  "average",
  "lightness",
]);

export type GreyscaleMethod = z.infer<typeof GreyscaleMethodSchema>;

const GlobalThresholdOptionsSchema = z.object({
  /** Use the classic, whole-image threshold. This is the default mode. */
  mode: z.literal("global").optional(),
  /** A number auto limited between 0 - 255 */
  max: z.number().min(0).max(255),
  /** A number auto limited between 0 - 255 (default 255)  */
  replace: z.number().min(0).max(255).optional(),
  /** A boolean whether to apply greyscale beforehand (default true)  */
  autoGreyscale: z.boolean().optional(),
});

export type GlobalThresholdOptions = z.infer<
  typeof GlobalThresholdOptionsSchema
>;

const AdaptiveThresholdOptionsSchema = z.object({
  /** Use a per-pixel threshold derived from a local window. */
  mode: z.literal("adaptive").optional(),
  /**
   * Width of the neighbourhood window in pixels.
   *
   * Must be a positive integer. Windows wider than the image are allowed; the
   * window is clipped to the image and only in-bounds pixels are counted.
   */
  windowWidth: z.number().int().min(1),
  /** Height of the neighbourhood window in pixels. See `windowWidth`. */
  windowHeight: z.number().int().min(1),
  /**
   * Constant added to the local threshold (default 0). Positive values push
   * more pixels towards `dark`, negative values towards `light`.
   */
  offset: z.number().finite().optional(),
  /**
   * Weight of the local standard deviation in the threshold (default 0).
   *
   * With the default of `0` the threshold is `mean + offset`, which matches
   * OpenCV's `ADAPTIVE_THRESH_MEAN_C`. A non-zero value switches to a
   * Niblack-style threshold: `mean + offset + varianceFactor * stdDev`.
   */
  varianceFactor: z.number().finite().optional(),
  /** How RGB is converted to luminance (default `luminance`). */
  greyscale: GreyscaleMethodSchema.optional(),
  /** Value written to pixels above the local threshold (default 255). */
  light: z.number().min(0).max(255).optional(),
  /** Value written to pixels at or below the local threshold (default 0). */
  dark: z.number().min(0).max(255).optional(),
});

export type AdaptiveThresholdOptions = z.infer<
  typeof AdaptiveThresholdOptionsSchema
>;

/**
 * Options accepted by `threshold()`.
 *
 * Omitting `mode` keeps the classic global threshold. Passing
 * `mode: "adaptive"` (or just a `windowWidth`/`windowHeight` pair) selects the
 * adaptive mode.
 */
export type ThresholdOptions =
  | GlobalThresholdOptions
  | AdaptiveThresholdOptions;

const GREYSCALE_METHODS: Record<
  GreyscaleMethod,
  (r: number, g: number, b: number) => number
> = {
  luminance: (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b,
  bt601: (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b,
  average: (r, g, b) => (r + g + b) / 3,
  lightness: (r, g, b) => (Math.max(r, g, b) + Math.min(r, g, b)) / 2,
};

/**
 * Reduce one pixel to an 8-bit integer luminance.
 *
 * Rounding to an integer keeps the window sums exact (and therefore
 * reproducible regardless of summation order), which is what makes the
 * summed-area-table implementation bit-identical to the naive reference.
 */
function pixelLuminance(
  toLuminance: (r: number, g: number, b: number) => number,
  r: number,
  g: number,
  b: number,
) {
  return limit255(Math.round(toLuminance(r, g, b)));
}

interface ParsedThresholdOptions {
  mode: "global" | "adaptive";
  global?: z.infer<typeof GlobalThresholdOptionsSchema>;
  adaptive?: z.infer<typeof AdaptiveThresholdOptionsSchema>;
}

/**
 * Validate the options and pick the mode.
 *
 * All validation happens here, before a single pixel is touched, so a rejected
 * call can never leave the image half-modified.
 */
function parseThresholdOptions(
  options: ThresholdOptions,
): ParsedThresholdOptions {
  if (typeof options !== "object" || options === null) {
    throw new Error("threshold options must be an object");
  }

  const rawMode = (options as { mode?: unknown }).mode;
  const hasWindow =
    (options as { windowWidth?: unknown }).windowWidth !== undefined ||
    (options as { windowHeight?: unknown }).windowHeight !== undefined;
  const inferredMode =
    rawMode === undefined ? (hasWindow ? "adaptive" : "global") : rawMode;

  const mode = z.enum(["global", "adaptive"]).parse(inferredMode);

  if (mode === "adaptive") {
    // The global `max` has no meaning in adaptive mode. Reject the mix instead
    // of silently ignoring one of the two, so callers cannot believe a global
    // cutoff was applied to an adaptive result.
    if ("max" in options) {
      throw new Error(
        "max cannot be combined with adaptive threshold options; use offset instead",
      );
    }

    return {
      mode,
      adaptive: AdaptiveThresholdOptionsSchema.parse({
        ...options,
        mode,
      }),
    };
  }

  rejectWindowOptionsInGlobalMode(options);

  return {
    mode,
    global: GlobalThresholdOptionsSchema.parse({ ...options, mode }),
  };
}

/**
 * `windowWidth`/`windowHeight` only make sense in adaptive mode. Rejecting the
 * mix keeps an explicit `mode: "global"` from silently discarding them.
 */
function rejectWindowOptionsInGlobalMode(options: ThresholdOptions) {
  if (
    (options as { windowWidth?: unknown }).windowWidth !== undefined ||
    (options as { windowHeight?: unknown }).windowHeight !== undefined
  ) {
    throw new Error("windowWidth and windowHeight require mode: 'adaptive'");
  }
}

/**
 * Sum of a right-open rectangle of a summed-area table.
 */
function integralRect(
  integral: Float64Array,
  stride: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  return (
    integral[bottom * stride + right]! -
    integral[top * stride + right]! -
    integral[bottom * stride + left]! +
    integral[top * stride + left]!
  );
}

function applyAdaptiveThreshold<I extends JimpClass>(
  image: I,
  options: z.infer<typeof AdaptiveThresholdOptionsSchema>,
): I {
  const {
    windowWidth,
    windowHeight,
    offset = 0,
    varianceFactor = 0,
    greyscale = "luminance",
    light: lightArg = 255,
    dark: darkArg = 0,
  } = options;

  const { data, width, height } = image.bitmap;

  // An empty image has nothing to threshold. Bail out before allocating any
  // workspace or touching the bitmap.
  if (width <= 0 || height <= 0) {
    return image;
  }

  const light = limit255(lightArg);
  const dark = limit255(darkArg);
  const toLuminance = GREYSCALE_METHODS[greyscale];

  const pixelCount = width * height;
  const stride = width + 1;

  // Per-call workspace:
  // - one byte per pixel of 8-bit luminance,
  // - two summed-area tables of luminance and luminance squared, built once so
  //   every window query is O(1) and a large image never rescans a window per
  //   pixel.
  // Nothing is shared between calls or between different window parameters.
  const luminance = new Uint8Array(pixelCount);
  const sum = new Float64Array(stride * (height + 1));
  const sumSquared = new Float64Array(stride * (height + 1));

  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    let rowSumSquared = 0;

    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) << 2;
      const value = pixelLuminance(
        toLuminance,
        data[idx]!,
        data[idx + 1]!,
        data[idx + 2]!,
      );

      luminance[y * width + x] = value;
      rowSum += value;
      rowSumSquared += value * value;

      const integralIdx = (y + 1) * stride + (x + 1);
      sum[integralIdx] = sum[y * stride + (x + 1)]! + rowSum;
      sumSquared[integralIdx] =
        sumSquared[y * stride + (x + 1)]! + rowSumSquared;
    }
  }

  // The window is anchored at `x - floor(windowWidth / 2)` and
  // `y - floor(windowHeight / 2)`. That centres odd windows and gives a
  // deterministic, documented bias towards the top-left for even windows
  // (a 4px window covers [x - 2, x + 1]).
  const halfWidth = Math.floor(windowWidth / 2);
  const halfHeight = Math.floor(windowHeight / 2);

  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - halfHeight);
    const bottom = Math.min(height, y - halfHeight + windowHeight);

    for (let x = 0; x < width; x++) {
      // Clipping the window to the image means edge pixels are measured
      // against the pixels that actually exist; `count` is never zero.
      const left = Math.max(0, x - halfWidth);
      const right = Math.min(width, x - halfWidth + windowWidth);
      const count = (right - left) * (bottom - top);

      const total = integralRect(sum, stride, left, top, right, bottom);
      const totalSquared = integralRect(
        sumSquared,
        stride,
        left,
        top,
        right,
        bottom,
      );

      const mean = total / count;
      const threshold = varianceFactor
        ? mean +
          offset +
          varianceFactor *
            Math.sqrt(Math.max(0, totalSquared / count - mean * mean))
        : mean + offset;

      // Replace the luminance with the binary decision. Only the current
      // pixel is read here, so overwriting in place is safe. Decisions are
      // stored, not written to the bitmap, so an unexpected failure while
      // computing can never leave a half-thresholded image behind.
      luminance[y * width + x] = luminance[y * width + x]! > threshold ? 1 : 0;
    }
  }

  for (let i = 0; i < pixelCount; i++) {
    const value = luminance[i] ? light : dark;
    const idx = i << 2;

    data[idx] = value;
    data[idx + 1] = value;
    data[idx + 2] = value;
    // `data[idx + 3]` is intentionally left untouched.
  }

  return image;
}

export const methods = {
  /**
   * Applies a minimum color threshold to a grayscale image.
   * Converts image to grayscale by default.
   *
   * Pass `mode: "adaptive"` (or a `windowWidth`/`windowHeight` pair) to
   * threshold each pixel against the luminance statistics of its local
   * neighbourhood instead of one global `max`. This is what scanned documents
   * and shadowed photos need: the threshold follows the local background.
   *
   * Adaptive mode writes the binary `light`/`dark` values to RGB and leaves
   * alpha untouched. Windows beyond the image edge are clipped and only
   * in-bounds pixels are counted. Window sizes must be positive integers;
   * even sizes are allowed and anchored at `x - floor(windowWidth / 2)`.
   *
   * @example
   * ```ts
   * import { Jimp } from "jimp";
   *
   * const image = await Jimp.read("test/image.png");
   *
   * image.threshold({ max: 150 });
   *
   * // Adaptive: 15x15 window, threshold the local mean + 10
   * image.threshold({
   *   mode: "adaptive",
   *   windowWidth: 15,
   *   windowHeight: 15,
   *   offset: 10,
   * });
   * ```
   */
  threshold<I extends JimpClass>(image: I, options: ThresholdOptions) {
    const parsed = parseThresholdOptions(options);

    if (parsed.mode === "adaptive") {
      return applyAdaptiveThreshold(image, parsed.adaptive!);
    }

    let {
      max,
      replace = 255,
      // eslint-disable-next-line prefer-const
      autoGreyscale = true,
    } = parsed.global!;

    max = limit255(max);
    replace = limit255(replace);

    if (autoGreyscale) {
      color.greyscale(image);
    }

    image.scan((_, __, idx) => {
      const grey =
        image.bitmap.data[idx]! < max ? image.bitmap.data[idx]! : replace;

      image.bitmap.data[idx] = grey;
      image.bitmap.data[idx + 1] = grey;
      image.bitmap.data[idx + 2] = grey;
    });

    return image;
  },
};
