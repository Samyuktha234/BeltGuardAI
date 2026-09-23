require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const twilioAlertService = require('./services/twilioAlertService');

const app = express();
const PORT = process.env.PORT || 5000;
const CSV_PATH = path.join(__dirname, 'conveyor_fault_dataset.csv');

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '4mb' })); // raised from default to allow base64 camera frames

let dataset = [];
let baseline = { mean: null, std: null, count: 0, values: [] };
let liveHistory = [];
let alerts = [];

/* =========================
   ESP32 COMMAND STATE
   Backend is the source of truth. The current system condition
   determines what actuator commands the ESP32 should apply.
   ESP32 polls GET /api/esp32/command to get the latest command.
======================== */
let esp32Command = {
  status: 'NORMAL',
  buzzer: false,
  redLed: false,
  greenLed: true,
  timestamp: new Date().toISOString()
};

let esp32State = {
  connected: false,
  lastHeartbeatAt: null,
  lastVibrationAt: null,
  vibrationValue: null
};

const ESP32_HEARTBEAT_TIMEOUT_MS = 15000;

function updateEsp32Command(condition) {
  const normalized = String(condition || 'NORMAL').toUpperCase();
  switch (normalized) {
    case 'CRITICAL':
      esp32Command = {
        status: 'CRITICAL',
        buzzer: true,
        redLed: true,
        greenLed: false,
        timestamp: new Date().toISOString()
      };
      break;
    case 'WARNING':
      esp32Command = {
        status: 'WARNING',
        buzzer: false,
        redLed: true,
        greenLed: false,
        timestamp: new Date().toISOString()
      };
      break;
    default:
      esp32Command = {
        status: 'NORMAL',
        buzzer: false,
        redLed: false,
        greenLed: true,
        timestamp: new Date().toISOString()
      };
  }
}

function getEsp32ConnectionStatus() {
  if (!esp32State.lastHeartbeatAt && !esp32State.lastVibrationAt) return 'OFFLINE';
  const now = Date.now();
  const lastActivity = Math.max(
    esp32State.lastHeartbeatAt || 0,
    esp32State.lastVibrationAt || 0
  );
  if (now - lastActivity <= ESP32_HEARTBEAT_TIMEOUT_MS) return 'CONNECTED';
  return 'OFFLINE';
}

/* =========================
   ALERT DEBOUNCING
   Live polling can call /api/analyze or /api/live several times a
   second; without debouncing that would create one alert per poll for
   as long as the belt stays in WARNING/CRITICAL. Only record a new
   alert when the condition actually changes, or the previous alert for
   the same condition has aged past ALERT_REPEAT_MS.
========================= */
const ALERT_REPEAT_MS = 30000;
let lastAlertCondition = null;
let lastAlertAt = 0;

// Live alerts must only ever be generated from real live sensor/camera
// evidence. Dataset playback and Test Mode use the same analyze()
// pipeline for convenience, but must never contaminate the live alert
// history — so anything not explicitly tagged context: 'LIVE' is
// recorded into its own isolated list instead of `alerts`.
let datasetEvents = [];
let testEvents = [];

/* =========================
   SMS ALERT STATE (Twilio)
   Reuses the same LIVE-only condition the dashboard already shows
   (the hysteresis-confirmed vibration condition behind the "Overall
   Condition" orbit) — this is not a second, independent threshold.
   One SMS per transition INTO CRITICAL, enforced by the
   inCriticalAlert streak gate below: a genuinely new CRITICAL streak
   always texts. SMS_ALERT_COOLDOWN_MS is an OPTIONAL time backstop
   (default 0 = off) for operators who want to cap repeat sends
   during sustained on/off alarm flicker.
========================= */
const SMS_ALERT_COOLDOWN_MS = Number(process.env.SMS_ALERT_COOLDOWN_MS) || 0; // 0 = off — streak gate handles dedup
let smsAlertState = {
  inCriticalAlert: false, // true while the current CRITICAL streak has already been handled
  lastSentAt: 0,
  status: twilioAlertService.isConfigured() ? null : 'NOT_CONFIGURED', // null = no CRITICAL event yet this session
  sentAt: null,
  error: null,
  note: null
};

function getSmsSnapshot() {
  return {
    configured: twilioAlertService.isConfigured(),
    status: smsAlertState.status,
    sentAt: smsAlertState.sentAt,
    error: smsAlertState.error,
    note: smsAlertState.note
  };
}

// Builds the SMS content from the ACTUAL current live vibration
// analysis + fusion output — nothing here is invented. Live Mode only
// ever has vibration + camera evidence (never speed/load/temperature/
// current, which only exist in Dataset/Test CSV rows), so those fields
// are simply left out of alertData and the message builder omits them.
function buildLiveSmsAlertData(vibrationResult, fusion) {
  const cam = cameraState.latest;
  const camStatus = cameraConnectionStatus();
  const camFresh = camStatus === 'CONNECTED' || camStatus === 'STALE';

  return {
    vibration: (vibrationResult && !vibrationResult.calibrating) ? vibrationResult.vibration : null,
    predictedFault: vibrationResult?.mlFaultAssociation || null,
    confidencePct: vibrationResult?.mlConfidence != null ? Math.round(vibrationResult.mlConfidence * 100) : null,
    // Same derivation the dashboard itself uses for "Overall Belt Health" (100 - finalRisk).
    healthScore: fusion?.finalRisk != null ? Math.round(Math.max(0, Math.min(100, 100 - fusion.finalRisk))) : null,
    aiConfidencePct: fusion?.confidence != null ? Math.round(fusion.confidence * 100) : null,
    visualInspection: camFresh && cam ? (cam.beltDetected ? 'Available' : 'Unavailable (belt not detected)') : null,
    recommendation: fusion?.recommendation || null
  };
}

// Called only for context === 'LIVE' (see buildFullAnalysis). Dataset
// Mode and Test Mode never reach this function, so they can never
// trigger a real SMS (spec requirement 10).
function handleLiveSmsForCondition(condition, vibrationResult, fusion) {
  if (condition !== 'CRITICAL') {
    // Any transition away from CRITICAL re-arms the alert so a later,
    // genuinely new CRITICAL event can send another SMS.
    smsAlertState.inCriticalAlert = false;
    return;
  }

  if (smsAlertState.inCriticalAlert) return; // still the same CRITICAL streak — already handled

  smsAlertState.inCriticalAlert = true;

  const cooldownElapsed = (Date.now() - smsAlertState.lastSentAt) >= SMS_ALERT_COOLDOWN_MS;
  if (!cooldownElapsed) return; // recent send already covers this streak

  console.log('[ALERT] CRITICAL condition detected');

  if (!twilioAlertService.isConfigured()) {
    smsAlertState.status = 'NOT_CONFIGURED';
    smsAlertState.error = null;
    return;
  }

  smsAlertState.status = 'PENDING';
  smsAlertState.error = null;
  const alertData = buildLiveSmsAlertData(vibrationResult, fusion);

  // Fire-and-forget: sensor processing/AI inference must never block on
  // network I/O to Twilio (spec requirement 5). sendCriticalAlert never
  // throws, but the catch below is a last-resort safety net anyway.
  console.log('[SMS] Critical SMS initiated');
  twilioAlertService.sendCriticalAlert(alertData)
    .then(result => {
      smsAlertState.lastSentAt = Date.now();
      smsAlertState.status = result.status;
      smsAlertState.sentAt = result.sentAt || null;
      smsAlertState.error = result.error || null;
      smsAlertState.note = result.note || null;
    })
    .catch(err => {
      smsAlertState.lastSentAt = Date.now();
      smsAlertState.status = 'FAILED';
      smsAlertState.error = err.message;
      smsAlertState.note = null;
    });

  // Emergency escalation: place the automated supervisor phone call for
  // the same CRITICAL transition. Fire-and-forget so it can never block
  // /api/live, ESP32, camera, or dashboard. sendCriticalVoiceCall never
  // throws; failing a call just logs and the backend keeps running.
  console.log('[VOICE] Critical voice call initiated');
  twilioAlertService.sendCriticalVoiceCall()
    .then(result => {
      if (result.status === 'INITIATED') {
        console.log(`[VOICE] Call initiated successfully: ${result.sid}`);
      } else {
        console.log(`[VOICE] Call failed: ${result.error || result.status}`);
      }
    })
    .catch(err => {
      console.log(`[VOICE] Call failed: ${err.message}`);
    });
}

