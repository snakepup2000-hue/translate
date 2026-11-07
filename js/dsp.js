/*
  Translate — offline analysis.
  Loudness follows ITU-R BS.1770-4 (K-weighting, 400 ms blocks, absolute and
  relative gating). True peak is a 4× Catmull-Rom estimate. Spectrum is an
  averaged FFT over 24 log-spaced bands.
*/

export const BANDS = [
  { id: 'sub',      label: 'Sub',      lo: 20,    hi: 60 },
  { id: 'bass',     label: 'Bass',     lo: 60,    hi: 120 },
  { id: 'lowmid',   label: 'Low mid',  lo: 120,   hi: 400 },
  { id: 'mid',      label: 'Mid',      lo: 400,   hi: 1500 },
  { id: 'presence', label: 'Presence', lo: 1500,  hi: 5000 },
  { id: 'air',      label: 'Air',      lo: 5000,  hi: 16000 },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const db = (v) => 20 * Math.log10(Math.max(1e-12, v));

function biquadCoeffs (type, sr, f0, gainDb = 0, q = 0.707) {
  const K = Math.tan(Math.PI * f0 / sr);
  const Vh = Math.pow(10, gainDb / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / q + K * K;
  let b0, b1, b2, a1, a2;

  if (type === 'highshelf') {
    b0 = (Vh + Vb * K / q + K * K) / a0;
    b1 = 2 * (K * K - Vh) / a0;
    b2 = (Vh - Vb * K / q + K * K) / a0;
  } else {
    b0 = 1 / a0;
    b1 = -2 / a0;
    b2 = 1 / a0;
  }

  a1 = 2 * (K * K - 1) / a0;
  a2 = (1 - K / q + K * K) / a0;
  return { b0, b1, b2, a1, a2 };
}

export function kWeightingCoeffs (sr) {
  return {
    shelf: biquadCoeffs('highshelf', sr, 1681.974450955533, 3.999843853973347, 0.7071752369554196),
    highpass: biquadCoeffs('highpass', sr, 38.13547087602444, 0, 0.5003270373238773),
  };
}

function runBiquad (input, c) {
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
  }

  return out;
}

function weightedChannels (channels, sr) {
  const c = kWeightingCoeffs(sr);
  return channels.map((ch) => runBiquad(runBiquad(ch, c.shelf), c.highpass));
}

function blockLoudness (weighted, blockSize, hop, i) {
  let power = 0;
  let count = 0;

  for (const ch of weighted) {
    let sum = 0;
    const end = Math.min(ch.length, i + blockSize);
    for (let n = i; n < end; n++) {
      const v = ch[n];
      sum += v * v;
    }
    power += sum / Math.max(1, end - i);
    count++;
  }

  if (count === 0 || power <= 0) return null;
  return -0.691 + 10 * Math.log10(power);
}

export function measureLoudness (channels, sr) {
  const n = Math.max(...channels.map((c) => c.length));
  const weighted = weightedChannels(channels, sr);
  const block = Math.max(1, Math.round(0.4 * sr));
  const hop = Math.max(1, Math.round(0.1 * sr));

  const blocks = [];
  for (let i = 0; i + block <= n; i += hop) {
    const l = blockLoudness(weighted, block, hop, i);
    if (l !== null) blocks.push({ t: i / sr, l });
  }

  if (blocks.length === 0) {
    return { integrated: -70, lra: 0, shortTermMax: -70 };
  }

  const aboveAbs = blocks.filter((b) => b.l > -70);
  const base = aboveAbs.length ? aboveAbs : blocks;
  const mean = (arr) => arr.reduce((s, b) => s + Math.pow(10, b.l / 10), 0) / arr.length;
  const ungated = -0.691 + 10 * Math.log10(Math.max(1e-12, mean(base)));
  const relativeGate = ungated - 10;
  const gated = base.filter((b) => b.l > relativeGate);
  const integrated = -0.691 + 10 * Math.log10(Math.max(1e-12, mean(gated.length ? gated : base)));

  // Short-term (3 s) for LRA.
  const stBlock = Math.max(1, Math.round(3 * sr));
  const stHop = Math.max(1, Math.round(1 * sr));
  const shorts = [];
  for (let i = 0; i + stBlock <= n; i += stHop) {
    const l = blockLoudness(weighted, stBlock, stHop, i);
    if (l !== null && l > -70) shorts.push(l);
  }
  shorts.sort((a, b) => a - b);
  const pick = (p) => shorts.length ? shorts[clamp(Math.floor((shorts.length - 1) * p), 0, shorts.length - 1)] : -70;
  const lra = Math.max(0, pick(0.95) - pick(0.10));

  return {
    integrated,
    lra,
    shortTermMax: shorts.length ? shorts[shorts.length - 1] : integrated,
  };
}

function catmull (x0, x1, x2, x3, t) {
  const a = 2 * x1;
  const b = x2 - x0;
  const c = 2 * x0 - 5 * x1 + 4 * x2 - x3;
  const d = -x0 + 3 * x1 - 3 * x2 + x3;
  return 0.5 * (a + b * t + c * t * t + d * t * t * t);
}

export function peaks (channels, sr) {
  let samplePeak = 0;
  let truePeak = 0;

  for (const ch of channels) {
    for (let i = 0; i + 3 < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > samplePeak) samplePeak = a;
      const x0 = ch[i], x1 = ch[i + 1], x2 = ch[i + 2], x3 = ch[i + 3];
      for (const t of [0.25, 0.5, 0.75]) {
        const v = Math.abs(catmull(x0, x1, x2, x3, t));
        if (v > truePeak) truePeak = v;
      }
    }
  }

  truePeak = Math.max(truePeak, samplePeak);
  return { samplePeakDb: db(samplePeak), truePeakDb: db(truePeak) };
}

