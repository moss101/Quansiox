'use strict';
/**
 * Image operations — real pixel work, no image library.
 *
 * The design surface needs to change pixels: upscale an image, cut a
 * background out, adjust a marked region, crop, rotate, composite another
 * image on top. None of that needs a native dependency: a PNG decoder and
 * encoder already live in `shared/png.js`, and everything here operates on a
 * straight RGBA buffer.
 *
 * Formats other than PNG (JPEG, HEIC, WebP) are converted to PNG first by
 * the renderer, so the decoder only ever sees PNG in practice — but it
 * handles the common PNG variants anyway.
 */
const { decodePNG, encodePNG } = require('./png');

/* ------------------------------------------------------------------ basics */

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

/** A blank RGBA image. */
function createImage(width, height, fill = [0, 0, 0, 0]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = fill[3];
  }
  return { width, height, data };
}

function getPixel(image, x, y) {
  const index = (y * image.width + x) * 4;
  return [image.data[index], image.data[index + 1], image.data[index + 2], image.data[index + 3]];
}

function setPixel(image, x, y, [r, g, b, a]) {
  const index = (y * image.width + x) * 4;
  image.data[index] = clamp(Math.round(r), 0, 255);
  image.data[index + 1] = clamp(Math.round(g), 0, 255);
  image.data[index + 2] = clamp(Math.round(b), 0, 255);
  image.data[index + 3] = clamp(Math.round(a), 0, 255);
}

/* ------------------------------------------------------------------ resize */

/**
 * Bilinear resize. Good enough for previews and upscaling, and it never
 * introduces ringing.
 */
function resize(image, width, height) {
  const target = createImage(width, height);
  const scaleX = image.width / width;
  const scaleY = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const sourceY = clamp((y + 0.5) * scaleY - 0.5, 0, image.height - 1);
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(y0 + 1, image.height - 1);
    const wy = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = clamp((x + 0.5) * scaleX - 0.5, 0, image.width - 1);
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(x0 + 1, image.width - 1);
      const wx = sourceX - x0;
      const p00 = getPixel(image, x0, y0);
      const p10 = getPixel(image, x1, y0);
      const p01 = getPixel(image, x0, y1);
      const p11 = getPixel(image, x1, y1);
      const out = [0, 0, 0, 0];
      for (let channel = 0; channel < 4; channel += 1) {
        const top = p00[channel] * (1 - wx) + p10[channel] * wx;
        const bottom = p01[channel] * (1 - wx) + p11[channel] * wx;
        out[channel] = top * (1 - wy) + bottom * wy;
      }
      setPixel(target, x, y, out);
    }
  }
  return target;
}

/** Upscale by an integer factor with a smoother (bicubic-ish) kernel. */
function upscale(image, factor = 2) {
  const width = Math.round(image.width * factor);
  const height = Math.round(image.height * factor);
  const target = createImage(width, height);
  const scaleX = image.width / width;
  const scaleY = image.height / height;
  // A separable cubic kernel (Catmull-Rom) — noticeably crisper than
  // bilinear when you blow an image up.
  const cubic = (t) => {
    const x = Math.abs(t);
    if (x < 1) return (1.5 * x * x * x) - (2.5 * x * x) + 1;
    if (x < 2) return (-0.5 * x * x * x) + (2.5 * x * x) - (4 * x) + 2;
    return 0;
  };
  const sample = (channel, x, y) => {
    const sx = clamp(x, 0, image.width - 1);
    const sy = clamp(y, 0, image.height - 1);
    return getPixel(image, Math.round(sx), Math.round(sy))[channel];
  };
  for (let y = 0; y < height; y += 1) {
    const sourceY = (y + 0.5) * scaleY - 0.5;
    const y0 = Math.floor(sourceY);
    for (let x = 0; x < width; x += 1) {
      const sourceX = (x + 0.5) * scaleX - 0.5;
      const x0 = Math.floor(sourceX);
      const out = [0, 0, 0, 0];
      for (let channel = 0; channel < 4; channel += 1) {
        let sum = 0;
        let weight = 0;
        for (let j = -1; j <= 2; j += 1) {
          const wy = cubic(sourceY - (y0 + j));
          for (let i = -1; i <= 2; i += 1) {
            const wx = cubic(sourceX - (x0 + i));
            const w = wx * wy;
            sum += sample(channel, x0 + i, y0 + j) * w;
            weight += w;
          }
        }
        out[channel] = weight ? sum / weight : 0;
      }
      setPixel(target, x, y, out);
    }
  }
  return target;
}

