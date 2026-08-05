/**
 * Blink. Select. Speak. — script.js
 *
 * Architecture:
 *   State machine  → manages screen transitions (landing / calibration / keyboard)
 *   MediaPipe      → FaceMesh with iris landmarks (refineLandmarks: true)
 *   Calibration    → 9-point iris → screen mapping, stored as affine warp
 *   Gaze tracker   → maps live iris position to screen pixel coords
 *   Blink detector → eye-aspect-ratio (EAR) on eyelid landmarks
 *   Blink selector → physical blink activates the gazed key
 *   TTS            → SpeechSynthesisUtterance for Speak button + phrase pills
 */

'use strict';

/* ═══════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════ */
const BLINK_EAR_THRESH  = 0.22;  // EAR below this → blink
const BLINK_MIN_FRAMES  = 2;     // consecutive frames to confirm blink
const BLINK_MAX_FRAMES  = 10;    // above this → eye closed, not a blink
const EAR_SMOOTH        = 0.35;  // IIR smoothing factor for EAR
const GAZE_EASE         = 0.06;  // visible cursor easing toward filtered target
const GAZE_TARGET_EASE  = 0.08;  // raw gaze damping before cursor movement
const GAZE_NOISE_PX     = 18;    // ignore tiny raw shifts from head/eye jitter
const CALIB_HOLD_MS     = 900;   // ms to hold gaze at each calibration point

// Calibration points as [x%, y%] of viewport
const CALIB_POINTS = [
  [0.08, 0.12], [0.50, 0.12], [0.92, 0.12],
  [0.08, 0.50], [0.50, 0.50], [0.92, 0.50],
  [0.08, 0.88], [0.50, 0.88], [0.92, 0.88],
];

/* ═══════════════════════════════════════════════
   MediaPipe FaceMesh landmark indices
═══════════════════════════════════════════════ */
// Iris centres (available with refineLandmarks: true)
const LEFT_IRIS   = 468;
const RIGHT_IRIS  = 473;

// Eyelid landmarks for EAR — left eye
const LEFT_EYE_TOP    = [159, 160, 161];
const LEFT_EYE_BOT    = [145, 144, 163];
const LEFT_EYE_LEFT   = 33;
const LEFT_EYE_RIGHT  = 133;

// Eyelid landmarks for EAR — right eye
const RIGHT_EYE_TOP   = [386, 387, 388];
const RIGHT_EYE_BOT   = [374, 373, 380];
const RIGHT_EYE_LEFT  = 362;
const RIGHT_EYE_RIGHT = 263;

/* ═══════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════ */
const state = {
  screen: 'landing',  // 'landing' | 'calibration' | 'keyboard'
  outputText: '',

  // Calibration
  calibIndex: 0,
  calibSamples: [],      // [{irisX, irisY}] collected per point
  calibMapping: null,    // [{screen:{x,y}, feature:{x,y}}]
  calibModel: null,
  calibHoldStart: null,
  calibRingInterval: null,

  // Gaze
  gazeX: 0,
  gazeY: 0,
  gazeTargetX: 0,
  gazeTargetY: 0,
  gazeReady: false,
  gazedEl: null,
  dwellStart: null,
  dwellTimeout: null,
  dwellEl: null,

  // Blink
  earSmooth: 1.0,
  blinkFrames: 0,
  inBlink: false,
  lastBlinkAt: 0,

  // FaceMesh
  faceMesh: null,
  camera: null,
  faceMeshReady: false,
};

/* ═══════════════════════════════════════════════
   DOM REFERENCES
═══════════════════════════════════════════════ */
const screens = {
  landing:      document.getElementById('screen-landing'),
  calibration:  document.getElementById('screen-calibration'),
  keyboard:     document.getElementById('screen-keyboard'),
};

