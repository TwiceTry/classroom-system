/**
 * 青果(117.159.97.151:8888) 4 位数字验证码 —— 纯 JS 前向推理
 * ==========================================================
 * 精确复刻 captcha/train.py 中的 CaptchaCNN:
 *   输入 70x30 灰度(0~1) -> 标准化 -> Conv3x3(32)+BN+ReLU+MaxPool2
 *   -> Conv3x3(64)+BN+ReLU+MaxPool2 -> Conv3x3(96)+BN+ReLU -> Conv3x3(128)+BN+ReLU
 *   -> AdaptiveAvgPool((1,8)) -> FC(1024->192)+ReLU -> FC(192->192)+ReLU
 *   -> 4 x Linear(192->10)  (4 个位置各自 argmax, 不做字符切分)
 *
 * 权重: ./captcha_model.js (int8 量化 + Base64, 由 captcha/train.py 导出)
 * 依赖: 无。浏览器用 canvas -> recognizeCanvas(); Node 端先用 jpeg-js 解码成 RGBA,
 *       再调 recognizeImageData()。
 */

import { CAPTCHA_MODEL } from './captcha_model.js';

const IMGW = CAPTCHA_MODEL.img_w;
const IMGH = CAPTCHA_MODEL.img_h;
const NCLS = CAPTCHA_MODEL.ncls;
const NPOS = CAPTCHA_MODEL.positions;
const MEAN = CAPTCHA_MODEL.mean;
const STD = CAPTCHA_MODEL.std;

export { IMGW, IMGH, NPOS, NCLS };

/* ------------------------------------------------------------ 权重解包 */
function decodeWeights(meta) {
  let u8;
  if (typeof atob === 'function') {
    const bin = atob(meta.data_b64);
    u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i) & 0xff;
  } else {
    u8 = new Uint8Array(Buffer.from(meta.data_b64, 'base64'));
  }
  const W = {};
  if (meta.quant === 'int8') {
    const i8 = new Int8Array(u8.buffer, u8.byteOffset, u8.byteLength);
    let off = 0;
    for (const k of meta.keys) {
      const shape = meta.shapes[k];
      const n = shape.reduce((a, b) => a * b, 1);
      const s = meta.scales[k];
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = i8[off + i] * s;
      off += n;
      W[k] = { data: f, shape };
    }
  } else {
    const f32 = new Float32Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 4));
    let off = 0;
    for (const k of meta.keys) {
      const shape = meta.shapes[k];
      const n = shape.reduce((a, b) => a * b, 1);
      W[k] = { data: f32.subarray(off, off + n), shape };
      off += n;
    }
  }
  return W;
}

const W = decodeWeights(CAPTCHA_MODEL);

/* ------------------------------------------------------------ 基础算子 */
// conv3x3 (pad=1), 输入/输出均为 [C,H,W] 扁平 Float32Array
function conv3x3(inp, inC, H, Wd, wt, bias) {
  const O = bias.length;
  const out = new Float32Array(O * H * Wd);
  for (let o = 0; o < O; o++) {
    const wOff = o * inC * 9;
    const b = bias[o];
    const outOff = o * H * Wd;
    for (let i = 0; i < H; i++) {
      for (let j = 0; j < Wd; j++) {
        let acc = b;
        for (let c = 0; c < inC; c++) {
          const inOff = c * H * Wd;
          const wc = wOff + c * 9;
          for (let ki = 0; ki < 3; ki++) {
            const yi = i + ki - 1;
            if (yi < 0 || yi >= H) continue;
            for (let kj = 0; kj < 3; kj++) {
              const xj = j + kj - 1;
              if (xj < 0 || xj >= Wd) continue;
              acc += inp[inOff + yi * Wd + xj] * wt[wc + ki * 3 + kj];
            }
          }
        }
        out[outOff + i * Wd + j] = acc;
      }
    }
  }
  return out;
}

// BatchNorm(推理) + ReLU, 原地
function bnRelu(x, C, H, Wd, gamma, beta, mean, varr, eps = 1e-5) {
  const hw = H * Wd;
  for (let c = 0; c < C; c++) {
    const s = gamma[c] / Math.sqrt(varr[c] + eps);
    const t = beta[c] - mean[c] * s;
    const off = c * hw;
    for (let i = 0; i < hw; i++) {
      const v = x[off + i] * s + t;
      x[off + i] = v > 0 ? v : 0;
    }
  }
  return x;
}

function maxPool2(x, C, H, Wd) {
  const oH = H >> 1, oW = Wd >> 1;
  const out = new Float32Array(C * oH * oW);
  for (let c = 0; c < C; c++) {
    const inOff = c * H * Wd, outOff = c * oH * oW;
    for (let i = 0; i < oH; i++) {
      for (let j = 0; j < oW; j++) {
        const p = inOff + i * 2 * Wd + j * 2;
        let m = x[p];
        if (x[p + 1] > m) m = x[p + 1];
        if (x[p + Wd] > m) m = x[p + Wd];
        if (x[p + Wd + 1] > m) m = x[p + Wd + 1];
        out[outOff + i * oW + j] = m;
      }
    }
  }
  return out;
}

function adaptiveAvgPool(x, C, H, Wd, oH, oW) {
  const out = new Float32Array(C * oH * oW);
  for (let c = 0; c < C; c++) {
    const inOff = c * H * Wd, outOff = c * oH * oW;
    for (let i = 0; i < oH; i++) {
      const h0 = Math.floor((i * H) / oH), h1 = Math.ceil(((i + 1) * H) / oH);
      for (let j = 0; j < oW; j++) {
        const w0 = Math.floor((j * Wd) / oW), w1 = Math.ceil(((j + 1) * Wd) / oW);
        let s = 0, n = 0;
        for (let y = h0; y < h1; y++) {
          for (let xx = w0; xx < w1; xx++) {
            s += x[inOff + y * Wd + xx];
            n++;
          }
        }
        out[outOff + i * oW + j] = s / n;
      }
    }
  }
  return out;
}