/* ------------------------------------------------------------------- crop */

function crop(image, region) {
  const x = clamp(Math.round(region.x ?? 0), 0, image.width - 1);
  const y = clamp(Math.round(region.y ?? 0), 0, image.height - 1);
  const w = clamp(Math.round(region.width ?? image.width - x), 1, image.width - x);
  const h = clamp(Math.round(region.height ?? image.height - y), 1, image.height - y);
  const out = createImage(w, h);
  for (let row = 0; row < h; row += 1) {
    const sourceStart = ((y + row) * image.width + x) * 4;
    image.data.copy(out.data, row * w * 4, sourceStart, sourceStart + w * 4);
  }
  return out;
}

/* ----------------------------------------------------------------- rotate */

function rotate(image, degrees) {
  const normalized = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
  if (normalized === 0) return image;
  const swap = normalized === 90 || normalized === 270;
  const width = swap ? image.height : image.width;
  const height = swap ? image.width : image.height;
  const out = createImage(width, height);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const pixel = getPixel(image, x, y);
      if (normalized === 90) setPixel(out, image.height - 1 - y, x, pixel);
      else if (normalized === 180) setPixel(out, image.width - 1 - x, image.height - 1 - y, pixel);
      else setPixel(out, y, image.width - 1 - x, pixel);
    }
  }
  return out;
}

/* -------------------------------------------------------------- adjustment */

/**
 * Adjust a region (or the whole image).
 *
 * `brightness` −1..1, `contrast` −1..1, `saturation` 0..2,
 * `hue` −180..180 (degrees), `tint` a hex colour and `tintAmount` 0..1,
 * `blur` 0..20 (a box blur radius).
 */
function adjust(image, region = null, options = {}) {
  const {
    brightness = 0, contrast = 0, saturation = 1, hue = 0, tint = null, tintAmount = 0, blur = 0,
  } = options;
  const x0 = clamp(Math.round(region?.x ?? 0), 0, image.width - 1);
  const y0 = clamp(Math.round(region?.y ?? 0), 0, image.height - 1);
  const x1 = clamp(Math.round(region?.x + (region?.width ?? image.width)), x0 + 1, image.width);
  const y1 = clamp(Math.round(region?.y + (region?.height ?? image.height)), y0 + 1, image.height);

  const tintRgb = tint ? hexToRgb(tint) : null;
  const hueRadians = (hue * Math.PI) / 180;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      let [r, g, b] = getPixel(image, x, y);
      // Brightness
      if (brightness) {
        r += brightness * 255; g += brightness * 255; b += brightness * 255;
      }
      // Contrast
      if (contrast) {
        const factor = (259 * (contrast * 255 + 255)) / (255 * (259 - contrast * 255));
        r = factor * (r - 128) + 128;
        g = factor * (g - 128) + 128;
        b = factor * (b - 128) + 128;
      }
      // Saturation (Rec. 709 luma)
      if (saturation !== 1) {
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = luma + (r - luma) * saturation;
        g = luma + (g - luma) * saturation;
        b = luma + (b - luma) * saturation;
      }
      // Hue rotation (in YIQ space, which keeps luminance)
      if (hue) {
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const i = 0.596 * r - 0.274 * g - 0.322 * b;
        const q = 0.211 * r - 0.523 * g + 0.312 * b;
        const cosHue = Math.cos(hueRadians);
        const sinHue = Math.sin(hueRadians);
        const newI = i * cosHue - q * sinHue;
        const newQ = i * sinHue + q * cosHue;
        r = luma + 0.956 * newI + 0.621 * newQ;
        g = luma - 0.272 * newI - 0.647 * newQ;
        b = luma - 1.106 * newI + 1.703 * newQ;
      }
      // Tint
      if (tintRgb && tintAmount > 0) {
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = r * (1 - tintAmount) + (luma * 0.4 + tintRgb[0] * 0.6) * tintAmount;
        g = g * (1 - tintAmount) + (luma * 0.4 + tintRgb[1] * 0.6) * tintAmount;
        b = b * (1 - tintAmount) + (luma * 0.4 + tintRgb[2] * 0.6) * tintAmount;
      }
      setPixel(image, x, y, [r, g, b, getPixel(image, x, y)[3]]);
    }
  }

  if (blur > 0) {
    const radius = Math.round(blur);
    const blurred = boxBlur(image, radius);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        setPixel(image, x, y, getPixel(blurred, x, y));
      }
    }
  }
  return image;
}