const dom = {
  btnStart:        document.getElementById('btn-start'),
  btnSkip:         document.getElementById('btn-skip'),
  btnRecalibrate:  document.getElementById('btn-recalibrate'),
  btnSpeakHeader:  document.getElementById('btn-speak-header'),
  btnSpeakKb:      document.getElementById('btn-speak-kb'),

  calibDot:        document.getElementById('calib-dot'),
  calibRingArc:    document.getElementById('calib-ring-arc'),
  calibLabel:      document.getElementById('calib-label'),

  calibVideo:      document.getElementById('calib-video'),
  calibEyeOverlay: document.getElementById('calib-eye-overlay'),
  calibNoCam:      document.getElementById('calib-no-camera'),
  calibEyeDot:     document.getElementById('calib-eye-dot'),
  calibEyeLabel:   document.getElementById('calib-eye-label'),

  kbOutputDisplay: document.getElementById('kb-output-display'),
  kbSelectedBadge: document.getElementById('kb-selected-badge'),
  kbEyeDot:        document.getElementById('kb-eye-dot'),
  kbEyeLabel:      document.getElementById('kb-eye-label'),
  kbVideo:         document.getElementById('kb-video'),
  kbEyeOverlay:    document.getElementById('kb-eye-overlay'),
  kbNoCam:         document.getElementById('kb-no-camera'),
  gazeCursor:      null,

  dwellRing:       document.getElementById('dwell-ring-container'),
  dwellArc:        document.getElementById('dwell-arc'),

  phraseRow:       document.querySelector('.kb-phrase-row'),
  keyboardArea:    document.getElementById('kb-keyboard-area'),
};

/* ═══════════════════════════════════════════════
   SCREEN TRANSITIONS
═══════════════════════════════════════════════ */
function goTo(screenName) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[screenName].classList.add('active');
  state.screen = screenName;

  if (screenName !== 'keyboard') {
    updateGazeCursor(null);
  }
}

/* ═══════════════════════════════════════════════
   LANDING → CALIBRATION
═══════════════════════════════════════════════ */
dom.btnStart.addEventListener('click', () => {
  goTo('calibration');
  startCamera();
  startCalibration();
});

/* ═══════════════════════════════════════════════
   CAMERA SETUP
   One camera stream, shared between screens via
   srcObject assignment. MediaPipe processes from
   the hidden calibration video element.
═══════════════════════════════════════════════ */
let streamRef = null;

async function startCamera() {
  try {
    streamRef = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
    dom.calibVideo.srcObject = streamRef;
    dom.kbVideo.srcObject = streamRef;
    dom.calibNoCam.style.display = 'none';
    dom.kbNoCam.style.display = 'none';
  } catch (err) {
    console.warn('Camera unavailable:', err);
    setEyeStatus(false, 'No camera');
  }
}

/* ═══════════════════════════════════════════════
   MEDIAPIPE FACE MESH SETUP
═══════════════════════════════════════════════ */
function initFaceMesh(onResults) {
  const fm = new FaceMesh({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
  });

  fm.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,  // enables iris landmarks 468-477
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5,
  });

  fm.onResults(onResults);
  state.faceMesh = fm;

  // Use MediaPipe Camera util to pump frames
  const videoEl = dom.calibVideo;  // reuse for both screens (srcObject shared)
  const cam = new Camera(videoEl, {
    onFrame: async () => {
      if (videoEl.readyState >= 2) {
        await fm.send({ image: videoEl });
      }
    },
    width: 640,
    height: 480,
  });
  cam.start();
  state.camera = cam;
  state.faceMeshReady = true;
}

