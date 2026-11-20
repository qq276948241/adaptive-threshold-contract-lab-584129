<div align="center">
  <img width="200" height="200"
    src="https://s3.amazonaws.com/pix.iemoji.com/images/emoji/apple/ios-11/256/crayon.png">
  <h1>@jimp/plugin-threshold</h1>
  <p>Applies a global or adaptive (local) threshold.</p>
</div>

This is useful as a simplified method for processing scanned drawings, signatures, documents and photos with uneven lighting or shadows.

- [threshold](http://jimp-dev.github.io/jimp/api/jimp/classes/jimp#threshold)

## Global threshold

```ts
image.threshold({ max: 150 });
```

Pixels below `max` keep their value, pixels at or above it become `replace`
(default `255`). The image is converted to grayscale first unless
`autoGreyscale: false` is passed. This is the original behaviour and is
unchanged.

## Adaptive threshold

```ts
image.threshold({
  mode: "adaptive",
  windowWidth: 15,
  windowHeight: 15,
  offset: 10,
});
```

Each pixel is compared against the luminance statistics of the window around
it, so the threshold follows the local background instead of one global value.
Passing `windowWidth`/`windowHeight` is enough to select this mode; `mode` is
optional.

| Option           | Default       | Meaning                                                                             |
| ---------------- | ------------- | ----------------------------------------------------------------------------------- |
| `windowWidth`    | _(required)_  | Window width in pixels. Positive integer, may be larger than the image.             |
| `windowHeight`   | _(required)_  | Window height in pixels. Positive integer, may be larger than the image.            |
| `offset`         | `0`           | Constant added to the local threshold.                                              |
| `varianceFactor` | `0`           | Weight of the local standard deviation (Niblack-style). `0` yields `mean + offset`. |
| `greyscale`      | `"luminance"` | `luminance` (BT.709), `bt601`, `average` or `lightness`.                            |
| `light`          | `255`         | Value written to pixels above the threshold.                                        |
| `dark`           | `0`           | Value written to pixels at or below the threshold.                                  |

Semantics:

- **Alpha is never part of the luminance calculation and is preserved byte for
  byte.** Fully and partially transparent pixels are measured by their RGB.
- **Edge windows are clipped** to the image and only in-bounds pixels are
  counted, so `count` is never zero.
- **Even window sizes are allowed.** The window is anchored at
  `x - floor(windowWidth / 2)`, `y - floor(windowHeight / 2)`, i.e. a 4px window
  covers `[x - 2, x + 1]`.
- Local means and variances are computed from summed-area tables, so every
  pixel costs O(1) regardless of the window size and no workspace is shared
  between calls.
- Invalid options (non-positive or fractional window sizes, non-finite
  offsets, unknown `greyscale` values, mixing `max` with adaptive options) are
  rejected before any pixel is modified.