function maybeRecordAlert(entry) {
  const context = entry.context || 'LIVE';
  const condition = entry.condition;

  if (context !== 'LIVE') {
    const bucket = context === 'DATASET' ? datasetEvents : testEvents;
    if (condition === 'WARNING' || condition === 'CRITICAL') {
      bucket.unshift(entry);
      if (bucket.length > 50) bucket.length = 50;
    }
    return;
  }

  if (condition !== 'WARNING' && condition !== 'CRITICAL') {
    lastAlertCondition = condition;
    return;
  }
  const now = Date.now();
  const sameConditionRecently =
    condition === lastAlertCondition && (now - lastAlertAt) < ALERT_REPEAT_MS;
  if (sameConditionRecently) return;

  alerts.unshift(entry);
  alerts = alerts.slice(0, 100);
  lastAlertCondition = condition;
  lastAlertAt = now;
}

/* =========================
   SENSOR FUSION CONFIG
   Single source of truth for fusion weights + freshness
   thresholds. Do not hard-code these values elsewhere.
   CAMERA is the internal primary evidence source, VIBRATION is
   secondary — this ratio is never surfaced in the UI.
========================= */
const FUSION_CONFIG = {
  CAMERA_WEIGHT: 0.60,
  VIBRATION_WEIGHT: 0.40,
  VIBRATION_FRESH_MS: 5000,   // considered LIVE within this window
  VIBRATION_STALE_MS: 15000,  // considered available (but stale) within this window; OFFLINE beyond
  CAMERA_FRESH_MS: 4000,      // OpenCV service posts observations frequently; tighter window than the old browser-upload path
  CAMERA_STALE_MS: 12000,
  MAX_FRAME_BYTES: 3 * 1024 * 1024 // ~3MB safety cap (legacy frame endpoint only)
};

/* =========================
   CAMERA / VISION STATE
   The camera is now a separate Python + OpenCV service capturing the
   laptop's built-in webcam. It POSTs structured observations
   here — the backend never opens a camera or runs OpenCV itself.
========================= */
let cameraState = {
  latest: null,      // last structured camera observation (see schema in /api/vision/observation)
  lastFrameAt: null  // ms timestamp this backend received the observation
};

function cameraConnectionStatus() {
  // Real states only — never fake ONLINE/LIVE/CONNECTED without a
  // recent observation actually having arrived from the OpenCV service.
  if (cameraState.lastFrameAt == null) return 'WAITING';
  const ageMs = Date.now() - cameraState.lastFrameAt;
  if (cameraState.latest && cameraState.latest.error) return 'ERROR';
  if (ageMs <= FUSION_CONFIG.CAMERA_FRESH_MS) return 'CONNECTED';
  if (ageMs <= FUSION_CONFIG.CAMERA_STALE_MS) return 'STALE';
  return 'OFFLINE';
}

function number(value) {
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, x) => s + (x - m) ** 2, 0) / values.length);
}

function conditionFromScore(score) {
  // Raised from the original 1.5/2.5/3.5 baseline-deviation breakpoints so
  // that ordinary sensor noise on the (visually more sensitive) chart no
  // longer trips WARNING/CRITICAL — alerts now require a clearly extreme
  // deviation from the established baseline, not just a small wobble.
  if (score < 2.0) return 'NORMAL';
  if (score < 3.0) return 'ADVISORY';
  if (score < 4.0) return 'WARNING';
  return 'CRITICAL';
}

/* =========================
   ROLLING VIBRATION FEATURES
   RMS / peak / variance / trend over a recent window of real live
   samples — used alongside the raw z-score so a single noisy reading
   can't drive the condition on its own.
========================= */
const ROLLING_FEATURE_WINDOW = 30;