/* ═══════════════════════════════════════════════
   EAR (Eye Aspect Ratio) helper
═══════════════════════════════════════════════ */
function euclidean(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function computeEAR(lm, topIdx, botIdx, leftIdx, rightIdx) {
  const top = topIdx.map(i => lm[i]);
  const bot = botIdx.map(i => lm[i]);

  let vertical = 0;
  for (let i = 0; i < top.length; i++) {
    vertical += euclidean(top[i], bot[i]);
  }
  vertical /= top.length;

  const horiz = euclidean(lm[leftIdx], lm[rightIdx]);
  return horiz > 0 ? vertical / horiz : 1.0;
}

function avgEAR(lm) {
  const earL = computeEAR(lm, LEFT_EYE_TOP, LEFT_EYE_BOT, LEFT_EYE_LEFT, LEFT_EYE_RIGHT);
  const earR = computeEAR(lm, RIGHT_EYE_TOP, RIGHT_EYE_BOT, RIGHT_EYE_LEFT, RIGHT_EYE_RIGHT);
  return (earL + earR) / 2;
}

/* ═══════════════════════════════════════════════
   IRIS POSITION (average of both irises, normalised 0-1)
═══════════════════════════════════════════════ */
function getIrisPos(lm) {
  if (lm.length <= 473) return null;
  return {
    x: (lm[LEFT_IRIS].x + lm[RIGHT_IRIS].x) / 2,
    y: (lm[LEFT_IRIS].y + lm[RIGHT_IRIS].y) / 2,
  };
}

function averagePoint(points) {
  return {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length,
  };
}

function getGazeFeature(lm) {
  if (lm.length <= RIGHT_IRIS) return null;

  const leftTop = averagePoint(LEFT_EYE_TOP.map(i => lm[i]));
  const leftBot = averagePoint(LEFT_EYE_BOT.map(i => lm[i]));
  const rightTop = averagePoint(RIGHT_EYE_TOP.map(i => lm[i]));
  const rightBot = averagePoint(RIGHT_EYE_BOT.map(i => lm[i]));

  const leftWidth = lm[LEFT_EYE_RIGHT].x - lm[LEFT_EYE_LEFT].x;
  const rightWidth = lm[RIGHT_EYE_RIGHT].x - lm[RIGHT_EYE_LEFT].x;
  const leftHeight = leftBot.y - leftTop.y;
  const rightHeight = rightBot.y - rightTop.y;

  if (Math.abs(leftWidth) < 0.001 || Math.abs(rightWidth) < 0.001 ||
      Math.abs(leftHeight) < 0.001 || Math.abs(rightHeight) < 0.001) {
    return null;
  }

  const left = {
    x: (lm[LEFT_IRIS].x - lm[LEFT_EYE_LEFT].x) / leftWidth,
    y: (lm[LEFT_IRIS].y - leftTop.y) / leftHeight,
  };
  const right = {
    x: (lm[RIGHT_IRIS].x - lm[RIGHT_EYE_LEFT].x) / rightWidth,
    y: (lm[RIGHT_IRIS].y - rightTop.y) / rightHeight,
  };

  return {
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2,
  };
}

/* ═══════════════════════════════════════════════
   CALIBRATION
═══════════════════════════════════════════════ */
function startCalibration() {
  state.calibIndex = 0;
  state.calibSamples = [];
  state.calibMapping = [];
  state.calibModel = null;
  state.calibHoldStart = null;

  // Init FaceMesh with calibration callback
  if (!state.faceMeshReady) {
    initFaceMesh(onCalibFrame);
  } else {
    state.faceMesh.onResults(onCalibFrame);
  }

  showCalibPoint(0);
}

function showCalibPoint(idx) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const [px, py] = CALIB_POINTS[idx];

  dom.calibDot.style.left = `${px * vw}px`;
  dom.calibDot.style.top  = `${py * vh}px`;
  dom.calibLabel.textContent = `Point ${idx + 1} of ${CALIB_POINTS.length} - hold steady`;
  dom.calibRingArc.style.strokeDashoffset = '251.2';

  state.calibHoldStart = null;
  state.calibSamples[idx] = [];
}

