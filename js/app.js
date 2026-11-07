import { DEVICES } from './devices.js';
import { BANDS } from './dsp.js';
import { TranslateEngine } from './engine.js';

const $ = (sel) => document.querySelector(sel);

const ICONS = {
  phone: `<svg viewBox="0 0 40 40"><rect x="12" y="4" width="16" height="32" rx="3"/><line x1="17" y1="8" x2="23" y2="8"/><circle cx="20" cy="31" r="1"/></svg>`,
  laptop: `<svg viewBox="0 0 40 40"><rect x="8" y="8" width="24" height="16" rx="1.5"/><path d="M4 27h32l-3 4H7z"/><line x1="17" y1="30" x2="23" y2="30"/></svg>`,
  earbuds: `<svg viewBox="0 0 40 40"><path d="M14 7a4 4 0 0 1 4 4v11a3 3 0 1 1-6 0V11a4 4 0 0 1 2-4z"/><path d="M26 7a4 4 0 0 1 4 4v11a3 3 0 1 1-6 0V11a4 4 0 0 1 2-4z"/><circle cx="14" cy="11" r="1"/><circle cx="26" cy="11" r="1"/></svg>`,
  car: `<svg viewBox="0 0 40 40"><path d="M8 23l3-9h18l3 9v7h-3v3h-4v-3H15v3h-4v-3H8z"/><circle cx="13" cy="23" r="1.6"/><circle cx="27" cy="23" r="1.6"/><line x1="11" y1="23" x2="29" y2="23"/></svg>`,
  club: `<svg viewBox="0 0 40 40"><rect x="12" y="4" width="16" height="12" rx="1"/><rect x="12" y="19" width="16" height="17" rx="1"/><circle cx="20" cy="10" r="2.6"/><circle cx="20" cy="27" r="4.2"/></svg>`,
  mono: `<svg viewBox="0 0 40 40"><circle cx="16" cy="20" r="7.5"/><circle cx="24" cy="20" r="7.5"/><line x1="20" y1="8" x2="20" y2="32" stroke-dasharray="2 3"/></svg>`,
};

const LISTEN = {
  phone: 'Vocal and snare should still cut. If the kick vanishes, the low end is doing too much for this system.',
  laptop: 'Check that the bass still has a note, not just a thump. The upper mid can get shouty here.',
  earbuds: 'Watch sibilance and 3–5 kHz. The bass lift can mask the kick and make the mix feel slower.',
  car: 'Check 200–400 Hz. Cabin boom makes mixes muddy long before the sub tells you anything.',
  club: 'Check sub weight and whether the limiter is working too hard. The top end will feel softer.',
  mono: 'Listen for parts that vanish. Wide synths, stereo reverb and out-of-phase bass are the usual suspects.',
};

for (const device of DEVICES) device.listen = LISTEN[device.id];

const engine = new TranslateEngine();

const state = {
  track: null,
  ready: false,
  analysing: false,
  device: 'phone',
  original: true,
  blind: false,
  blindAIsOriginal: true,
  revealed: false,
  loop: false,
  peaks: null,
  peakWidth: 0,
};

const el = {
  drop: $('#drop'), file: $('#file'), browse: $('#browse'), demo: $('#demo'),
  track: $('#track'), trackName: $('#trackName'), replace: $('#replace'),
  wave: $('#waveform'), playhead: $('#playhead'), waveWrap: $('.wave-wrap'),
  statLufs: $('#statLufs'), statPeak: $('#statPeak'), statWidth: $('#statWidth'),
  trackMeta: $('#trackMeta'), sourceState: $('#sourceState'),
  grid: $('#deviceGrid'), deviceTitle: $('#deviceTitle'),
  matchBadge: $('#matchBadge'), matchText: $('#matchText'), matchMode: $('#matchMode'), reportMatchNote: $('#reportMatchNote'),
  sideA: $('#sideA'), sideB: $('#sideB'), blind: $('#blind'), reveal: $('#reveal'),
  analysisBar: $('#analysisBar'), analysisLabel: $('#analysisLabel'),
  analysisCount: $('#analysisCount'), analysisFill: $('#analysisFill'),
  reportEmpty: $('#reportEmpty'), reportBody: $('#reportBody'), reportState: $('#reportState'),
  reportDevice: $('#reportDevice'), reportHeadline: $('#reportHeadline'), copyReport: $('#copyReport'), shareCard: $('#shareCard'), reportFoot: $('#reportFoot'),
  listenTip: $('#listenTip'), lmLow: $('#lmLow'), lmPresence: $('#lmPresence'), lmWidth: $('#lmWidth'),
  bands: $('#bands'), notes: $('#notes'), reportMatch: $('#reportMatch'),
  spectrum: $('#spectrum'), play: $('#play'), timeNow: $('#timeNow'), timeTotal: $('#timeTotal'),
  scrub: $('#scrub'), scrubFill: $('#scrubFill'), scrubDot: $('#scrubDot'),
  loop: $('#loop'), vol: $('#vol'), toast: $('#toast'),
};

