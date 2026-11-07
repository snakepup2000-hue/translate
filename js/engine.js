import { DEVICES, buildChain } from './devices.js';
import { analyseBuffer, dbToGain } from './dsp.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class TranslateEngine {
  constructor () {
    this.ctx = null;
    this.buffer = null;
    this.name = '';
    this.analysis = { original: null, devices: {} };
    this.matchDb = {};
    this.metrics = {};
    this.active = 'phone';
    this.matchMode = 'aweighted';   // aweighted | lufs | off
    this.monitorOriginal = true;
    this.blind = false;
    this.playing = false;
    this.offset = 0;
    this.startedAt = 0;
    this.loop = false;
    this.source = null;
    this.onEnded = null;
    this.volume = 0.9;
  }

  async ensureContext () {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });

    this.input = this.ctx.createGain();
    this.direct = this.ctx.createGain();
    this.direct.gain.value = 0;

    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;

    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.08;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.82;

    this.outputTrim = this.ctx.createGain();
    this.outputTrim.gain.value = 0.7;    // fixed headroom for the modelled boosts

    this.input.connect(this.direct);
    this.direct.connect(this.master);
    this.master.connect(this.outputTrim);
    this.outputTrim.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  async decode (arrayBuffer, name) {
    await this.ensureContext();
    const buffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    this.stopSource();
    this.buffer = buffer;
    this.name = name;
    this.offset = 0;
    this.playing = false;
    this.analysis = { original: null, devices: {} };
    this.matchDb = {};
    this.metrics = {};
    return buffer;
  }

  async prepare (onProgress = () => {}) {
    if (!this.buffer) return;

    this.analysis.original = analyseBuffer(this.buffer);
    this.buildRealtimeChains();

    for (let i = 0; i < DEVICES.length; i++) {
      const device = DEVICES[i];
      onProgress(i, DEVICES.length, device.name);
      await new Promise((r) => setTimeout(r, 16));

      const rendered = await this.renderDevice(device);
      const analysis = analyseBuffer(rendered, { peak: false });

      let samplePeak = 0;
      for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
        const data = rendered.getChannelData(ch);
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i]);
          if (v > samplePeak) samplePeak = v;
        }
      }
      analysis.samplePeakDb = 20 * Math.log10(Math.max(1e-9, samplePeak));
      this.analysis.devices[device.id] = analysis;

      const lufsDelta = this.analysis.original.lufs - analysis.lufs;
      this.metrics[device.id] = {
        lufs: lufsDelta,
        aweighted: (this.analysis.original.aWeighted != null && analysis.aWeighted != null)
          ? this.analysis.original.aWeighted - analysis.aWeighted
          : lufsDelta,
      };
      onProgress(i + 1, DEVICES.length, device.name);
    }

    this.computeMatch();
    this.applyRoute(true);
  }

  computeMatch () {
    // Keep the final peak at or below -1 dBFS with the master at unity.
    const ceilingDb = -1 - 20 * Math.log10(0.7);
    this.matchLimited = this.matchLimited || {};

    for (const device of DEVICES) {
      const m = this.metrics[device.id];
      const analysis = this.analysis.devices[device.id];
      let value = 0;
      if (m) value = this.matchMode === 'off' ? 0 : (this.matchMode === 'lufs' ? m.lufs : m.aweighted);

      this.matchLimited[device.id] = false;

      if (m && this.matchMode !== 'off' && analysis && analysis.samplePeakDb != null) {
        const maxGain = ceilingDb - analysis.samplePeakDb;

        if (value > maxGain) {
          value = maxGain;
          this.matchLimited[device.id] = true;
        }
      }

      this.matchDb[device.id] = clamp(value, -18, 18);
    }
  }

  setMatchMode (mode) {
    this.matchMode = mode;
    this.computeMatch();
    this.applyRoute();
  }

  buildRealtimeChains () {
    if (!this.ctx || !this.buffer) return;

    for (const g of Object.values(this.modelGains || {})) {
      try { g.disconnect(); } catch (e) {}
    }

    if (this.input) this.input.disconnect();
    this.input = this.ctx.createGain();
    this.input.connect(this.direct);
    this.modelGains = {};

    for (const device of DEVICES) {
      const g = this.ctx.createGain();
      g.gain.value = 0;
      buildChain(this.ctx, this.input, g, device);
      g.connect(this.master);
      this.modelGains[device.id] = g;
    }

    this.direct.gain.value = this.monitorOriginal ? 1 : 0;
  }

  async renderDevice (device) {
    const offline = new OfflineAudioContext(2, this.buffer.length, this.buffer.sampleRate);
    const src = offline.createBufferSource();
    src.buffer = this.buffer;
    buildChain(offline, src, offline.destination, device);
    src.start(0);
    return offline.startRendering();
  }

  applyRoute (immediate = false) {
    if (!this.ctx || !this.modelGains) return;
    const t = this.ctx.currentTime;
    const glide = immediate ? 0.001 : 0.012;

    this.direct.gain.setTargetAtTime(this.monitorOriginal ? 1 : 0, t, glide);

    for (const device of DEVICES) {
      const g = this.modelGains[device.id];
      const on = !this.monitorOriginal && this.active === device.id;
      const value = on ? dbToGain(this.matchDb[device.id] ?? 0) : 0;
      g.gain.setTargetAtTime(value, t, glide);
    }
  }

  setActive (id) {
    this.active = id;
    this.applyRoute();
  }

  setOriginal (original) {
    this.monitorOriginal = original;
    this.applyRoute();
  }

  async play (offset) {
    await this.ensureContext();
    if (!this.buffer) return;

    this.stopSource();
    const start = clamp(offset ?? this.offset, 0, Math.max(0, this.buffer.duration - 0.02));
    this.offset = start;

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = this.loop;
    src.connect(this.input);
    src.onended = () => {
      if (this.source !== src) return;
      if (this.loop) return;
      this.playing = false;
      this.offset = this.buffer.duration;
      this.source = null;
      if (this.onEnded) this.onEnded();
    };

    src.start(0, start);
    this.source = src;
    this.startedAt = this.ctx.currentTime - start;
    this.playing = true;
    this.applyRoute();
  }

  stopSource () {
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch (e) {}
      this.source.disconnect();
      this.source = null;
    }
  }

  pause () {
    if (!this.playing) return;
    this.offset = this.position();
    this.stopSource();
    this.playing = false;
  }

  seek (time) {
    if (!this.buffer) return;
    const wasPlaying = this.playing;
    this.stopSource();
    this.offset = clamp(time, 0, Math.max(0, this.buffer.duration - 0.02));
    if (wasPlaying) this.play(this.offset);
  }

  position () {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offset;
    const elapsed = this.ctx.currentTime - this.startedAt;
    const pos = this.loop ? elapsed % this.buffer.duration : Math.min(elapsed, this.buffer.duration);
    return pos;
  }

  setLoop (loop) {
    this.loop = loop;
    if (this.source) this.source.loop = loop;
  }

  setVolume (v) {
    this.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
  }

  getSpectrum (array) {
    if (!this.analyser) return false;
    this.analyser.getFloatFrequencyData(array);
    return true;
  }

  report (id) {
    const orig = this.analysis.original;
    const dev = this.analysis.devices[id];
    if (!orig || !dev) return null;

    const levelDb = this.matchDb[id] ?? 0;
    const deltas = orig.spectrum.bands.map((v, i) => (dev.spectrum.bands[i] + levelDb) - v);
    const low = (deltas[0] * 1.2 + deltas[1]) / 2.2;
    const presence = deltas[4];
    const air = deltas[5];
    const widthRatio = orig.width > 0.001 ? dev.width / orig.width : 0;
    const device = DEVICES.find((d) => d.id === id);
    const notes = [];

    if (low < -3) notes.push(`${low.toFixed(1)} dB less weight below 120 Hz`);
    else if (low > 2) notes.push(`${low.toFixed(1)} dB more weight below 120 Hz`);

    if (presence > 2) notes.push(`${presence.toFixed(1)} dB more presence around 3–4 kHz`);
    else if (presence < -2) notes.push(`${presence.toFixed(1)} dB less presence`);

    if (air < -2) notes.push(`${air.toFixed(1)} dB less air above 8 kHz`);

    if (widthRatio < 0.55) notes.push('Stereo image collapses toward mono');
    else if (widthRatio > 1.3) notes.push('Stereo image widens');

    if (device.bassMono) notes.push(`Side content below ${device.bassMono} Hz is removed`);
    if (device.reflection) notes.push('A short early reflection adds a fixed comb filter');
    if (device.compressor) notes.push('Bus compression tightens the dynamics');
    if (device.id === 'mono') notes.push('Correlated parts add; out-of-phase parts cancel');
    else if (widthRatio > 0.3 && widthRatio < 0.9) notes.push(`Stereo width is ${Math.round(widthRatio * 100)}% of the original`);
    if (!notes.length) notes.push('Tonally close to the original');

    return {
      device,
      deltas,
      low,
      presence,
      air,
      widthRatio,
      matchDb: this.matchDb[id] ?? 0,
      notes,
      lufs: dev.lufs + levelDb,
      nativeLufs: dev.lufs,
      width: dev.width,
      levelDb,
      matchMode: this.matchMode,
      limited: !!(this.matchLimited && this.matchLimited[id]),
    };
  }
}