function onCalibFrame(results) {
  if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
    setEyeStatus(false, 'No face detected');
    drawEyeMarkers(null);
    return;
  }

  const lm = results.multiFaceLandmarks[0];
  const feature = getGazeFeature(lm);
  if (!feature) return;

  setEyeStatus(true, 'Eyes detected');
  drawEyeMarkers(lm);

  const now = performance.now();
  const idx  = state.calibIndex;

  if (!state.calibHoldStart) state.calibHoldStart = now;

  const elapsed  = now - state.calibHoldStart;
  const fraction = Math.min(elapsed / CALIB_HOLD_MS, 1.0);

  // Animate progress ring (stroke-dashoffset from 251.2 → 0)
  dom.calibRingArc.style.strokeDashoffset = `${251.2 * (1 - fraction)}`;

  // Collect samples during last 200ms of hold (after user has settled)
  if (fraction > 0.7) {
    state.calibSamples[idx] = state.calibSamples[idx] || [];
    state.calibSamples[idx].push(feature);
  }

  if (fraction >= 1.0) {
    advanceCalibration(idx);
  }
}

function advanceCalibration(idx) {
  // Average collected gaze samples, trimming outliers from each axis.
  const samples = state.calibSamples[idx] || [];
  if (samples.length === 0) return;

  const avgFeature = trimmedAverage(samples);

  const [px, py] = CALIB_POINTS[idx];
  state.calibMapping[idx] = {
    screen: { x: px * window.innerWidth, y: py * window.innerHeight },
    feature: avgFeature,
  };

  const next = idx + 1;
  if (next < CALIB_POINTS.length) {
    state.calibIndex = next;
    showCalibPoint(next);
  } else {
    finishCalibration();
  }
}

function finishCalibration() {
  // Hand off to keyboard screen
  state.calibModel = fitCalibrationModel(state.calibMapping);
  state.gazeReady = false;
  state.faceMesh.onResults(onGazeFrame);
  goTo('keyboard');
  renderOutput();
}

/* ═══════════════════════════════════════════════
   SKIP calibration (bypass with no mapping → mouse fallback)
═══════════════════════════════════════════════ */
dom.btnSkip.addEventListener('click', () => {
  state.calibMapping = null;
  state.calibModel = null;
  state.gazeReady = false;
  if (state.faceMeshReady) {
    state.faceMesh.onResults(onGazeFrame);
  } else {
    initFaceMesh(onGazeFrame);
  }
  goTo('keyboard');
  renderOutput();
  setEyeStatus(false, 'Calibration skipped');
});

dom.btnRecalibrate.addEventListener('click', () => {
  goTo('calibration');
  state.calibIndex = 0;
  state.calibSamples = [];
  state.calibMapping = [];
  state.calibModel = null;
  state.gazeReady = false;
  state.faceMesh.onResults(onCalibFrame);
  showCalibPoint(0);
});

/* ═══════════════════════════════════════════════
   GAZE MAPPING
   Uses bilinear interpolation from the 9 calibration
   points.  Falls back to nearest-neighbour if < 4 points.
═══════════════════════════════════════════════ */
function trimmedAverage(samples) {
  const trimAxis = axis => {
    const values = samples.map(p => p[axis]).sort((a, b) => a - b);
    const trim = Math.floor(values.length * 0.15);
    const kept = values.slice(trim, values.length - trim || values.length);
    return kept.reduce((s, v) => s + v, 0) / kept.length;
  };

  return { x: trimAxis('x'), y: trimAxis('y') };
}

function fitCalibrationModel(mapping) {
  if (!mapping || mapping.length < 4) return null;

  const averageFeature = pts => ({
    x: pts.reduce((s, pt) => s + pt.feature.x, 0) / pts.length,
    y: pts.reduce((s, pt) => s + pt.feature.y, 0) / pts.length,
  });
  const minScreenX = Math.min(...mapping.map(pt => pt.screen.x));
  const maxScreenX = Math.max(...mapping.map(pt => pt.screen.x));
  const minScreenY = Math.min(...mapping.map(pt => pt.screen.y));
  const maxScreenY = Math.max(...mapping.map(pt => pt.screen.y));
  const edgeEpsilon = 1;

  const left = averageFeature(mapping.filter(pt => Math.abs(pt.screen.x - minScreenX) < edgeEpsilon));
  const right = averageFeature(mapping.filter(pt => Math.abs(pt.screen.x - maxScreenX) < edgeEpsilon));
  const top = averageFeature(mapping.filter(pt => Math.abs(pt.screen.y - minScreenY) < edgeEpsilon));
  const bottom = averageFeature(mapping.filter(pt => Math.abs(pt.screen.y - maxScreenY) < edgeEpsilon));

  const xSpan = right.x - left.x;
  const ySpan = bottom.y - top.y;
  if (Math.abs(xSpan) < 0.0001 || Math.abs(ySpan) < 0.0001) return null;

  return {
    leftX: left.x,
    rightX: right.x,
    topY: top.y,
    bottomY: bottom.y,
  };
}