/** A separable box blur, used for the region "soften" edit. */
function boxBlur(image, radius) {
  const out = createImage(image.width, image.height);
  const window = radius * 2 + 1;
  for (let y = 0; y < image.height; y += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      let sum = 0;
      for (let i = -radius; i <= radius; i += 1) {
        sum += getPixel(image, clamp(i, 0, image.width - 1), y)[channel];
      }
      for (let x = 0; x < image.width; x += 1) {
        const index = (y * image.width + x) * 4;
        out.data[index + channel] = clamp(Math.round(sum / window), 0, 255);
        const remove = clamp(x - radius, 0, image.width - 1);
        const add = clamp(x + radius + 1, 0, image.width - 1);
        sum += getPixel(image, add, y)[channel] - getPixel(image, remove, y)[channel];
      }
    }
  }
  // Keep the alpha channel untouched — a blur must not change the shape.
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = image.data[i];
  return out;
}

/* -------------------------------------------------------- background removal */

/**
 * Remove a flat background by flooding inwards from the edges.
 *
 * This is a real, classic matting algorithm: it walks the border pixels and
 * removes every pixel that is within `tolerance` of the colour it reached.
 * It works on flat backgrounds (a product shot on white, a logo on a solid
 * panel) and says so when it cannot do the job, rather than pretending.
 *
 * @returns {{image: object, removed: number, coverage: number}}
 */