function rollingFeatures(values) {
  if (!values.length) return null;
  const n = values.length;
  const rms = Math.sqrt(values.reduce((s, v) => s + v * v, 0) / n);
  const peak = Math.max(...values.map(v => Math.abs(v)));
  const variance = Math.pow(std(values), 2);
  let trend = 0;
  if (n >= 3) {
    const xs = values.map((_, i) => i);
    const mx = mean(xs), my = mean(values);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (values[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    trend = den > 0 ? num / den : 0;
  }
  return {
    rms: Number(rms.toFixed(4)),
    peak: Number(peak.toFixed(4)),
    variance: Number(variance.toFixed(5)),
    trend: Number(trend.toFixed(5))
  };
}

/* =========================
   HYSTERESIS / CONFIRMATION WINDOWS
   A raw per-sample condition must be seen several times in a row
   before it is allowed to change the CONFIRMED condition — this is
   what stops small normal vibration noise from flickering the
   dashboard between NORMAL/ADVISORY/WARNING. Escalating requires more
   confirmations than settling back down, so real problems are still
   reported promptly but transient noise is not.
========================= */
const CONDITION_RANK = { CALIBRATING: -1, NORMAL: 0, ADVISORY: 1, WARNING: 2, CRITICAL: 3 };
const ESCALATE_CONFIRM_FRAMES = 4;
const DEESCALATE_CONFIRM_FRAMES = 3;

const hysteresisState = {}; // keyed by context: { confirmed, candidate, candidateCount }

function confirmCondition(context, rawCondition) {
  const state = hysteresisState[context] || { confirmed: 'NORMAL', candidate: null, candidateCount: 0 };

  if (rawCondition === state.confirmed) {
    state.candidate = null;
    state.candidateCount = 0;
  } else if (rawCondition === state.candidate) {
    state.candidateCount += 1;
  } else {
    state.candidate = rawCondition;
    state.candidateCount = 1;
  }

  const escalating = (CONDITION_RANK[rawCondition] ?? 0) > (CONDITION_RANK[state.confirmed] ?? 0);
  const required = escalating ? ESCALATE_CONFIRM_FRAMES : DEESCALATE_CONFIRM_FRAMES;

  if (state.candidate === rawCondition && state.candidateCount >= required) {
    state.confirmed = rawCondition;
    state.candidate = null;
    state.candidateCount = 0;
  }

  hysteresisState[context] = state;
  return state.confirmed;
}

const BASELINE_MIN_SAMPLES = 20;
// A live baseline built from a real sensor can end up with a very
// small (near-zero) standard deviation once enough tightly-clustered
// normal samples accumulate. Without a floor, that makes the z-score
// for any future ordinary reading blow up — which then excludes that
// reading from ever updating the baseline again, which narrows the
// baseline further, which raises z even more. This floor breaks that
// runaway feedback loop while still letting genuine drift show up.
const BASELINE_MIN_STD_RATIO = 0.04; // never treat noise below ~4% of the mean as significant
const BASELINE_MIN_STD_ABS = 0.02;

function effectiveStd(rawStd, refMean) {
  const relFloor = Math.abs(refMean) * BASELINE_MIN_STD_RATIO;
  return Math.max(rawStd || 0, relFloor, BASELINE_MIN_STD_ABS);
}

function updateLiveBaseline(vibration) {
  // The live baseline is built ONLY from real physical readings that
  // arrive over time — the CSV dataset is never used as a stand-in,
  // even before enough live samples exist.
  baseline.values.push(vibration);
  if (baseline.values.length > 300) baseline.values.shift();
  baseline.count = baseline.values.length;
  baseline.mean = mean(baseline.values);
  baseline.std = std(baseline.values);
}

function isBaselineAdmissible(rawCondition) {
  // Admit NORMAL and ADVISORY raw readings (ordinary sensor noise) into
  // the baseline; exclude only WARNING/CRITICAL. Gating this on the same
  // tight NORMAL-only threshold used for display would make the baseline
  // narrow every time it updates, which is the runaway-narrowing bug —
  // this wider band keeps the baseline representative of real, if noisy,
  // healthy operation instead of only its quietest moments.
  return rawCondition === 'NORMAL' || rawCondition === 'ADVISORY';
}

function buildReferenceModel(rows) {
  // Lightweight 1D KNN model: vibration -> dataset fault label.
  // This is a development classifier, not a validated industrial rupture predictor.
  return rows.map(r => ({ vibration: r.vibration, fault: r.fault }));
}

let knnModel = [];

function knnPredict(vibration, k = 9) {
  if (!knnModel.length || vibration == null) return { label: null, confidence: 0 };
  const nearest = [...knnModel]
    .sort((a, b) => Math.abs(a.vibration - vibration) - Math.abs(b.vibration - vibration))
    .slice(0, k);
  const votes = {};
  for (const row of nearest) votes[row.fault] = (votes[row.fault] || 0) + 1;
  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { label: null, confidence: 0 };
  return { label: ranked[0][0], confidence: ranked[0][1] / nearest.length };
}

function analyze(vibration, context = 'LIVE') {
  let refMean, refStd, calibrating = false;

  if (context === 'LIVE') {
    // LIVE readings are only ever judged against a baseline built from
    // real physical live samples (see updateLiveBaseline). The CSV
    // dataset is NEVER substituted in, even while that baseline is
    // still being established.
    if (baseline.count < BASELINE_MIN_SAMPLES) {
      calibrating = true;
      refMean = baseline.mean ?? vibration;
      refStd = effectiveStd(baseline.std, refMean);
    } else {
      refMean = baseline.mean;
      refStd = effectiveStd(baseline.std, refMean);
    }
  } else {
    // DATASET / TEST playback is explicitly a replay of the CSV's own
    // historical data — it is judged against the CSV's own statistics,
    // and this reference is isolated from (and never written into) the
    // live baseline above.
    const values = dataset.map(r => r.vibration);
    refMean = mean(values);
    refStd = std(values) || 0.05;
  }

  const z = refStd > 0 ? Math.abs(vibration - refMean) / refStd : 0;
  const rawCondition = calibrating ? 'CALIBRATING' : conditionFromScore(z);
  // Hysteresis/confirmation is per-context so Dataset/Test playback can
  // never influence the LIVE confirmed condition or vice versa.
  const condition = calibrating ? 'CALIBRATING' : confirmCondition(context, rawCondition);

  const ml = knnPredict(vibration);

  const recentWindow = context === 'LIVE'
    ? liveHistory.slice(-ROLLING_FEATURE_WINDOW).map(s => s.vibration).concat([vibration])
    : [vibration];
  const features = rollingFeatures(recentWindow);

  let recommendation = 'Continue monitoring.';
  if (condition === 'CALIBRATING') recommendation = 'Establishing the live vibration baseline from real readings — no assessment yet.';
  if (condition === 'ADVISORY') recommendation = 'Observe the vibration trend and check mounting/tracking if it persists.';
  if (condition === 'WARNING') recommendation = 'Inspect the nearby mechanical area and verify belt tracking/joint condition.';
  if (condition === 'CRITICAL') recommendation = 'Stop or isolate the prototype safely and inspect before continuing.';

  return {
    vibration,
    context,
    baselineMean: Number(refMean.toFixed(4)),
    baselineStd: Number(refStd.toFixed(4)),
    baselineSampleCount: context === 'LIVE' ? baseline.count : dataset.length,
    calibrating,
    anomalyScore: Number(z.toFixed(3)),
    rawCondition,
    condition,
    features,
    mlFaultAssociation: ml.label,
    mlConfidence: Number(ml.confidence.toFixed(3)),
    recommendation,
    note: context === 'LIVE'
      ? (calibrating
          ? `Calibrating live baseline from real sensor readings (${baseline.count}/${BASELINE_MIN_SAMPLES} samples).`
          : 'Anomaly score is deviation from the live-only baseline (never the CSV dataset). Fault association is a reference from the supplied vibration-labelled dataset and is not proof of exact belt-joint rupture.')
      : 'Replaying CSV dataset values against the dataset\'s own statistics for demonstration — this never touches the live baseline.'
  };
}

/* =========================
   VISION PIPELINE
   Camera acquisition + OpenCV processing now happen entirely outside
   this process, in camera_service/ (Python + OpenCV), which captures
   the laptop's built-in webcam and POSTs structured observations to
   POST /api/vision/observation below. This backend never opens a
   camera, never runs getUserMedia, and never runs OpenCV itself — it
   only validates, timestamps, and fuses what the vision service sends.
========================= */

const VALID_BELT_POSITIONS = ['LEFT', 'CENTER', 'RIGHT', 'UNKNOWN'];
const VALID_MOTION_STATES = ['MOVING', 'STOPPED', 'UNKNOWN'];
const VALID_DIRECTIONS = ['FORWARD', 'REVERSE', 'UNKNOWN'];
const VALID_SEVERITIES = ['NONE', 'ADVISORY', 'WARNING', 'HIGH', 'CRITICAL'];

function validateObservation(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  if (typeof body.beltDetected !== 'boolean') return 'beltDetected (boolean) is required';
  if (body.beltPosition != null && !VALID_BELT_POSITIONS.includes(body.beltPosition)) {
    return `beltPosition must be one of ${VALID_BELT_POSITIONS.join(', ')}`;
  }
  if (body.motionState != null && !VALID_MOTION_STATES.includes(body.motionState)) {
    return `motionState must be one of ${VALID_MOTION_STATES.join(', ')}`;
  }
  if (body.direction != null && !VALID_DIRECTIONS.includes(body.direction)) {
    return `direction must be one of ${VALID_DIRECTIONS.join(', ')}`;
  }
  if (body.visualSeverity != null && !VALID_SEVERITIES.includes(body.visualSeverity)) {
    return `visualSeverity must be one of ${VALID_SEVERITIES.join(', ')}`;
  }
  return null;
}

/* =========================
   SENSOR STATUS / FRESHNESS
========================= */

function getSensorStatus() {
  const now = Date.now();

  const lastVibAt = liveHistory.length
    ? new Date(liveHistory[liveHistory.length - 1].time).getTime()
    : null;
  const vibrationAgeMs = lastVibAt != null ? now - lastVibAt : null;
  const vibrationLive = vibrationAgeMs != null && vibrationAgeMs <= FUSION_CONFIG.VIBRATION_FRESH_MS;
  const vibrationAvailable = vibrationAgeMs != null && vibrationAgeMs <= FUSION_CONFIG.VIBRATION_STALE_MS;

  const cameraAgeMs = cameraState.lastFrameAt != null ? now - cameraState.lastFrameAt : null;
  const cameraLive = cameraAgeMs != null && cameraAgeMs <= FUSION_CONFIG.CAMERA_FRESH_MS;
  const cameraAvailable = cameraAgeMs != null && cameraAgeMs <= FUSION_CONFIG.CAMERA_STALE_MS;

  return {
    vibrationAvailable,
    vibrationLive,
    vibrationAgeMs,
    cameraAvailable,
    cameraLive,
    cameraAgeMs,
    cameraStatus: cameraConnectionStatus(), // CONNECTED | STALE | OFFLINE | WAITING | ERROR
    degradedMode: !(vibrationAvailable && cameraAvailable)
  };
}

/* =========================
   FUSION ENGINE
   Combines vibration risk + camera risk into one final condition.
   Internal weighting only — never expose CAMERA_WEIGHT/VIBRATION_WEIGHT
   to the dashboard as a labelled "priority".
========================= */

function vibrationRiskFromAnalysis(vibrationResult) {
  if (!vibrationResult || vibrationResult.anomalyScore == null) return null;
  // anomalyScore is a baseline z-score; map onto a 0-100 risk scale using
  // the same breakpoints as conditionFromScore (1.5 / 2.5 / 3.5).
  const z = vibrationResult.anomalyScore;
  return Math.max(0, Math.min(100, (z / 4) * 100));
}

// Maps the OpenCV service's conservative visual severity + evidence
// quality into a 0-100 risk contribution. Severity alone is never
// enough — low confidence, poor ROI quality, or a belt that isn't even
// detected all pull the contribution down instead of trusting a single
// frame's reading at face value.
const VISUAL_SEVERITY_BASE = {
  NONE: 0,
  ADVISORY: 30,
  WARNING: 60,
  HIGH: 80,
  CRITICAL: 95
};

function cameraRiskFromResult(cam, cameraAvailable) {
  if (!cam || !cameraAvailable) return null;
  if (cam.cameraConnected === false) return null;
  if (!cam.beltDetected) return null; // no belt in view -> no visual evidence to fuse

  const severityBase = VISUAL_SEVERITY_BASE[cam.visualSeverity] ?? 0;
  const confidence = clamp01(cam.visualConfidence ?? 0.5);
  const roiQuality = clamp01(cam.roiQuality ?? 0.5);

  // Tracking deviation contributes an independent, smaller risk signal
  // even when there's no flagged "visual anomaly" (e.g. belt drifting
  // off-center without an obvious surface defect).
  const trackingComponent = clamp01(cam.trackingDeviation ?? 0) * 25;

  const evidenceQuality = (confidence * 0.7) + (roiQuality * 0.3);
  const severityRisk = severityBase * evidenceQuality;

  return Math.max(0, Math.min(100, severityRisk + trackingComponent));
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function conditionFromRisk(risk) {
  if (risk < 30) return 'NORMAL';
  if (risk < 55) return 'ADVISORY';
  if (risk < 75) return 'WARNING';
  return 'CRITICAL';
}

// Maintenance guidance shown for every non-normal FINAL condition.
// Deliberately generic/safe language — never an exact failure date or
// a guaranteed prediction.
const MAINTENANCE_ACTIONS = {
  WAITING: 'Waiting for live vibration and/or camera data before any assessment can be made.',
  CALIBRATING: 'Establishing the live vibration baseline — no maintenance assessment yet.',
  NORMAL: 'No action needed. Continue routine monitoring.',
  ADVISORY: 'No immediate action required — keep monitoring; recheck sooner if the trend continues.',
  WARNING: 'Schedule an inspection of belt tracking and the joint/splice area soon.',
  CRITICAL: 'Stop or isolate the conveyor safely and inspect before resuming operation.'
};

// Builds the plain-language evidence trail behind the final condition —
// required for every non-normal condition, but included always so the
// dashboard can show "why" at a glance.
function buildEvidence(vibrationResult, cam, status) {
  const evidence = [];

  if (status.vibrationAvailable && vibrationResult && !vibrationResult.calibrating) {
    const f = vibrationResult.features;
    evidence.push(
      `Vibration: ${vibrationResult.condition} (deviation ${vibrationResult.anomalyScore.toFixed(2)}σ from live baseline` +
      (f ? `, RMS ${f.rms}, peak ${f.peak}` : '') + ')'
    );
  } else if (status.vibrationAvailable && vibrationResult?.calibrating) {
    evidence.push(`Vibration: calibrating live baseline (${vibrationResult.baselineSampleCount}/${BASELINE_MIN_SAMPLES} samples collected).`);
  } else {
    evidence.push('Vibration: sensor data not available (ESP32/MPU6050 offline or stale).');
  }

  if (status.cameraAvailable && cam) {
    if (!cam.beltDetected) {
      evidence.push('Camera: connected, but belt not detected in frame.');
    } else {
      evidence.push(
        `Camera: joint/visual condition ${cam.jointStatus || 'UNKNOWN'} (severity ${cam.visualSeverity || 'NONE'}), ` +
        `tracking deviation ${cam.trackingDeviation != null ? Math.round(cam.trackingDeviation * 100) + '%' : '--'}.`
      );
    }
  } else {
    evidence.push('Camera: not available (webcam / OpenCV service offline or stale).');
  }

  return evidence;
}

function fuse(vibrationResult, status) {
  const vibrationRisk = (status.vibrationAvailable && !vibrationResult?.calibrating)
    ? vibrationRiskFromAnalysis(vibrationResult) : null;
  const cameraRisk = cameraRiskFromResult(cameraState.latest, status.cameraAvailable);
  const evidence = buildEvidence(vibrationResult, cameraState.latest, status);

  // Confidence reflects freshness, persistence and agreement of both
  // sources — not a fixed number per branch. It starts from the camera's
  // reported evidence quality (or a neutral 0.5) and is pulled down for
  // staleness / single-sensor operation / low signal quality.
  function baseConfidence() {
    const camConf = clamp01(cameraState.latest?.visualConfidence ?? 0.5);
    const camQuality = clamp01(cameraState.latest?.roiQuality ?? 0.5);
    return (camConf * 0.7) + (camQuality * 0.3);
  }

  let rawCondition, finalRisk, degradedMode, note, confidence;

  if (vibrationRisk == null && cameraRisk == null) {
    const waitingCondition = vibrationResult?.calibrating ? 'CALIBRATING' : 'WAITING';
    delete hysteresisState.FUSED; // no evidence — nothing to hold a confirmed state on
    return {
      finalCondition: waitingCondition,
      finalRisk: null,
      confidence: 0,
      degradedMode: true,
      note: vibrationResult?.calibrating
        ? 'Vibration baseline is still calibrating and camera data is unavailable.'
        : 'No live sensor data available yet.',
      evidence,
      recommendation: MAINTENANCE_ACTIONS[waitingCondition]
    };
  }

  if (vibrationRisk != null && cameraRisk != null) {
    finalRisk = vibrationRisk * FUSION_CONFIG.VIBRATION_WEIGHT + cameraRisk * FUSION_CONFIG.CAMERA_WEIGHT;
    rawCondition = conditionFromRisk(finalRisk);
    degradedMode = false;
    confidence = baseConfidence();
    note = 'Fused from vibration and camera-derived evidence.';
  } else if (vibrationRisk != null) {
    finalRisk = vibrationRisk;
    rawCondition = conditionFromRisk(finalRisk);
    degradedMode = true;
    const beltNotVisible = status.cameraAvailable && cameraState.latest && !cameraState.latest.beltDetected;
    confidence = 0.4;
    note = beltNotVisible
      ? 'Camera is connected, but the belt is not visible in frame — using vibration only (reduced confidence).'
      : 'Camera data unavailable — using vibration only (reduced confidence).';
  } else {
    finalRisk = cameraRisk;
    rawCondition = conditionFromRisk(finalRisk);
    degradedMode = true;
    confidence = (cameraState.latest?.visualConfidence ?? 0.3) * 0.6;
    note = 'Vibration data unavailable — using camera only (reduced confidence).';
  }

  // Confirmation window on the FINAL fused condition itself, on top of
  // the vibration- and camera-side persistence already applied upstream
  // — the last line of defense against NORMAL<->WARNING/CRITICAL flicker.
  const finalCondition = confirmCondition('FUSED', rawCondition);

  return {
    finalCondition,
    finalRisk: Number(finalRisk.toFixed(2)),
    confidence: Number(Math.max(0, Math.min(1, confidence)).toFixed(2)),
    degradedMode,
    note,
    evidence,
    recommendation: MAINTENANCE_ACTIONS[finalCondition] || MAINTENANCE_ACTIONS.NORMAL
  };
}

function buildFullAnalysis(vibrationResult, context = 'LIVE') {
  const status = getSensorStatus();
  // Fusion always reflects the real LIVE sensors — Dataset/Test playback
  // results are annotated with their own vibration analysis but never
  // substitute into or move the live fusion/final-condition state.
  const fusion = context === 'LIVE' ? fuse(vibrationResult, status) : null;

  // SMS is decided from the SAME LIVE condition the dashboard's "Overall
  // Condition" orbit displays (the hysteresis-confirmed vibration
  // condition, `vibrationResult.condition`) — so a CRITICAL ring fires
  // the message the instant it appears on screen. This is never a second,
  // separate threshold, and only fires for LIVE (fusion is null for
  // DATASET/TEST, see above), so Dataset/Test playback can never trigger
  // a real SMS (spec requirement 10).
  if (context === 'LIVE' && fusion) {
    handleLiveSmsForCondition(vibrationResult.condition, vibrationResult, fusion);
  }

  return {
    ...vibrationResult,
    camera: cameraState.latest,
    sensorStatus: status,
    fusion,
    sms: context === 'LIVE' ? getSmsSnapshot() : undefined
  };
}

function loadDataset() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(CSV_PATH)) {
      return reject(new Error('conveyor_fault_dataset.csv not found in backend folder.'));
    }
    const rows = [];
    fs.createReadStream(CSV_PATH)
      .pipe(csv())
      .on('data', row => {
        const keys = Object.keys(row);
        const find = (pred) => keys.find(pred);
        const vibrationKey = find(k => k.toLowerCase().includes('vibration'));
        const faultKey = find(k => k.toLowerCase() === 'fault');
        // Dataset Mode (multi-sensor upgrade) needs every column, not just
        // vibration + fault. All other endpoints/pipelines below only ever
        // read .vibration / .fault off these rows, so adding fields here is
        // additive and never changes their existing behaviour.
        const speedKey = find(k => k.toLowerCase().includes('speed'));
        const loadKey = find(k => k.toLowerCase().includes('load'));
        const temperatureKey = find(k => k.toLowerCase().includes('temp'));
        const currentKey = find(k => k.toLowerCase().includes('current'));

        const vibration = vibrationKey ? number(row[vibrationKey]) : null;
        if (vibration != null) {
          rows.push({
            vibration,
            fault: faultKey ? String(row[faultKey]).trim() : 'Unknown',
            speed: speedKey ? number(row[speedKey]) : null,
            load: loadKey ? number(row[loadKey]) : null,
            temperature: temperatureKey ? number(row[temperatureKey]) : null,
            current: currentKey ? number(row[currentKey]) : null,
            originalRow: row
          });
        }
      })
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

/* =========================
   DATASET MODE — MULTI-SENSOR CONDITION MODEL
   Everything Dataset Mode needs to turn a raw CSV row (speed, load,
   temperature, vibration, current — all different units) into one
   explainable condition is kept in this one block, isolated from the
   LIVE vibration-only analyze()/fuse() pipeline above. Nothing here is
   read by Live Mode, Camera Mode, or the vibration-camera fusion logic.
========================= */

// Centralized load-category thresholds (kg). Chosen from the dataset's
// own quartile spread (p25≈494, p50≈506, p75≈519, p90≈532) so the four
// categories are meaningfully populated rather than arbitrary; change
// these three numbers to retune the categories anywhere they're used.
const LOAD_CATEGORY_THRESHOLDS_KG = {
  LOW_MAX: 495,      // Load <= 495kg -> Low
  MEDIUM_MAX: 520,   // 495kg < Load <= 520kg -> Medium
  HIGH_MAX: 545      // 520kg < Load <= 545kg -> High, above -> Critical
};

function classifyLoad(load) {
  if (load == null) return 'UNKNOWN';
  if (load <= LOAD_CATEGORY_THRESHOLDS_KG.LOW_MAX) return 'Low';
  if (load <= LOAD_CATEGORY_THRESHOLDS_KG.MEDIUM_MAX) return 'Medium';
  if (load <= LOAD_CATEGORY_THRESHOLDS_KG.HIGH_MAX) return 'High';
  return 'Critical';
}

// Per-sensor operating bands used to score the CURRENT record's
// condition. Each sensor is evaluated independently (different units
// are never averaged together directly) and reduced to a normalized
// 0 (healthy) -> 1 (critical) score before combining.
const SENSOR_CONDITION_THRESHOLDS = {
  temperature: { unit: '℃', normalMax: 45, criticalMax: 55 },
  current: { unit: 'A', normalMax: 4.2, criticalMax: 5.5 },
  vibration: { unit: 'm/s²', normalMax: 1.0, criticalMax: 1.8 },
  load: { unit: 'kg', normalMax: LOAD_CATEGORY_THRESHOLDS_KG.MEDIUM_MAX, criticalMax: LOAD_CATEGORY_THRESHOLDS_KG.HIGH_MAX },
  // Speed has a healthy operating BAND rather than a ceiling — deviation
  // from the band (in either direction) is what drives its score.
  speed: { unit: 'rpm', normalMin: 110, normalMax: 130, criticalBandWidth: 20 }
};

// Weights used to combine the five normalized sensor scores into one
// overall score. Equal weighting by default — kept centralized so it
// can be retuned without touching the scoring logic itself.
const SENSOR_CONDITION_WEIGHTS = {
  temperature: 0.2,
  current: 0.2,
  vibration: 0.2,
  load: 0.2,
  speed: 0.2
};

// Overall-score -> label breakpoints (score is 0..1 after weighted combination).
const OVERALL_CONDITION_THRESHOLDS = { warningAt: 0.34, criticalAt: 0.67 };

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Generic "distance past normalMax, scaled to criticalMax" scorer used
// for temperature / current / vibration / load: 0 at or below normalMax,
// 1 at or above criticalMax, linear in between.
function scoreCeiling(value, { normalMax, criticalMax }) {
  if (value == null) return { score: null, status: 'UNKNOWN' };
  if (value <= normalMax) return { score: 0, status: 'NORMAL' };
  const score = clamp((value - normalMax) / (criticalMax - normalMax), 0, 1);
  const status = value >= criticalMax ? 'CRITICAL' : 'WARNING';
  return { score: Number(score.toFixed(3)), status };
}

// Speed is scored by distance outside its healthy band, scaled by
// criticalBandWidth (how far outside the band counts as fully CRITICAL).
function scoreSpeed(value, { normalMin, normalMax, criticalBandWidth }) {
  if (value == null) return { score: null, status: 'UNKNOWN' };
  if (value >= normalMin && value <= normalMax) return { score: 0, status: 'NORMAL' };
  const deviation = value < normalMin ? normalMin - value : value - normalMax;
  const score = clamp(deviation / criticalBandWidth, 0, 1);
  const status = score >= 1 ? 'CRITICAL' : 'WARNING';
  return { score: Number(score.toFixed(3)), status };
}

// Evaluates ALL sensor values of a single CSV record against
// SENSOR_CONDITION_THRESHOLDS, normalizes each into a 0..1 score, then
// combines them with SENSOR_CONDITION_WEIGHTS into one overall
// condition. This is the "Current Record Condition" — never the
// dataset-wide average standing in for a live reading.
function computeRecordCondition(record) {
  const sensors = {
    temperature: scoreCeiling(record.temperature, SENSOR_CONDITION_THRESHOLDS.temperature),
    current: scoreCeiling(record.current, SENSOR_CONDITION_THRESHOLDS.current),
    vibration: scoreCeiling(record.vibration, SENSOR_CONDITION_THRESHOLDS.vibration),
    load: scoreCeiling(record.load, SENSOR_CONDITION_THRESHOLDS.load),
    speed: scoreSpeed(record.speed, SENSOR_CONDITION_THRESHOLDS.speed)
  };

  let weightedSum = 0;
  let weightTotal = 0;
  for (const key of Object.keys(sensors)) {
    const s = sensors[key];
    if (s.score == null) continue;
    weightedSum += s.score * SENSOR_CONDITION_WEIGHTS[key];
    weightTotal += SENSOR_CONDITION_WEIGHTS[key];
  }
  const overallScore = weightTotal > 0 ? weightedSum / weightTotal : null;

  let overallCondition = 'UNKNOWN';
  if (overallScore != null) {
    overallCondition = overallScore >= OVERALL_CONDITION_THRESHOLDS.criticalAt
      ? 'CRITICAL'
      : overallScore >= OVERALL_CONDITION_THRESHOLDS.warningAt
        ? 'WARNING'
        : 'NORMAL';
  }

  return {
    sensors,
    overallScore: overallScore != null ? Number(overallScore.toFixed(3)) : null,
    overallCondition,
    loadCategory: classifyLoad(record.load)
  };
}

// Static description of the method above, shown verbatim in the
// Dataset Mode UI ("Condition Calculation Method") so the formula is
// never hidden inside code only.
function getConditionFormulaDescription() {
  return {
    summary: 'Each sensor value is scored 0 (healthy) to 1 (critical) against its own operating thresholds, then combined into one weighted overall score.',
    steps: [
      'Temperature, Current, Vibration, Load: score = 0 if value <= normalMax; score = 1 if value >= criticalMax; linear in between.',
      'Speed: score = 0 if value is within [normalMin, normalMax]; otherwise score = distance outside the band / criticalBandWidth, capped at 1.',
      'Overall score = weighted average of the 5 sensor scores (weights below).',
      `Overall condition = NORMAL if score < ${OVERALL_CONDITION_THRESHOLDS.warningAt}, WARNING if < ${OVERALL_CONDITION_THRESHOLDS.criticalAt}, else CRITICAL.`
    ],
    thresholds: SENSOR_CONDITION_THRESHOLDS,
    weights: SENSOR_CONDITION_WEIGHTS,
    overallThresholds: OVERALL_CONDITION_THRESHOLDS,
    loadCategoryThresholds: LOAD_CATEGORY_THRESHOLDS_KG
  };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'SIH26008 backend', time: new Date().toISOString() });
});