/* --------------------------------------------------------------- utilities */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function fmtTime (s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

let toastTimer = 0;
function toast (msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
}

function fit (canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return null;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/* ------------------------------------------------------------------- icons */

function renderDevices () {
  el.grid.innerHTML = DEVICES.map((d) => `
    <button class="device-card" data-device="${d.id}" aria-label="${d.name}">
      <span class="device-num">${d.number}</span>
      <span class="device-icon">${ICONS[d.icon]}</span>
      <span class="device-body">
        <span class="device-name">${d.name}</span>
        <span class="device-tag">${d.tagline}</span>
      </span>
    </button>`).join('');

  el.grid.querySelectorAll('.device-card').forEach((card) => {
    card.addEventListener('click', () => selectDevice(card.dataset.device));
  });
}

/* ---------------------------------------------------------------- waveform */

function computePeaks (buffer, width) {
  const ch = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) ch.push(buffer.getChannelData(c));
  const n = buffer.length;
  const peaks = new Float32Array(width * 2);

  for (let x = 0; x < width; x++) {
    const i0 = Math.floor((x / width) * n);
    const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / width) * n));
    let mn = 0, mx = 0;
    const step = Math.max(1, Math.floor((i1 - i0) / 260));
    for (let i = i0; i < i1; i += step) {
      let v = 0;
      for (const data of ch) v += Math.abs(data[i] || 0);
      v /= ch.length;
      if (v > mx) mx = v;
    }
    peaks[x * 2] = mx;
    peaks[x * 2 + 1] = mn;
  }

  return peaks;
}

function drawWaveform () {
  const fitRes = fit(el.wave);
  if (!fitRes || !state.peaks) return;
  const { ctx, w, h } = fitRes;
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = 'rgba(239,231,215,0.015)';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(239,231,215,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2 + 0.5);
  ctx.lineTo(w, h / 2 + 0.5);
  ctx.stroke();

  const mid = h / 2;
  const amp = h * 0.42;

  ctx.fillStyle = 'rgba(239,231,215,0.64)';
  for (let x = 0; x < w; x++) {
    const p = state.peaks[(x / w * state.peakWidth) | 0] ?? 0;
    const half = Math.max(0.5, p * amp);
    ctx.fillRect(x, mid - half, 1, half * 2);
  }
}

function drawPlayhead () {
  const fitRes = fit(el.playhead);
  if (!fitRes || !state.track) return;
  const { ctx, w, h } = fitRes;
  ctx.clearRect(0, 0, w, h);

  const pos = engine.position();
  const ratio = clamp(pos / state.track.duration, 0, 1);
  const x = ratio * w;

  ctx.fillStyle = 'rgba(191,59,37,0.10)';
  ctx.fillRect(0, 0, x, h);
  ctx.fillStyle = '#bf3b25';
  ctx.fillRect(x - 0.5, 0, 1.5, h);

  el.scrubFill.style.width = `${ratio * 100}%`;
  el.scrubDot.style.left = `${ratio * 100}%`;
  el.timeNow.textContent = fmtTime(pos);
}

/* ------------------------------------------------------------------- track */

function showTrack (name, buffer) {
  el.drop.hidden = true;
  el.track.hidden = false;
  el.trackName.textContent = name;
  el.timeTotal.textContent = fmtTime(buffer.duration);
  el.play.disabled = false;

  const sr = buffer.sampleRate;
  el.trackMeta.textContent = `${buffer.duration.toFixed(1)} s · ${(sr / 1000).toFixed(1)} kHz · ${buffer.numberOfChannels === 2 ? 'stereo' : 'mono'}`;

  requestAnimationFrame(() => {
    state.peakWidth = Math.max(80, Math.floor(el.wave.clientWidth));
    state.peaks = computePeaks(buffer, state.peakWidth);
    drawWaveform();
    drawPlayhead();
  });
}

function resetAnalysisUI () {
  el.statLufs.textContent = '—';
  el.statPeak.textContent = '—';
  el.statWidth.textContent = '—';
  el.matchBadge.hidden = true;
  el.matchMode.disabled = true;
  el.reportBody.hidden = true;
  el.reportFoot.hidden = true;
  el.reportEmpty.hidden = false;
  el.reportState.textContent = 'Waiting';
}