function removeBackground(image, { tolerance = 32 } = {}) {
  const out = createImage(image.width, image.height);
  out.data.set(image.data);
  const width = image.width;
  const height = image.height;
  const visited = new Uint8Array(width * height);
  const queue = [];
  const key = (x, y) => y * width + x;

  // The seeds are the border pixels.
  for (let x = 0; x < width; x += 1) { queue.push([x, 0]); queue.push([x, height - 1]); }
  for (let y = 0; y < height; y += 1) { queue.push([0, y]); queue.push([width - 1, y]); }

  // The reference colour is the average of the corners.
  const corners = [getPixel(out, 0, 0), getPixel(out, width - 1, 0), getPixel(out, 0, height - 1), getPixel(out, width - 1, height - 1)];
  const reference = [0, 1, 2].map((channel) => Math.round(corners.reduce((sum, c) => sum + c[channel], 0) / corners.length));

  let removed = 0;
  const maxDistance = Math.max(8, tolerance);
  while (queue.length) {
    const [x, y] = queue.pop();
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const index = key(x, y);
    if (visited[index]) continue;
    visited[index] = 1;
    const pixel = getPixel(out, x, y);
    const distance = Math.sqrt(
      (pixel[0] - reference[0]) ** 2 + (pixel[1] - reference[1]) ** 2 + (pixel[2] - reference[2]) ** 2
    );
    if (distance > maxDistance) continue; // a different colour — stop here
    const alphaIndex = index * 4 + 3;
    out.data[alphaIndex] = 0;
    removed += 1;
    queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  return { image: out, removed, coverage: removed / Math.max(1, width * height) };
}

/* --------------------------------------------------------------- compositing */

/** Paste `overlay` onto `base` at (x, y), honouring the overlay's alpha. */
function composite(base, overlay, x = 0, y = 0) {
  for (let row = 0; row < overlay.height; row += 1) {
    const targetY = y + row;
    if (targetY < 0 || targetY >= base.height) continue;
    for (let column = 0; column < overlay.width; column += 1) {
      const targetX = x + column;
      if (targetX < 0 || targetX >= base.width) continue;
      const [r, g, b, a] = getPixel(overlay, column, row);
      if (a === 0) continue;
      const alpha = a / 255;
      const [br, bg, bb, ba] = getPixel(base, targetX, targetY);
      const outAlpha = alpha + (ba / 255) * (1 - alpha);
      if (outAlpha <= 0) { setPixel(base, targetX, targetY, [0, 0, 0, 0]); continue; }
      setPixel(base, targetX, targetY, [
        (r * alpha + br * (ba / 255) * (1 - alpha)) / outAlpha,
        (g * alpha + bg * (ba / 255) * (1 - alpha)) / outAlpha,
        (b * alpha + bb * (ba / 255) * (1 - alpha)) / outAlpha,
        outAlpha * 255,
      ]);
    }
  }
  return base;
}

/** Paint a solid rectangle (used to patch over an edited text region). */
function fillRect(image, region, colour) {
  const x0 = clamp(Math.round(region.x), 0, image.width - 1);
  const y0 = clamp(Math.round(region.y), 0, image.height - 1);
  const x1 = clamp(Math.round(region.x + region.width), x0 + 1, image.width);
  const y1 = clamp(Math.round(region.y + region.height), y0 + 1, image.height);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) setPixel(image, x, y, colour);
  }
  return image;
}

/* ------------------------------------------------------------------ colour */

function hexToRgb(hex) {
  const text = String(hex ?? '').replace('#', '').trim();
  const value = text.length === 3
    ? text.split('').map((c) => c + c).join('')
    : text.padEnd(6, '0').slice(0, 6);
  return [
    parseInt(value.slice(0, 2), 16) || 0,
    parseInt(value.slice(2, 4), 16) || 0,
    parseInt(value.slice(4, 6), 16) || 0,
  ];
}

/** The average colour of a region — the fill colour for a text patch. */
function averageColour(image, region) {
  const x0 = clamp(Math.round(region.x), 0, image.width - 1);
  const y0 = clamp(Math.round(region.y), 0, image.height - 1);
  const x1 = clamp(Math.round(region.x + region.width), x0 + 1, image.width);
  const y1 = clamp(Math.round(region.y + region.height), y0 + 1, image.height);
  let r = 0, g = 0, b = 0, count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const pixel = getPixel(image, x, y);
      r += pixel[0]; g += pixel[1]; b += pixel[2]; count += 1;
    }
  }
  if (!count) return [255, 255, 255, 255];
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count), 255];
}

/** The difference between two images, as a per-pixel delta map. */
function difference(a, b) {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const out = createImage(width, height);
  let total = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = getPixel(a, x, y);
      const q = getPixel(b, x, y);
      const delta = (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2])) / 3;
      total += delta;
      const grey = clamp(255 - delta, 0, 255);
      setPixel(out, x, y, [grey, grey, grey, 255]);
    }
  }
  return { image: out, meanDelta: total / Math.max(1, width * height) };
}

module.exports = {
  createImage,
  getPixel,
  setPixel,
  resize,
  upscale,
  crop,
  rotate,
  adjust,
  boxBlur,
  removeBackground,
  composite,
  fillRect,
  averageColour,
  difference,
  hexToRgb,
  decodePNG,
  encodePNG,
};