app.get('/api/info', (req, res) => {
  const values = dataset.map(r => r.vibration);
  res.json({
    records: dataset.length,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    average: values.length ? Number(mean(values).toFixed(4)) : null,
    std: values.length ? Number(std(values).toFixed(4)) : null,
    faults: [...new Set(dataset.map(r => r.fault))]
  });
});

app.get('/api/vibration', (req, res) => {
  res.json(dataset.map((r, index) => ({ index, vibration: r.vibration, fault: r.fault })));
});

app.get('/api/vibration/:index', (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || !dataset[index]) return res.status(404).json({ error: 'Record not found' });
  res.json({ index, ...dataset[index] });
});

/* =========================
   DATASET MODE ENDPOINTS (multi-sensor)
   Additive, dedicated routes for the upgraded Dataset Mode — the
   existing /api/vibration* routes above are untouched so any other
   consumer of them keeps working exactly as before.
========================= */

// Full multi-sensor record list, each with its own computed condition.
// Used so the frontend can move through playback without re-fetching.
app.get('/api/dataset/full', (req, res) => {
  res.json(dataset.map((r, index) => ({
    index,
    fault: r.fault,
    speed: r.speed,
    load: r.load,
    temperature: r.temperature,
    vibration: r.vibration,
    current: r.current,
    condition: computeRecordCondition(r)
  })));
});