async function loadArrayBuffer (arrayBuffer, name) {
  if (state.analysing) {
    toast('Still analysing the previous track — one moment.');
    return;
  }

  try {
    el.sourceState.textContent = 'Decoding';
    resetAnalysisUI();

    const buffer = await engine.decode(arrayBuffer, name);
    state.track = buffer;
    state.ready = false;
    state.original = true;
    engine.monitorOriginal = true;
    if (engine.direct) engine.direct.gain.value = 1;
    updateAB();
    updateTitle();
    updatePlayButton();
    state.peaks = null;
    showTrack(name, buffer);

    el.sourceState.textContent = 'Analysing';
    await runAnalysis();
  } catch (err) {
    console.error(err);
    el.sourceState.textContent = 'Error';
    toast('Could not decode that file. Try WAV, AIFF, MP3 or FLAC.');
  }
}

async function runAnalysis () {
  if (!state.track || state.analysing) return;
  state.analysing = true;
  el.grid.classList.add('busy');
  el.analysisBar.hidden = false;
  el.analysisFill.style.width = '0%';
  el.analysisCount.textContent = `0 / ${DEVICES.length}`;
  el.reportState.textContent = 'Rendering';

  try {
    await engine.prepare((done, total, label) => {
      el.analysisFill.style.width = `${(done / total) * 100}%`;
      el.analysisCount.textContent = `${done} / ${total}`;
      el.analysisLabel.textContent = done < total ? `Rendering ${label.toLowerCase()}…` : 'Finishing report…';
    });

    state.ready = true;
    state.device = 'phone';
    state.original = false;
    engine.setActive(state.device);
    engine.setOriginal(false);

    const orig = engine.analysis.original;
    el.statLufs.textContent = orig.lufs.toFixed(1);
    el.statPeak.textContent = orig.truePeakDb.toFixed(1);
    el.statWidth.textContent = Math.round(orig.width * 100);
    el.trackMeta.textContent = `${orig.duration.toFixed(1)} s · ${(orig.sampleRate / 1000).toFixed(1)} kHz · ${orig.channels === 2 ? 'stereo' : 'mono'} · LRA ${orig.lra.toFixed(1)} LU`;
    el.sourceState.textContent = 'Ready';

    updateAll();
  } catch (err) {
    console.error(err);
    el.sourceState.textContent = 'Error';
    toast('Analysis failed. The file may be too long for this browser tab.');
  } finally {
    state.analysing = false;
    el.grid.classList.remove('busy');
    setTimeout(() => { if (!state.analysing) el.analysisBar.hidden = true; }, 450);
  }
}

/* --------------------------------------------------------------- listening */

function selectDevice (id) {
  if (!state.ready) {
    toast('Load a track first.');
    return;
  }
  if (state.analysing) return;

  state.device = id;
  state.original = false;
  engine.setActive(id);
  engine.setOriginal(false);
  updateAll();
}

function setOriginal (original) {
  if (!state.ready) return;
  state.original = original;
  engine.setOriginal(original);
  updateAll();
}

function currentSide () {
  if (!state.blind) return state.original ? 'A' : 'B';
  if (state.original) return state.blindAIsOriginal ? 'A' : 'B';
  return state.blindAIsOriginal ? 'B' : 'A';
}

function isOriginalSide (side) {
  if (!state.blind) return side === 'A';
  return side === 'A' ? state.blindAIsOriginal : !state.blindAIsOriginal;
}

function toggleBlind () {
  if (!state.ready) return;
  state.blind = !state.blind;
  if (state.blind) {
    state.blindAIsOriginal = Math.random() < 0.5;
    state.revealed = false;
  }
  updateAB();
}

function updateAB () {
  const device = DEVICES.find((d) => d.id === state.device);
  const side = currentSide();

  el.sideA.classList.toggle('active', side === 'A');
  el.sideB.classList.toggle('active', side === 'B');

  const aLabel = el.sideA.querySelector('.ab-label');
  const bLabel = el.sideB.querySelector('.ab-label');

  if (!state.blind) {
    aLabel.textContent = 'Original';
    bLabel.textContent = device.name;
  } else if (state.revealed) {
    const aIsOrig = state.blindAIsOriginal;
    aLabel.textContent = `A · ${aIsOrig ? 'Original' : device.name}`;
    bLabel.textContent = `B · ${aIsOrig ? device.name : 'Original'}`;
  } else {
    aLabel.textContent = 'A';
    bLabel.textContent = 'B';
  }

  el.blind.classList.toggle('on', state.blind);
  el.reveal.hidden = !state.blind;
  el.reveal.textContent = state.revealed ? 'Hide' : 'Reveal';
}