function mapFeatureToScreen(feature) {
  const mapping = state.calibMapping;
  if (!mapping || mapping.length < 4) return null;
  if (state.calibModel) {
    const model = state.calibModel;
    const nx = (feature.x - model.leftX) / (model.rightX - model.leftX);
    const ny = (feature.y - model.topY) / (model.bottomY - model.topY);

    return {
      x: nx * window.innerWidth,
      y: ny * window.innerHeight,
    };
  }

  // Weighted average: weight = 1 / distance² in iris space
  let sumW = 0, sumX = 0, sumY = 0;
  for (const pt of mapping) {
    const dx = feature.x - pt.feature.x;
    const dy = feature.y - pt.feature.y;
    const d2 = dx * dx + dy * dy;
    const w  = d2 < 1e-10 ? 1e10 : 1 / d2;
    sumW += w;
    sumX += w * pt.screen.x;
    sumY += w * pt.screen.y;
  }
  return { x: sumX / sumW, y: sumY / sumW };
}

/* ═══════════════════════════════════════════════
   GAZE FRAME HANDLER  (runs every frame on keyboard screen)
═══════════════════════════════════════════════ */
function onGazeFrame(results) {
  if (state.screen !== 'keyboard') return;

  if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
    setEyeStatus(false, 'No face');
    clearDwell();
    drawEyeMarkers(null);
    state.gazeReady = false;
    updateGazeCursor(null);
    return;
  }

  const lm = results.multiFaceLandmarks[0];
  setEyeStatus(true, 'Eyes detected');
  drawEyeMarkers(lm);

  // ── Blink detection ───────────────────────────
  const ear = avgEAR(lm);
  state.earSmooth = state.earSmooth * (1 - EAR_SMOOTH) + ear * EAR_SMOOTH;
  const eyesClosed = state.earSmooth < BLINK_EAR_THRESH;

  if (eyesClosed) {
    state.blinkFrames++;
  } else {
    if (
      state.blinkFrames >= BLINK_MIN_FRAMES &&
      state.blinkFrames <= BLINK_MAX_FRAMES &&
      !state.inBlink
    ) {
      // Valid blink → select current element
      const now = performance.now();
      if (now - state.lastBlinkAt > 600) {   // debounce 600ms
        state.lastBlinkAt = now;
        updateGazeHighlight(state.gazeX, state.gazeY);
        selectCurrentGazedEl();
      }
    }
    state.blinkFrames = 0;
    state.inBlink = eyesClosed;
  }

  if (eyesClosed) {
    updateGazeCursor(state.gazeReady ? { x: state.gazeX, y: state.gazeY } : null);
    return;
  }

  // ── Gaze estimation ───────────────────────────
  const feature = getGazeFeature(lm);
  if (!feature) return;

  const mapped = mapFeatureToScreen(feature);
  if (!mapped) return;

  const targetX = Math.max(0, Math.min(window.innerWidth, mapped.x));
  const targetY = Math.max(0, Math.min(window.innerHeight, mapped.y));

  if (!state.gazeReady) {
    state.gazeX = targetX;
    state.gazeY = targetY;
    state.gazeTargetX = targetX;
    state.gazeTargetY = targetY;
    state.gazeReady = true;
  } else {
    const rawDelta = Math.hypot(targetX - state.gazeTargetX, targetY - state.gazeTargetY);
    if (rawDelta > GAZE_NOISE_PX) {
      state.gazeTargetX += (targetX - state.gazeTargetX) * GAZE_TARGET_EASE;
      state.gazeTargetY += (targetY - state.gazeTargetY) * GAZE_TARGET_EASE;
    }

    state.gazeX += (state.gazeTargetX - state.gazeX) * GAZE_EASE;
    state.gazeY += (state.gazeTargetY - state.gazeY) * GAZE_EASE;
  }

  updateGazeCursor({ x: state.gazeX, y: state.gazeY });
  updateGazeHighlight(state.gazeX, state.gazeY);
}