// Single record, all sensor fields + condition together (never
// independent indexes per sensor).
app.get('/api/dataset/record/:index', (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || !dataset[index]) return res.status(404).json({ error: 'Record not found' });
  const r = dataset[index];
  res.json({
    index,
    fault: r.fault,
    speed: r.speed,
    load: r.load,
    temperature: r.temperature,
    vibration: r.vibration,
    current: r.current,
    condition: computeRecordCondition(r)
  });
});

// Dataset-wide statistics: averages, load distribution, fault
// distribution, and the formula used for per-record condition. This is
// explicitly the "Dataset Statistics" view — never substituted for a
// single current-record condition.
app.get('/api/dataset/stats', (req, res) => {
  const speeds = dataset.map(r => r.speed).filter(v => v != null);
  const loads = dataset.map(r => r.load).filter(v => v != null);
  const temps = dataset.map(r => r.temperature).filter(v => v != null);
  const currents = dataset.map(r => r.current).filter(v => v != null);
  const vibrations = dataset.map(r => r.vibration).filter(v => v != null);

  const statOf = (values, decimals) => {
    if (!values.length) return { min: null, max: null, avg: null, range: null };
    const min = Math.min(...values);
    const max = Math.max(...values);
    return {
      min: Number(min.toFixed(decimals)),
      max: Number(max.toFixed(decimals)),
      avg: Number(mean(values).toFixed(decimals)),
      range: Number((max - min).toFixed(decimals))
    };
  };

  const loadDistribution = ['Low', 'Medium', 'High', 'Critical'].map(category => {
    const count = dataset.filter(r => classifyLoad(r.load) === category).length;
    return {
      category,
      count,
      percentage: dataset.length ? Number(((count / dataset.length) * 100).toFixed(1)) : 0
    };
  });

  const faultDistribution = [...new Set(dataset.map(r => r.fault))].map(fault => {
    const count = dataset.filter(r => r.fault === fault).length;
    return {
      fault,
      count,
      percentage: dataset.length ? Number(((count / dataset.length) * 100).toFixed(1)) : 0
    };
  });

  // Condition breakdown of the whole dataset (using the same per-record
  // condition model already used by the Dataset Mode UI).
  const conditionCounts = { NORMAL: 0, WARNING: 0, CRITICAL: 0, UNKNOWN: 0 };
  dataset.forEach(r => {
    const cond = computeRecordCondition(r).overallCondition;
    conditionCounts[cond] = (conditionCounts[cond] || 0) + 1;
  });
  const conditionDistribution = Object.entries(conditionCounts).map(([condition, count]) => ({
    condition,
    count,
    percentage: dataset.length ? Number(((count / dataset.length) * 100).toFixed(1)) : 0
  }));

  res.json({
    recordCount: dataset.length,
    sensorCount: 5,
    averages: {
      speed: speeds.length ? Number(mean(speeds).toFixed(2)) : null,
      load: loads.length ? Number(mean(loads).toFixed(2)) : null,
      temperature: temps.length ? Number(mean(temps).toFixed(2)) : null,
      current: currents.length ? Number(mean(currents).toFixed(2)) : null,
      vibration: vibrations.length ? Number(mean(vibrations).toFixed(3)) : null
    },
    sensorStats: {
      speed: { ...statOf(speeds, 1), unit: 'rpm' },
      load: { ...statOf(loads, 0), unit: 'kg' },
      temperature: { ...statOf(temps, 1), unit: '℃' },
      current: { ...statOf(currents, 2), unit: 'A' },
      vibration: { ...statOf(vibrations, 3), unit: 'm/s²' }
    },
    loadDistribution,
    loadCategoryThresholds: LOAD_CATEGORY_THRESHOLDS_KG,
    faultDistribution,
    faultNames: [...new Set(dataset.map(r => r.fault))],
    conditionDistribution,
    conditionFormula: getConditionFormulaDescription()
  });
});