function updateMatch () {
  const mode = engine.matchMode;
  const labels = { aweighted: 'Perceptual match', lufs: 'LUFS match', off: 'Raw level' };
  el.matchMode.textContent = `Match: ${mode === 'aweighted' ? 'A-wt' : mode === 'lufs' ? 'LUFS' : 'Off'}`;
  el.matchMode.disabled = !state.ready;

  if (!state.ready || state.original) {
    el.matchBadge.hidden = true;
    return;
  }

  const db = engine.matchDb[state.device] ?? 0;

  if (mode === 'off') {
    el.matchText.textContent = 'Raw model level';
  } else {
    const sign = db >= 0 ? '+' : '−';
    const limited = engine.matchLimited?.[state.device] ? ' · peak-limited' : '';
    el.matchText.textContent = `${labels[mode]} ${sign}${Math.abs(db).toFixed(1)} dB${limited}`;
  }

  el.matchBadge.hidden = false;
}

function updateTitle () {
  const device = DEVICES.find((d) => d.id === state.device);
  el.deviceTitle.textContent = !state.ready || state.original ? 'Original mix' : (ON_A[state.device] || device.name);
  el.grid.querySelectorAll('.device-card').forEach((card) => {
    card.classList.toggle('active', state.ready && !state.original && card.dataset.device === state.device);
  });
}

/* ------------------------------------------------------------------ report */

function setMetric (node, value, suffix) {
  const sign = value >= 0 ? '+' : '−';
  node.textContent = `${sign}${Math.abs(value).toFixed(1)}${suffix}`;
  node.classList.toggle('pos', value > 0.4);
  node.classList.toggle('neg', value < -0.4);
}

function updateReport () {
  const report = engine.report(state.device);

  if (!state.ready || !report) {
    el.reportBody.hidden = true;
    el.reportFoot.hidden = true;
    el.reportEmpty.hidden = false;
    el.reportState.textContent = 'Waiting';
    return;
  }

  const device = report.device;
  el.listenTip.textContent = device.listen;
  setMetric(el.lmLow, report.low, ' dB');
  setMetric(el.lmPresence, report.presence, ' dB');

  if (report.widthRatio <= 0.06) {
    el.lmWidth.textContent = 'Mono';
    el.lmWidth.classList.remove('pos');
    el.lmWidth.classList.add('neg');
  } else {
    setMetric(el.lmWidth, (report.widthRatio - 1) * 100, ' %');
  }

  el.reportEmpty.hidden = true;
  el.reportBody.hidden = false;
  el.reportFoot.hidden = false;
  el.reportState.textContent = state.original ? 'Preview' : 'Device';
  el.reportDevice.textContent = report.device.name;
  el.reportHeadline.textContent = report.device.report.headline;

  el.bands.innerHTML = BANDS.map((band, i) => {
    const d = report.deltas[i];
    const w = Math.min(48, Math.abs(d) / 12 * 48);
    const left = d >= 0 ? 50 : 50 - w;
    const cls = d >= 0 ? '' : 'neg';
    const zero = Math.abs(d) < 0.15 ? ' zero' : '';
    const val = `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`;
    return `<div class="band-row">
      <span class="band-name">${band.label}</span>
      <span class="band-track"><i class="band-fill ${cls}" style="left:${left}%;width:${w}%"></i></span>
      <span class="band-val${zero}">${val}</span>
    </div>`;
  }).join('');

  el.notes.innerHTML = report.notes.map((n) => `<span class="note">${n}</span>`).join('');

  const mode = report.matchMode;
  const sign = report.matchDb >= 0 ? '+' : '−';
  const labels = { aweighted: 'Perceptual match', lufs: 'LUFS match', off: 'Raw model' };

  if (mode === 'off') {
    el.reportMatch.textContent = `Raw model · ${report.lufs.toFixed(1)} LUFS`;
    el.reportMatchNote.textContent = 'no level match — adjust playback level by ear';
  } else {
    el.reportMatch.textContent = `${labels[mode]} ${sign}${Math.abs(report.matchDb).toFixed(1)} dB · device ${report.lufs.toFixed(1)} LUFS`;
    el.reportMatchNote.textContent = (mode === 'aweighted'
      ? 'A-weighted, because a phone removes bass that LUFS counts'
      : 'integrated LUFS match') + (report.limited ? ' · peak-limited for headroom' : '');
  }

  drawSpectrum();
}