function linear(feat, w, bias) {
  const O = bias.length, D = feat.length;
  const out = new Float32Array(O);
  for (let o = 0; o < O; o++) {
    let acc = bias[o];
    const off = o * D;
    for (let i = 0; i < D; i++) acc += w[off + i] * feat[i];
    out[o] = acc;
  }
  return out;
}

function argmaxWithProb(v) {
  let best = 0;
  for (let i = 1; i < v.length; i++) if (v[i] > v[best]) best = i;
  let mx = -Infinity;
  for (let i = 0; i < v.length; i++) if (v[i] > mx) mx = v[i];
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += Math.exp(v[i] - mx);
  return { idx: best, prob: 1 / sum };
}

/* ------------------------------------------------------------ 主推理 */
/**
 * @param {Float32Array|number[]} gray 长度 IMGH*IMGW, 取值 0~1
 * @param {boolean} withProb 是否附加逐位最小概率
 * @returns {string|{code:string, prob:number}}
 */
export function recognizeGray(gray, withProb = false) {
  let x = new Float32Array(IMGH * IMGW);
  for (let i = 0; i < x.length; i++) x[i] = (gray[i] - MEAN) / STD;

  let C = 1, H = IMGH, Wd = IMGW;

  x = conv3x3(x, C, H, Wd, W['conv.0.weight'].data, W['conv.0.bias'].data);
  x = bnRelu(x, 32, H, Wd, W['conv.1.weight'].data, W['conv.1.bias'].data,
    W['conv.1.running_mean'].data, W['conv.1.running_var'].data);
  x = maxPool2(x, 32, H, Wd); C = 32; H >>= 1; Wd >>= 1;

  x = conv3x3(x, C, H, Wd, W['conv.4.weight'].data, W['conv.4.bias'].data);
  x = bnRelu(x, 64, H, Wd, W['conv.5.weight'].data, W['conv.5.bias'].data,
    W['conv.5.running_mean'].data, W['conv.5.running_var'].data);
  x = maxPool2(x, 64, H, Wd); C = 64; H >>= 1; Wd >>= 1;

  x = conv3x3(x, C, H, Wd, W['conv.8.weight'].data, W['conv.8.bias'].data);
  x = bnRelu(x, 96, H, Wd, W['conv.9.weight'].data, W['conv.9.bias'].data,
    W['conv.9.running_mean'].data, W['conv.9.running_var'].data); C = 96;

  x = conv3x3(x, C, H, Wd, W['conv.11.weight'].data, W['conv.11.bias'].data);
  x = bnRelu(x, 128, H, Wd, W['conv.12.weight'].data, W['conv.12.bias'].data,
    W['conv.12.running_mean'].data, W['conv.12.running_var'].data); C = 128;

  const pooled = adaptiveAvgPool(x, C, H, Wd, 1, 8);
  let f = linear(pooled, W['fc.0.weight'].data, W['fc.0.bias'].data);
  for (let i = 0; i < f.length; i++) if (f[i] < 0) f[i] = 0;
  f = linear(f, W['fc.3.weight'].data, W['fc.3.bias'].data);
  for (let i = 0; i < f.length; i++) if (f[i] < 0) f[i] = 0;

  let code = '';
  let minProb = 1;
  for (let t = 0; t < NPOS; t++) {
    const logits = linear(f, W['heads.' + t + '.weight'].data, W['heads.' + t + '.bias'].data);
    const r = argmaxWithProb(logits);
    code += String(r.idx);
    if (r.prob < minProb) minProb = r.prob;
  }
  return withProb ? { code, prob: minProb } : code;
}

/** RGBA(Uint8ClampedArray/Uint8Array) -> IMGH*IMGW 灰度(0~1), 双线性缩放 */
export function imageDataToGray(data, srcW, srcH) {
  const gray = new Float32Array(IMGH * IMGW);
  for (let y = 0; y < IMGH; y++) {
    const sy = ((y + 0.5) * srcH) / IMGH - 0.5;
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(sy)));
    const y1 = Math.min(srcH - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < IMGW; x++) {
      const sx = ((x + 0.5) * srcW) / IMGW - 0.5;
      const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(sx)));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const wx = sx - x0;
      const p00 = (y0 * srcW + x0) * 4, p10 = (y0 * srcW + x1) * 4;
      const p01 = (y1 * srcW + x0) * 4, p11 = (y1 * srcW + x1) * 4;
      const g = (p) => 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      const top = g(p00) * (1 - wx) + g(p10) * wx;
      const bot = g(p01) * (1 - wx) + g(p11) * wx;
      gray[y * IMGW + x] = (top * (1 - wy) + bot * wy) / 255;
    }
  }
  return gray;
}

/** 一步到位: RGBA 图像数据 -> 4 位数字 */
export function recognizeImageData(data, srcW, srcH, withProb = false) {
  return recognizeGray(imageDataToGray(data, srcW, srcH), withProb);
}

/**
 * 浏览器用: 传入 <img> 或 <canvas>, 返回 4 位数字 (失败返回 '')
 * @param {HTMLCanvasElement|HTMLImageElement} el
 */
export function recognizeCanvas(el, withProb = false) {
  try {
    const w = el.naturalWidth || el.width, h = el.naturalHeight || el.height;
    const cv = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = cv.getContext('2d');
    ctx.drawImage(el, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    return recognizeImageData(d, w, h, withProb);
  } catch (e) {
    return withProb ? { code: '', prob: 0, error: e.message } : '';
  }
}

export { CAPTCHA_MODEL };