app.post('/api/analyze', (req, res) => {
  const vibration = number(req.body.vibration);
  if (vibration == null) return res.status(400).json({ error: 'vibration must be a number' });
  // context isolates Dataset Mode / Test Mode playback from real live
  // alerts (see maybeRecordAlert). Defaults to LIVE for backward compat
  // with any caller that doesn't pass one, but the frontend's Dataset
  // and Test flows always pass 'DATASET' / 'TEST' explicitly.
  const context = ['LIVE', 'DATASET', 'TEST'].includes(req.body.context) ? req.body.context : 'LIVE';
  const result = buildFullAnalysis(analyze(vibration, context), context);
  // Only genuinely NORMAL live readings (or samples during initial
  // calibration, when there is no baseline yet to judge against) are
  // allowed to shape the "healthy" baseline. This checks the RAW
  // (unconfirmed) condition, not the hysteresis-confirmed one — the
  // confirmed condition deliberately lags behind real anomalies for a
  // few frames, and admitting samples based on that lag would let an
  // anomaly spike drift the baseline during exactly that window.
  if (context === 'LIVE' && (result.calibrating || isBaselineAdmissible(result.rawCondition))) {
    updateLiveBaseline(vibration);
  }
  maybeRecordAlert({ id: Date.now(), time: new Date().toISOString(), source: req.body.source || 'live', context, ...result });
  res.json(result);
});