/* ---------------------------------------------------------------- spectrum */

function drawSpectrum () {
  const fitRes = fit(el.spectrum);
  if (!fitRes) return;
  const { ctx, w, h } = fitRes;
  ctx.clearRect(0, 0, w, h);

  const orig = engine.analysis.original?.spectrum;
  const dev = engine.analysis.devices[state.device]?.spectrum;
  if (!orig) return;

  const left = 0, right = w, top = 8, bottom = h - 12;
  const fMin = 20, fMax = 20000;
  const ref = Math.max(...orig.db);
  const xOf = (f) => left + (Math.log(f / fMin) / Math.log(fMax / fMin)) * (right - left);
  const yOf = (db) => top + clamp((-(db - ref)) / 48, 0, 1) * (bottom - top);

  ctx.strokeStyle = 'rgba(239,231,215,0.09)';
  ctx.lineWidth = 1;
  for (const f of [100, 1000, 10000]) {
    const x = xOf(f);
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
  }
  for (const db of [0, -12, -24, -36]) {
    const y = yOf(db);
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
  }

  const drawCurve = (spec, color, width, fill, shift = 0) => {
    if (!spec) return;
    ctx.beginPath();
    for (let i = 0; i < spec.freqs.length; i++) {
      const x = xOf(spec.freqs[i]);
      const y = yOf(spec.db[i] + shift);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    if (fill) {
      ctx.lineTo(right, bottom);
      ctx.lineTo(left, bottom);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.beginPath();
    for (let i = 0; i < spec.freqs.length; i++) {
      const x = xOf(spec.freqs[i]);
      const y = yOf(spec.db[i] + shift);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };

  drawCurve(orig, 'rgba(127,156,175,0.75)', 1, null);
  if (dev && !state.original) {
    const shift = engine.matchDb[state.device] ?? 0;
    drawCurve(dev, '#d4553d', 1.8, 'rgba(191,59,37,0.10)', shift);
  }

  ctx.fillStyle = 'rgba(239,231,215,0.50)';
  ctx.font = '9px "Barlow Condensed", sans-serif';
  ctx.textAlign = 'center';
  for (const f of [100, 1000, 10000]) {
    ctx.fillText(f === 1000 ? '1k' : f === 10000 ? '10k' : '100', xOf(f), h - 2);
  }
}

/* ---------------------------------------------------------------- transport */

async function togglePlay () {
  if (!state.track) return;
  if (engine.playing) {
    engine.pause();
  } else {
    if (engine.position() >= state.track.duration - 0.02) engine.seek(0);
    await engine.play();
  }
  el.play.classList.toggle('playing', engine.playing);
}

function updatePlayButton () {
  el.play.classList.toggle('playing', engine.playing);
}

el.play.addEventListener('click', togglePlay);
el.loop.addEventListener('click', () => {
  state.loop = !state.loop;
  engine.setLoop(state.loop);
  el.loop.classList.toggle('on', state.loop);
});

el.vol.addEventListener('input', () => engine.setVolume(parseFloat(el.vol.value)));

/* seek */
function seekFromEvent (e, element) {
  if (!state.track) return;
  const r = element.getBoundingClientRect();
  const ratio = clamp((e.clientX - r.left) / r.width, 0, 1);
  engine.seek(ratio * state.track.duration);
  drawPlayhead();
}

el.waveWrap.addEventListener('click', (e) => seekFromEvent(e, el.waveWrap));
el.scrub.addEventListener('click', (e) => seekFromEvent(e, el.scrub));

let scrubbing = false;
el.scrub.addEventListener('pointerdown', (e) => { scrubbing = true; seekFromEvent(e, el.scrub); });
window.addEventListener('pointermove', (e) => { if (scrubbing) seekFromEvent(e, el.scrub); });
window.addEventListener('pointerup', () => { scrubbing = false; });

/* file loading */
el.browse.addEventListener('click', () => el.file.click());
el.replace.addEventListener('click', () => el.file.click());
el.file.addEventListener('change', async () => {
  const file = el.file.files?.[0];
  if (!file) return;
  el.file.value = '';
  const ab = await file.arrayBuffer();
  await loadArrayBuffer(ab, file.name);
});

engine.onEnded = () => updatePlayButton();

el.demo.addEventListener('click', async () => {
  el.demo.disabled = true;
  el.demo.textContent = 'loading demo…';
  try {
    const res = await fetch('assets/demo.wav');
    const ab = await res.arrayBuffer();
    await loadArrayBuffer(ab, 'Snake Puppy — Demo Loop');
  } catch (err) {
    console.error(err);
    toast('Demo could not load. Serve the folder over HTTP.');
  } finally {
    el.demo.disabled = false;
    el.demo.innerHTML = 'or hear the demo loop <span>&rarr;</span>';
  }
});

/* drag & drop */
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  const ab = await file.arrayBuffer();
  await loadArrayBuffer(ab, file.name);
});
el.drop.addEventListener('dragover', (e) => { e.preventDefault(); el.drop.classList.add('dragover'); });
el.drop.addEventListener('dragleave', () => el.drop.classList.remove('dragover'));
el.drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  el.drop.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  const ab = await file.arrayBuffer();
  await loadArrayBuffer(ab, file.name);
});