/* ═══════════════════════════════════════════════
   GAZE HIGHLIGHT + DWELL
═══════════════════════════════════════════════ */
function getInteractiveElements() {
  return [
    ...dom.keyboardArea.querySelectorAll('.key'),
    ...dom.phraseRow.querySelectorAll('.phrase-pill'),
  ];
}

function getNearestInteractiveElement(gx, gy) {
  let nearest  = null;
  let minDist  = Infinity;

  for (const el of getInteractiveElements()) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width  / 2;
    const cy = r.top  + r.height / 2;
    const d  = Math.hypot(gx - cx, gy - cy);
    if (d < minDist) {
      minDist  = d;
      nearest  = el;
    }
  }

  // Only highlight if gaze is within reasonable distance
  const threshold = 200;  // px
  if (minDist > threshold) nearest = null;
  return nearest;
}

function updateGazeHighlight(gx, gy) {
  const nearest = getNearestInteractiveElement(gx, gy);

  if (nearest !== state.gazedEl) {
    // Clear old
    if (state.gazedEl) state.gazedEl.classList.remove('gazed');
    clearDwell();

    state.gazedEl = nearest;
    if (nearest) {
      nearest.classList.add('gazed');
    }
  }
}

function clearDwell() {
  state.dwellStart = null;
  state.dwellEl    = null;
  dom.dwellRing.style.display = 'none';
  dom.dwellArc.style.strokeDashoffset = '138.2';
}

function selectCurrentGazedEl() {
  const el = state.gazeReady ? getNearestInteractiveElement(state.gazeX, state.gazeY) : state.gazedEl;
  if (!el) return;

  el.classList.add('pressed');
  setTimeout(() => el.classList.remove('pressed'), 150);

  clearDwell();

  // Dispatch the action
  activateElement(el);
}

/* ═══════════════════════════════════════════════
   ELEMENT ACTIVATION (keyboard + phrases)
═══════════════════════════════════════════════ */
function activateElement(el) {
  // Quick-phrase pill
  if (el.classList.contains('phrase-pill')) {
    const phrase = el.dataset.phrase;
    if (phrase) {
      state.outputText = phrase;
      renderOutput();
      speakText(phrase);
    }
    return;
  }

  // Regular key
  const ch = el.dataset.char;
  if (ch !== undefined) {
    state.outputText += ch;
    renderOutput(true);
    return;
  }

  // Action keys
  const action = el.dataset.action;
  if (action === 'delete') {
    state.outputText = state.outputText.slice(0, -1);
    renderOutput();
  } else if (action === 'space') {
    state.outputText += ' ';
    renderOutput();
  } else if (action === 'clear') {
    state.outputText = '';
    renderOutput();
  } else if (action === 'speak') {
    speakText(state.outputText);
  }
}

/* ═══════════════════════════════════════════════
   OUTPUT RENDERING
═══════════════════════════════════════════════ */
function renderOutput(showBadge = false) {
  const text = state.outputText;
  const disp = dom.kbOutputDisplay;
  disp.innerHTML = '';

  if (text.length === 0) {
    disp.textContent = '';
    dom.kbSelectedBadge.style.display = 'none';
    return;
  }

  // All chars except last
  if (text.length > 1) {
    const before = document.createElement('span');
    before.textContent = text.slice(0, -1);
    disp.appendChild(before);
  }

  // Last char highlighted
  const last = document.createElement('span');
  last.className = 'output-char--last';
  last.textContent = text.slice(-1);
  disp.appendChild(last);

  // Flash "Selected!" badge
  if (showBadge) {
    dom.kbSelectedBadge.style.display = 'inline-flex';
    clearTimeout(dom.kbSelectedBadge._t);
    dom.kbSelectedBadge._t = setTimeout(() => {
      dom.kbSelectedBadge.style.display = 'none';
    }, 1000);
  } else {
    dom.kbSelectedBadge.style.display = 'none';
  }
}