app.post('/api/baseline/reset', (req, res) => {
  baseline = { mean: null, std: null, count: 0, values: [] };
  delete hysteresisState.LIVE;
  res.json({ ok: true, message: 'Baseline reset. The next live samples can establish a new baseline.' });
});

app.post('/api/baseline/add', (req, res) => {
  const vibration = number(req.body.vibration);
  if (vibration == null) return res.status(400).json({ error: 'vibration must be a number' });
  baseline.values.push(vibration);
  if (baseline.values.length > 300) baseline.values.shift();
  baseline.count = baseline.values.length;
  baseline.mean = mean(baseline.values);
  baseline.std = std(baseline.values);
  res.json({ ok: true, baseline: { ...baseline, values: undefined } });
});

app.get('/api/baseline', (req, res) => {
  res.json({ count: baseline.count, mean: baseline.mean, std: baseline.std });
});

app.post('/api/live', (req, res) => {
  const vibration = number(req.body.vibration);
  if (vibration == null) return res.status(400).json({ error: 'vibration must be a number' });
  const result = buildFullAnalysis(analyze(vibration, 'LIVE'), 'LIVE');
  // See the matching guard in /api/analyze — gate on the RAW condition,
  // not the hysteresis-confirmed one, so an anomaly can never drift the
  // baseline during its own confirmation window.
  if (result.calibrating || isBaselineAdmissible(result.rawCondition)) {
    updateLiveBaseline(vibration);
  }

  // Track ESP32 connection
  esp32State.lastVibrationAt = Date.now();
  esp32State.vibrationValue = vibration;
  esp32State.connected = true;

  // Update actuator command based on current fused condition (backend = source of truth)
  const condition = result.fusion ? result.fusion.finalCondition : result.condition;
  updateEsp32Command(condition);
  if (String(condition).toUpperCase() === 'CRITICAL') {
    console.log('[ESP32] CRITICAL command sent');
  }

  const sample = {
    time: new Date().toISOString(),
    vibration,
    source: 'ESP32 + MPU6050',
    analysis: result // stored so GET /api/live/history can show condition without re-analyzing
  };
  liveHistory.push(sample);
  if (liveHistory.length > 500) liveHistory.shift();
  const payload = { ...sample, analysis: result, command: esp32Command };
  maybeRecordAlert({ id: Date.now(), ...sample, context: 'LIVE', ...result });
  res.json(payload);
});

// Supports ?since=<ISO timestamp> so the dashboard can fetch only new
// samples instead of re-downloading and re-rendering the whole rolling
// buffer on every poll (see frontend graph polling).
app.get('/api/live/history', (req, res) => {
  const since = req.query.since ? new Date(req.query.since).getTime() : null;
  if (since && Number.isFinite(since)) {
    return res.json(liveHistory.filter(s => new Date(s.time).getTime() > since));
  }
  res.json(liveHistory);
});
app.get('/api/alerts', (req, res) => res.json(alerts));
app.delete('/api/alerts', (req, res) => { alerts = []; res.json({ ok: true }); });
// Isolated Dataset Mode / Test Mode event logs — never mixed into the
// live alert history (see requirement: dataset/test must not
// contaminate live alerts/history/baseline/camera/fusion state).
app.get('/api/dataset/events', (req, res) => res.json(datasetEvents));
app.get('/api/test/events', (req, res) => res.json(testEvents));

/* =========================
   SMS TEST ENDPOINT (development/demo only)
   Sends one clearly-labeled test message to verify Twilio
   configuration. Never called automatically by frontend polling —
   only from an explicit user action (e.g. a "Send Test SMS" button) —
   and requires an explicit confirm flag as a guard against accidental
   triggers (curl, browser prefetch, etc).
========================= */
app.post('/api/alerts/test-sms', async (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ status: 'FAILED', error: 'Pass { "confirm": true } in the request body to send a test SMS.' });
  }
  const result = await twilioAlertService.sendTestAlert();
  res.json(result);
});

/* =========================
   VOICE CALL TEST ENDPOINT (development/demo only)
   Places one automated call to the configured supervisor using the same
   CRITICAL voice-call path. Disabled when NODE_ENV=production to keep it
   from being used accidentally in a live deployment, and (like test-sms)
   requires an explicit confirm flag. Calls only ALERT_RECIPIENT_PHONE.
   Returns only status/sid — never any credentials.
======================== */
app.post('/api/test/critical-call', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ status: 'FAILED', error: 'Test endpoint is disabled in production.' });
  }
  if (req.body?.confirm !== true) {
    return res.status(400).json({ status: 'FAILED', error: 'Pass { "confirm": true } in the request body to place the test voice call.' });
  }
  const result = await twilioAlertService.sendCriticalVoiceCall();
  res.json(result);
});