/* A/B */
el.sideA.addEventListener('click', () => { if (state.ready) setOriginal(isOriginalSide('A')); });
el.sideB.addEventListener('click', () => { if (state.ready) setOriginal(isOriginalSide('B')); });
el.blind.addEventListener('click', toggleBlind);
el.reveal.addEventListener('click', () => {
  state.revealed = !state.revealed;
  updateAB();
});

el.matchMode.addEventListener('click', () => {
  if (!state.ready) return;
  const modes = ['aweighted', 'lufs', 'off'];
  const next = modes[(modes.indexOf(engine.matchMode) + 1) % modes.length];
  engine.setMatchMode(next);
  updateMatch();
  updateReport();
});

const ON_A = { phone: 'On a phone', laptop: 'On a laptop', earbuds: 'On earbuds', car: 'In a car', club: 'In a club', mono: 'In mono' };

function wrapText (ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  let yy = y;
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, yy);
      line = word;
      yy += lineHeight;
    } else line = test;
  }
  if (line) ctx.fillText(line, x, yy);
  return yy + lineHeight;
}

async function makeShareCard () {
  const report = engine.report(state.device);
  if (!report) return;
  await document.fonts.ready;

  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 1500;
  const ctx = canvas.getContext('2d');
  const orig = engine.analysis.original;

  // ---- paper -----------------------------------------------------------
  ctx.fillStyle = '#efe7d7';
  ctx.fillRect(0, 0, 1200, 1500);

  for (let i = 0; i < 5000; i++) {
    const a = 0.012 + Math.random() * 0.03;
    ctx.fillStyle = `rgba(27,25,20,${a})`;
    ctx.fillRect(Math.random() * 1200, Math.random() * 1500, 1.2, 1.2);
  }

  // faint margin rule
  ctx.fillStyle = 'rgba(191,59,37,0.18)';
  ctx.fillRect(40, 0, 1, 1500);

  // ---- brand -----------------------------------------------------------
  ctx.save();
  ctx.translate(64, 70);
  ctx.rotate(-0.018);
  ctx.fillStyle = '#bf3b25';
  ctx.fillRect(0, 0, 8, 84);
  ctx.restore();

  ctx.fillStyle = '#1b1914';
  ctx.font = '600 64px Fraunces';
  ctx.fillText('Translate', 94, 130);

  ctx.fillStyle = '#7c7361';
  ctx.font = '400 15px "Courier Prime"';
  ctx.fillText('hear it everywhere', 98, 156);

  // stamp
  ctx.save();
  ctx.translate(800, 78);
  ctx.rotate(-0.025);
  ctx.strokeStyle = '#bf3b25';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(0, 0, 336, 42);
  ctx.fillStyle = '#bf3b25';
  ctx.font = '400 12.5px "Courier Prime"';
  ctx.fillText('NOTHING LEAVES THIS MACHINE', 16, 27);
  ctx.restore();

  // ---- source ----------------------------------------------------------
  ctx.fillStyle = '#7c7361';
  ctx.font = '400 13px "Courier Prime"';
  ctx.fillText('Source', 64, 224);

  ctx.fillStyle = '#1b1914';
  ctx.font = '500 32px Fraunces';
  ctx.fillText(el.trackName.textContent, 64, 264);

  // ---- headline --------------------------------------------------------
  ctx.fillStyle = '#7c7361';
  ctx.font = '400 13px "Courier Prime"';
  ctx.fillText('Playback translation', 64, 336);

  ctx.fillStyle = '#bf3b25';
  ctx.font = '600 96px Fraunces';
  let title = ON_A[state.device] || 'On a system';
  ctx.fillText(title, 58, 432);

  ctx.fillStyle = '#1b1914';
  ctx.font = '500 31px Fraunces';
  wrapText(ctx, report.device.report.headline, 64, 484, 1040, 36);

  // ---- metrics ---------------------------------------------------------
  const matchLabel = report.matchMode === 'lufs' ? 'LUFS match'
    : report.matchMode === 'off' ? 'Raw level' : 'Perceptual match';
  const matchValue = report.matchMode === 'off' ? '—'
    : `${report.matchDb >= 0 ? '+' : '−'}${Math.abs(report.matchDb).toFixed(1)}`;

  const metrics = [
    ['Integrated', orig.lufs.toFixed(1), 'LUFS', '#1b1914'],
    ['True peak', orig.truePeakDb.toFixed(1), 'dBTP', '#1b1914'],
    [matchLabel, matchValue, report.matchMode === 'off' ? '' : 'dB', '#bf3b25'],
  ];

  metrics.forEach((m, i) => {
    const x = 64 + i * 356;
    ctx.fillStyle = '#7c7361';
    ctx.font = '400 13px "Courier Prime"';
    ctx.fillText(m[0], x, 574);

    ctx.fillStyle = m[3];
    ctx.font = '500 62px Fraunces';
    ctx.fillText(m[1], x, 636);
    const w = ctx.measureText(m[1]).width;

    ctx.fillStyle = '#7c7361';
    ctx.font = '400 13px "Courier Prime"';
    ctx.fillText(m[2], x + w + 10, 636);
  });

  ctx.fillStyle = '#7c7361';
  ctx.font = '400 12.5px "Courier Prime"';
  ctx.fillText(`device level after match: ${report.lufs.toFixed(1)} LUFS${report.limited ? ' · peak-limited' : ''}`, 64, 664);

  // ---- spectrum --------------------------------------------------------
  const sx = 64, sy = 700, sw = 1072, sh = 360;
  ctx.fillStyle = '#171510';
  ctx.fillRect(sx, sy, sw, sh);
  ctx.strokeStyle = 'rgba(239,231,215,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(sx, sy, sw, sh);

  ctx.strokeStyle = 'rgba(239,231,215,0.10)';
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(sx, sy + sh * i / 4);
    ctx.lineTo(sx + sw, sy + sh * i / 4);
    ctx.stroke();
  }

  const xOf = (f) => sx + (Math.log(f / 20) / Math.log(20000 / 20)) * sw;
  const ref = Math.max(...orig.spectrum.db);
  const yOf = (db) => sy + Math.min(1, Math.max(0, (-(db - ref)) / 48)) * (sh - 34) + 24;

  const curve = (spec, color, width, fill, shift = 0) => {
    if (!spec) return;
    ctx.beginPath();
    spec.freqs.forEach((f, i) => { const x = xOf(f), y = yOf(spec.db[i] + shift); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    if (fill) {
      ctx.lineTo(sx + sw, sy + sh);
      ctx.lineTo(sx, sy + sh);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.beginPath();
    spec.freqs.forEach((f, i) => { const x = xOf(f), y = yOf(spec.db[i] + shift); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };

  curve(orig.spectrum, '#7f9caf', 1.8, null);
  curve(engine.analysis.devices[state.device].spectrum, '#d4553d', 2.8, 'rgba(191,59,37,0.12)', report.levelDb);

  ctx.fillStyle = 'rgba(239,231,215,0.55)';
  ctx.font = '400 12px "Courier Prime"';
  [100, 1000, 10000].forEach((f) => ctx.fillText(f === 1000 ? '1k' : f === 10000 ? '10k' : '100', xOf(f) - 10, sy + sh + 18));

  ctx.fillStyle = 'rgba(239,231,215,0.85)';
  ctx.font = '400 13px "Courier Prime"';
  ctx.fillText('Tonal balance', sx + 16, sy + 26);
  ctx.fillStyle = '#7f9caf';
  ctx.fillRect(sx + sw - 190, sy + 20, 14, 2);
  ctx.fillStyle = 'rgba(239,231,215,0.55)';
  ctx.font = '400 11px "Courier Prime"';
  ctx.fillText('Original', sx + sw - 170, sy + 26);
  ctx.fillStyle = '#d4553d';
  ctx.fillRect(sx + sw - 88, sy + 20, 14, 2);
  ctx.fillStyle = 'rgba(239,231,215,0.55)';
  ctx.fillText('Device', sx + sw - 68, sy + 26);

  // ---- notes -----------------------------------------------------------
  ctx.fillStyle = '#bf3b25';
  ctx.font = '400 13px "Courier Prime"';
  ctx.fillText('What changes', 64, 1128);

  let y = 1172;
  report.notes.slice(0, 4).forEach((n) => {
    ctx.fillStyle = '#bf3b25';
    ctx.font = '700 19px "Courier Prime"';
    ctx.fillText('×', 64, y);
    ctx.fillStyle = '#1b1914';
    ctx.font = '400 20px "Courier Prime"';
    ctx.fillText(n, 88, y);
    y += 40;
  });

  // closing note
  ctx.fillStyle = '#403a2e';
  ctx.font = '500 25px Fraunces';
  ctx.fillText(report.matchMode === 'off'
    ? 'Raw model level — adjust by ear.'
    : report.matchMode === 'lufs'
      ? 'LUFS matched: tone, not volume.'
      : 'Perceptually matched: tone, not volume.', 64, 1352);

  // ---- footer ----------------------------------------------------------
  ctx.strokeStyle = 'rgba(27,25,20,0.35)';
  ctx.beginPath();
  ctx.moveTo(64, 1402);
  ctx.lineTo(1136, 1402);
  ctx.stroke();

  ctx.fillStyle = '#1b1914';
  ctx.font = '500 27px Fraunces';
  ctx.fillText('Translate', 64, 1442);

  ctx.fillStyle = '#7c7361';
  ctx.font = '400 12.5px "Courier Prime"';
  ctx.fillText('a private playback-translation check · your master never leaves the machine', 64, 1466);

  ctx.fillStyle = '#bf3b25';
  ctx.font = '400 13px "Courier Prime"';
  ctx.textAlign = 'right';
  ctx.fillText('hear it everywhere', 1136, 1442);
  ctx.textAlign = 'left';

  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `translate-${state.device}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }, 'image/png');
}

el.shareCard.addEventListener('click', makeShareCard);

el.copyReport.addEventListener('click', async () => {
  const report = engine.report(state.device);
  if (!report) return;
  const orig = engine.analysis.original;
  const text = [
    `Translate — ${el.trackName.textContent}`,
    `${report.device.name} · ${report.device.report.headline}`,
    `Integrated ${orig.lufs.toFixed(1)} LUFS · True peak ${orig.truePeakDb.toFixed(1)} dBTP · ${report.matchMode === 'off' ? 'raw level' : `${report.matchMode === 'lufs' ? 'LUFS' : 'perceptual'} match ${report.matchDb >= 0 ? '+' : '−'}${Math.abs(report.matchDb).toFixed(1)} dB (device ${report.lufs.toFixed(1)} LUFS)`}`,
    `Low ${report.low.toFixed(1)} dB · Presence ${report.presence.toFixed(1)} dB · Width ${report.widthRatio <= 0.06 ? 'mono' : Math.round(report.widthRatio * 100) + '% of original'}`,
    '',
    ...report.notes.map((n) => `· ${n}`),
    '',
    'Measured locally in the browser. Nothing uploaded.'
  ].join('\n');

  try {
    await navigator.clipboard.writeText(text);
    toast('Report copied.');
  } catch (e) {
    toast('Copy failed — clipboard is blocked here.');
  }
});

/* keyboard */
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.key.toLowerCase() === 'b') {
    toggleBlind();
  } else if (e.key.toLowerCase() === 'x') {
    if (state.ready) setOriginal(!state.original);
  } else if (/^[1-6]$/.test(e.key)) {
    const device = DEVICES[Number(e.key) - 1];
    if (device) selectDevice(device.id);
  }
});

/* ------------------------------------------------------------------- update */

function updateAll () {
  updateTitle();
  updateAB();
  updateMatch();
  updateReport();
  updatePlayButton();
}

/* ------------------------------------------------------------------- resize */

function onResize () {
  if (!state.track) return;
  state.peakWidth = Math.max(80, Math.floor(el.wave.clientWidth));
  state.peaks = computePeaks(state.track, state.peakWidth);
  drawWaveform();
  drawPlayhead();
  drawSpectrum();
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(onResize, 120);
});

/* -------------------------------------------------------------------- loop */

function animate () {
  if (state.track) drawPlayhead();
  requestAnimationFrame(animate);
}

/* -------------------------------------------------------------------- boot */

renderDevices();
updateAB();
updateTitle();
requestAnimationFrame(animate);

// Stop audio when the page is hidden or closed.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && engine.playing) {
    engine.pause();
    updatePlayButton();
  }
});
window.addEventListener('beforeunload', () => engine.pause());

// Expose for local debugging in the console.
window.translate = { engine, state, DEVICES };
