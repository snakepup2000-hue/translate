/*
  Playback-system models.

  These are deliberately simple, audible approximations: a width/mono stage,
  a handful of filters, optional soft saturation, compression and an early
  reflection. They are not measurements of specific hardware, and the report
  shows the measured change rather than pretending to be a calibrated emulation.
*/

function gain (ctx, value = 1) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function biquad (ctx, type, freq, q = 0.707, gainDb = 0) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  if (gainDb !== 0) f.gain.value = gainDb;
  return f;
}

/* Mid/side width stage. width 0 = mono, 1 = unchanged, >1 wider.
   bassMonoHz keeps the side signal out of the low end. */
function widthStage (ctx, width, bassMonoHz = 0) {
  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(2);

  const lToMid = gain(ctx, 0.5);
  const rToMid = gain(ctx, 0.5);
  const lToSide = gain(ctx, 0.5);
  const rToSide = gain(ctx, -0.5);

  const mid = gain(ctx, 1);
  const side = gain(ctx, 1);

  split.connect(lToMid, 0);
  split.connect(rToMid, 1);
  split.connect(lToSide, 0);
  split.connect(rToSide, 1);
  lToMid.connect(mid); rToMid.connect(mid);
  lToSide.connect(side); rToSide.connect(side);

  let sideTail = side;

  if (bassMonoHz > 0) {
    const hp = biquad(ctx, 'highpass', bassMonoHz, 0.707);
    const hp2 = biquad(ctx, 'highpass', bassMonoHz, 0.707);
    side.connect(hp); hp.connect(hp2);
    sideTail = hp2;
  }

  const midL = gain(ctx, 1);
  const midR = gain(ctx, 1);
  const sideL = gain(ctx, width);
  const sideR = gain(ctx, -width);

  mid.connect(midL); mid.connect(midR);
  sideTail.connect(sideL); sideTail.connect(sideR);
  midL.connect(merge, 0, 0);
  sideL.connect(merge, 0, 0);
  midR.connect(merge, 0, 1);
  sideR.connect(merge, 0, 1);

  return { input: split, output: merge };
}

function shaper (ctx, drive) {
  const ws = ctx.createWaveShaper();
  const curve = new Float32Array(4096);
  const norm = Math.tanh(drive);

  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }

  ws.curve = curve;
  ws.oversample = '2x';
  return ws;
}

function compressor (ctx, spec) {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = spec.threshold;
  c.knee.value = spec.knee ?? 12;
  c.ratio.value = spec.ratio;
  c.attack.value = spec.attack ?? 0.01;
  c.release.value = spec.release ?? 0.2;
  return c;
}

export function buildChain (ctx, input, output, device) {
  let cur = input;

  const connect = (node) => {
    cur.connect(node);
    cur = node;
  };

  if (device.width !== undefined) {
    const w = widthStage(ctx, device.width, device.bassMono ?? 0);
    cur.connect(w.input);
    cur = w.output;
  }

  if (device.highpass) {
    connect(biquad(ctx, 'highpass', device.highpass, 0.62));
    if (device.highpassSteep) connect(biquad(ctx, 'highpass', device.highpass, 0.62));
  }

  for (const f of device.filters ?? []) {
    connect(biquad(ctx, f.type, f.freq, f.q ?? 0.707, f.gain ?? 0));
  }

  if (device.lowpass) connect(biquad(ctx, 'lowpass', device.lowpass, 0.707));

  if (device.drive) connect(shaper(ctx, device.drive));

  if (device.compressor) connect(compressor(ctx, device.compressor));

  if (device.reflection) {
    const dry = gain(ctx, 1);
    cur.connect(dry);
    dry.connect(output);

    const delay = ctx.createDelay(0.1);
    delay.delayTime.value = device.reflection.time;
    const wet = gain(ctx, device.reflection.mix);
    cur.connect(delay);
    delay.connect(wet);
    wet.connect(output);
    return output;
  }

  cur.connect(output);
  return output;
}

export const DEVICES = [
  {
    id: 'phone', name: 'Phone', number: '01', icon: 'phone',
    tagline: 'The check that matters. Almost no bottom, a hard midrange, no stereo.',
    width: 0, highpass: 430, highpassSteep: true, lowpass: 11000,
    filters: [{ type: 'peaking', freq: 3200, q: 1.05, gain: 4.5 }],
    drive: 1.35,
    compressor: { threshold: -24, ratio: 4, attack: 0.004, release: 0.16, knee: 10 },
    report: {
      headline: 'Bottom disappears and the image collapses',
      focus: ['sub', 'bass', 'presence'],
    },
  },
  {
    id: 'laptop', name: 'Laptop', number: '02', icon: 'laptop',
    tagline: 'Thin and slightly narrowed. The midrange comes forward.',
    width: 0.42, highpass: 175, lowpass: 16000,
    filters: [
      { type: 'lowshelf', freq: 260, gain: -2.5 },
      { type: 'peaking', freq: 2600, q: 1.0, gain: 2.5 },
    ],
    report: {
      headline: 'Low end thins, upper mids step forward',
      focus: ['bass', 'lowmid', 'presence'],
    },
  },
  {
    id: 'earbuds', name: 'Earbuds', number: '03', icon: 'earbuds',
    tagline: 'Bass lift and a presence peak. Wide, but the top can sting.',
    width: 1.05,
    filters: [
      { type: 'lowshelf', freq: 75, gain: 4.0 },
      { type: 'peaking', freq: 3800, q: 1.2, gain: 2.0 },
      { type: 'highshelf', freq: 9000, gain: -1.5 },
    ],
    report: {
      headline: 'More sub, more 4 kHz; watch sibilance',
      focus: ['sub', 'presence', 'air'],
    },
  },
  {
    id: 'car', name: 'Car', number: '04', icon: 'car',
    tagline: 'Cabin boom, a low-mid dip and an early reflection.',
    width: 1.15, bassMono: 120, highpass: 45,
    filters: [
      { type: 'lowshelf', freq: 95, gain: 3.5 },
      { type: 'peaking', freq: 380, q: 0.9, gain: -2.5 },
      { type: 'highshelf', freq: 8000, gain: -2.0 },
    ],
    reflection: { time: 0.007, mix: 0.18 },
    compressor: { threshold: -20, ratio: 2.5, attack: 0.01, release: 0.25, knee: 14 },
    report: {
      headline: 'Boom and a hollow low-mid; bass is mono',
      focus: ['bass', 'lowmid', 'mid'],
    },
  },
  {
    id: 'club', name: 'Club', number: '05', icon: 'club',
    tagline: 'Sub lift, glue compression, and a mono bottom end.',
    width: 1.08, bassMono: 100, highpass: 30,
    filters: [
      { type: 'lowshelf', freq: 60, gain: 4.0 },
      { type: 'peaking', freq: 250, q: 0.9, gain: -1.5 },
      { type: 'highshelf', freq: 9000, gain: -1.5 },
    ],
    compressor: { threshold: -18, ratio: 3, attack: 0.012, release: 0.25, knee: 12 },
    report: {
      headline: 'More weight, less top, and the dynamics tighten',
      focus: ['sub', 'bass', 'air'],
    },
  },
  {
    id: 'mono', name: 'Mono', number: '06', icon: 'mono',
    tagline: 'Everything summed. Phase problems have nowhere to hide.',
    width: 0, highpass: 25,
    report: {
      headline: 'The side channel is gone. Check what cancels.',
      focus: ['sub', 'bass', 'mid'],
    },
  },
];