/* ═══════════════════════════════════════════════
   TEXT-TO-SPEECH
═══════════════════════════════════════════════ */
function speakText(text) {
  if (!text || !text.trim()) return;
  if (!('speechSynthesis' in window)) return;

  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.rate   = 0.9;
  utt.pitch  = 1.0;
  utt.volume = 1.0;
  window.speechSynthesis.speak(utt);
}

/* ═══════════════════════════════════════════════
   BUTTON CLICK HANDLERS (for mouse / pointer fallback)
═══════════════════════════════════════════════ */
dom.btnSpeakHeader.addEventListener('click', () => speakText(state.outputText));
dom.btnSpeakKb.addEventListener('click',     () => speakText(state.outputText));

// Phrase pills — click
dom.phraseRow.addEventListener('click', e => {
  const pill = e.target.closest('.phrase-pill');
  if (pill) activateElement(pill);
});

// Keyboard keys — click
dom.keyboardArea.addEventListener('click', e => {
  const key = e.target.closest('.key');
  if (key) activateElement(key);
});

/* ═══════════════════════════════════════════════
   EYE STATUS INDICATOR
═══════════════════════════════════════════════ */
function setEyeStatus(detected, label) {
  const cls = detected ? 'eye-dot--on' : 'eye-dot--off';
  const rem  = detected ? 'eye-dot--off' : 'eye-dot--on';

  [dom.calibEyeDot, dom.kbEyeDot].forEach(dot => {
    if (!dot) return;
    dot.classList.add(cls);
    dot.classList.remove(rem);
  });
  if (dom.calibEyeLabel) dom.calibEyeLabel.textContent = label;
  if (dom.kbEyeLabel)    dom.kbEyeLabel.textContent    = label;
}

function ensureGazeCursor() {
  if (dom.gazeCursor) return dom.gazeCursor;

  const cursor = document.createElement('div');
  cursor.setAttribute('aria-hidden', 'true');
  Object.assign(cursor.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '20px',
    height: '20px',
    marginLeft: '-10px',
    marginTop: '-10px',
    borderRadius: '50%',
    background: 'rgba(91, 141, 239, 0.38)',
    border: '1px solid rgba(91, 141, 239, 0.9)',
    boxShadow: '0 0 12px rgba(91, 141, 239, 0.35)',
    pointerEvents: 'none',
    zIndex: '1000',
    display: 'none',
    transform: 'translate3d(0, 0, 0)',
  });

  document.body.appendChild(cursor);
  dom.gazeCursor = cursor;
  return cursor;
}

function updateGazeCursor(point) {
  const cursor = ensureGazeCursor();
  if (!point || state.screen !== 'keyboard') {
    cursor.style.display = 'none';
    return;
  }

  cursor.style.display = 'block';
  cursor.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
}

function drawEyeMarkers(lm) {
  drawEyeMarkersOn(dom.calibEyeOverlay, lm);
  drawEyeMarkersOn(dom.kbEyeOverlay, lm);
}

function drawEyeMarkersOn(canvas, lm) {
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  if (!lm || lm.length <= RIGHT_IRIS) return;

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#5B8DEF';
  ctx.fillStyle = 'rgba(91, 141, 239, 0.12)';

  [lm[LEFT_IRIS], lm[RIGHT_IRIS]].forEach(eye => {
    const x = eye.x * rect.width;
    const y = eye.y * rect.height;
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });

  ctx.restore();
}

/* ═══════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════ */
// MediaPipe script loading guard — init lazily on first camera start
// (initFaceMesh called from startCalibration / btnSkip)
// Nothing to do at page load beyond showing the landing screen.

console.log('[BlinkSelectSpeak] Ready. Click > START to begin.');