export function stereoStats (channels) {
  if (channels.length < 2) return { correlation: 1, width: 0, monoLossDb: 0 };

  const L = channels[0], R = channels[1];
  let lr = 0, ll = 0, rr = 0, mid = 0, side = 0;
  const n = Math.min(L.length, R.length);

  for (let i = 0; i < n; i++) {
    const l = L[i], r = R[i];
    lr += l * r; ll += l * l; rr += r * r;
    const m = (l + r) * 0.5, s = (l - r) * 0.5;
    mid += m * m; side += s * s;
  }

  const correlation = lr / Math.sqrt(Math.max(1e-12, ll * rr));
  const width = Math.sqrt(side / Math.max(1e-12, mid));
  const monoLossDb = 10 * Math.log10(mid / Math.max(1e-12, (ll + rr) * 0.5));
  return { correlation, width, monoLossDb };
}

export function fft (re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export function spectrum (channels, sr, size = 4096, windows = 20) {
  const n = Math.max(...channels.map((c) => c.length));
  const bins = size / 2;
  const power = new Float64Array(bins);
  const hann = new Float32Array(size);
  for (let i = 0; i < size; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);

  const usable = Math.max(1, n - size);
  const count = Math.min(windows, Math.floor(usable / (sr * 0.25)) + 1);
  const step = count > 1 ? Math.floor(usable / (count - 1)) : 0;

  const re = new Float64Array(size), im = new Float64Array(size);
  for (let w = 0; w < count; w++) {
    const start = Math.min(usable, w * step);
    for (let c = 0; c < Math.min(2, channels.length); c++) {
      const ch = channels[c];
      for (let i = 0; i < size; i++) {
        re[i] = (ch[start + i] || 0) * hann[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let i = 1; i < bins; i++) {
        power[i] += (re[i] * re[i] + im[i] * im[i]);
      }
    }
  }

  const norm = 1 / Math.max(1, count * Math.min(2, channels.length));
  const centerFreqs = [];
  for (let c = 20; c < 20000; c *= Math.pow(2, 1 / 3)) centerFreqs.push(c);

  const bandPower = centerFreqs.map((fc) => {
    const lo = fc / Math.pow(2, 1 / 6);
    const hi = fc * Math.pow(2, 1 / 6);
    const i0 = Math.max(1, Math.floor(lo * size / sr));
    const i1 = Math.min(bins - 1, Math.ceil(hi * size / sr));
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += power[i];
    return sum * norm;
  });

  return {
    freqs: centerFreqs,
    db: bandPower.map((p) => 10 * Math.log10(Math.max(1e-12, p))),
    bands: BANDS.map((b) => {
      const i0 = Math.max(0, centerFreqs.findIndex((f) => f >= b.lo));
      let i1 = centerFreqs.length - 1;
      for (let i = 0; i < centerFreqs.length; i++) if (centerFreqs[i] > b.hi) { i1 = i - 1; break; }
      let sum = 0;
      for (let i = i0; i <= i1; i++) sum += bandPower[i];
      return 10 * Math.log10(Math.max(1e-12, sum));
    }),
  };
}

/* A-weighting, applied per third-octave band. Used for the default
   perceptual level match: a phone removes the bass that BS.1770 counts, so a
   pure LUFS match leaves the midrange much louder than the original. */
function aWeight (f) {
  const f2 = f * f;
  const num = 12194 * 12194 * f2 * f2;
  const den = (f2 + 20.6 * 20.6) *
    Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) *
    (f2 + 12194 * 12194);
  return 20 * Math.log10(num / den) + 2.0;
}

export function aWeightedLevel (spec) {
  if (!spec || !spec.freqs) return null;
  let power = 0;
  for (let i = 0; i < spec.freqs.length; i++) {
    power += Math.pow(10, spec.db[i] / 10) * Math.pow(10, aWeight(spec.freqs[i]) / 10);
  }
  return 10 * Math.log10(Math.max(1e-12, power));
}

export function analyseBuffer (buffer, opts = {}) {
  const sr = buffer.sampleRate;
  const channels = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c));

  const loudness = measureLoudness(channels, sr);
  const peak = opts.peak === false ? { samplePeakDb: -120, truePeakDb: -120 } : peaks(channels, sr);
  const stereo = stereoStats(channels);
  const spec = spectrum(channels, sr);

  return {
    duration: buffer.duration,
    sampleRate: sr,
    channels: buffer.numberOfChannels,
    lufs: loudness.integrated,
    lra: loudness.lra,
    shortTermMax: loudness.shortTermMax,
    peakDb: peak.samplePeakDb,
    truePeakDb: peak.truePeakDb,
    correlation: stereo.correlation,
    width: stereo.width,
    monoLossDb: stereo.monoLossDb,
    aWeighted: aWeightedLevel(spec),
    spectrum: spec,
  };
}

export const dbToGain = (v) => Math.pow(10, v / 20);