/* =========================
   VOICE TWIML ENDPOINT
   Twilio calls this public URL when placing the CRITICAL voice call to
   fetch the spoken instructions (trial accounts require `url`, not the
   inline `twiml` parameter). Returns plain TwiML XML only — no
   credentials ever. Point VOICE_TWIML_URL at the public, internet-
   reachable version of this path (deployed host or a tunnel).
======================== */
app.get('/api/twilio/voice-twiml', (req, res) => {
  res.type('text/xml');
  res.send(twilioAlertService.buildCriticalVoiceTwiML());
});

/* =========================
   UNIFIED STATE ENDPOINT
   Single synchronized snapshot for the Dashboard to poll instead of
   stitching together several endpoints on the frontend. Backend remains
   the source of truth for condition/risk — this just packages the same
   analysis/camera/fusion data the other endpoints already expose.
========================= */
app.get('/api/state', (req, res) => {
  const status = getSensorStatus();
  const lastSample = liveHistory.length ? liveHistory[liveHistory.length - 1] : null;
  const vibrationResult = lastSample ? analyze(lastSample.vibration, 'LIVE') : null;

  res.json({
    timestamp: new Date().toISOString(),
    vibration: lastSample ? lastSample.vibration : null,
    vibrationTime: lastSample ? lastSample.time : null,
    analysis: vibrationResult,
    camera: cameraState.latest,
    sensorStatus: status,
    fusion: vibrationResult ? fuse(vibrationResult, status) : fuse(null, status),
    sms: getSmsSnapshot(),
    belt: {
      // Belt position/direction is currently only observable via the
      // camera heuristic; surfaced here so the frontend has one place
      // to read it from once a real estimator is wired in.
      position: cameraState.latest?.beltPosition ?? null,
      direction: cameraState.latest?.direction ?? null
    },
    recentAlerts: alerts.slice(0, 10),
    esp32: {
      connectionStatus: getEsp32ConnectionStatus(),
      lastVibrationAt: esp32State.lastVibrationAt,
      vibrationValue: esp32State.vibrationValue,
      command: esp32Command
    }
  });
});

/* =========================
   CAMERA / VISION ENDPOINTS
========================= */

// Accepts one structured observation per processed frame from the
// Python + OpenCV camera_service. Expected shape (see camera_service/
// camera_service.py and README for the full schema):
//   {
//     cameraConnected, frameFresh, timestamp, frameTimestamp,
//     beltDetected, beltPosition, centerOffset, trackingDeviation,
//     motionState, direction, motionMagnitude, motionStability,
//     directionConfidence, jointStatus, visualAnomaly, visualSeverity,
//     visualConfidence, roiQuality, modelStatus
//   }
// This backend never runs OpenCV or opens a camera directly — it
// only validates, timestamps, and stores the latest observation for
// fusion + the dashboard.
app.post('/api/vision/observation', (req, res) => {
  const err = validateObservation(req.body);
  if (err) return res.status(400).json({ error: err });

  const body = req.body;
  const receivedAt = new Date().toISOString();

  const observation = {
    cameraConnected: body.cameraConnected !== false,
    frameFresh: body.frameFresh !== false,
    timestamp: receivedAt,
    frameTimestamp: body.frameTimestamp || body.timestamp || receivedAt,
    processingTimestamp: receivedAt,
    beltDetected: !!body.beltDetected,
    beltPosition: body.beltPosition || 'UNKNOWN',
    centerOffset: Number.isFinite(body.centerOffset) ? body.centerOffset : null,
    trackingDeviation: Number.isFinite(body.trackingDeviation) ? body.trackingDeviation : null,
    motionState: body.motionState || 'UNKNOWN',
    direction: body.direction || 'UNKNOWN',
    motionMagnitude: Number.isFinite(body.motionMagnitude) ? body.motionMagnitude : null,
    motionStability: Number.isFinite(body.motionStability) ? body.motionStability : null,
    directionConfidence: Number.isFinite(body.directionConfidence) ? body.directionConfidence : null,
    jointStatus: body.jointStatus || 'UNKNOWN',
    visualAnomaly: !!body.visualAnomaly,
    visualSeverity: body.visualSeverity || 'NONE',
    visualConfidence: Number.isFinite(body.visualConfidence) ? body.visualConfidence : 0,
    roiQuality: Number.isFinite(body.roiQuality) ? body.roiQuality : 0,
    modelStatus: body.modelStatus || 'OPENCV_HEURISTIC',
    // Annotated still snapshot from the OpenCV pipeline (data: URI, JPEG).
    // Optional — older camera_service builds or SNAPSHOT_ENABLED=false
    // simply omit it, and the dashboard falls back to text-only evidence.
    snapshot: typeof body.snapshot === 'string' ? body.snapshot : null,
    error: body.error || null
  };

  cameraState.latest = observation;
  cameraState.lastFrameAt = Date.now();

  res.json({ ok: true, stored: observation });
});

app.get('/api/vision/latest', (req, res) => {
  if (!cameraState.latest) {
    return res.json({ available: false, cameraStatus: 'WAITING' });
  }
  const ageMs = Date.now() - cameraState.lastFrameAt;
  res.json({
    available: ageMs <= FUSION_CONFIG.CAMERA_STALE_MS,
    live: ageMs <= FUSION_CONFIG.CAMERA_FRESH_MS,
    cameraStatus: cameraConnectionStatus(),
    ageMs,
    ...cameraState.latest
  });
});

app.get('/api/sensor/status', (req, res) => {
  res.json(getSensorStatus());
});

/* =========================
   ESP32 TWO-WAY COMMUNICATION ENDPOINTS
   The ESP32 polls these to get the latest actuator commands
   and to send heartbeats.
======================== */

// ESP32 polls this to get the latest actuator command from the backend.
// Backend determines the official state; ESP32 applies it.
app.get('/api/esp32/command', (req, res) => {
  res.json({
    ...esp32Command,
    command:esp32Command.status,
    esp32Status: getEsp32ConnectionStatus()
  });
});

// ESP32 sends periodic heartbeats so the backend knows it's alive.
app.post('/api/esp32/heartbeat', (req, res) => {
  esp32State.lastHeartbeatAt = Date.now();
  esp32State.connected = true;
  res.json({ ok: true, command: esp32Command });
});

// Full ESP32 system status — shows connection, vibration, and actuator state.
app.get('/api/esp32/status', (req, res) => {
  res.json({
    connectionStatus: getEsp32ConnectionStatus(),
    lastHeartbeatAt: esp32State.lastHeartbeatAt,
    lastVibrationAt: esp32State.lastVibrationAt,
    vibrationValue: esp32State.vibrationValue,
    command: esp32Command,
    heartbeatTimeoutMs: ESP32_HEARTBEAT_TIMEOUT_MS
  });
});

/* =========================
   PRODUCTION STATIC FILE SERVING
   In production (Render), the built frontend is served from backend/.
======================== */
const frontendBuild = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendBuild)) {
  app.use(express.static(frontendBuild));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(frontendBuild, 'index.html'));
    }
  });
}

loadDataset()
  .then(rows => {
    dataset = rows;
    knnModel = buildReferenceModel(rows);
    console.log(`Dataset loaded successfully: ${dataset.length} vibration records`);
    console.log(`Vibration range: ${Math.min(...dataset.map(r => r.vibration))} - ${Math.max(...dataset.map(r => r.vibration))}`);
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Backend running at http://localhost:${PORT}`);
      console.log(`Reachable on the LAN (for the ESP32) at http://<this-machine-ip>:${PORT}`);
    });
  })
  .catch(err => {
    console.error(err.message);
    process.exit(1);
  });
