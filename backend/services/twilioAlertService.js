/* =========================
   TWILIO SMS ALERT SERVICE
   Optional backend service — the rest of BeltGuard AI must run
   normally whether or not this is configured. Never import Twilio
   credentials into anything that reaches the frontend; this module is
   backend-only (process.env) and never returns credentials to a caller.
========================= */

let Twilio = null;
try {
  // Optional dependency: if `twilio` hasn't been installed yet (e.g.
  // npm install hasn't been re-run since this feature was added), fail
  // soft instead of crashing the whole backend at require-time.
  Twilio = require('twilio');
} catch (err) {
  Twilio = null;
}

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ALERT_RECIPIENT_PHONE
} = process.env;

const hasAllEnvVars = !!(
  TWILIO_ACCOUNT_SID &&
  TWILIO_AUTH_TOKEN &&
  TWILIO_PHONE_NUMBER &&
  ALERT_RECIPIENT_PHONE
);

let client = null;
if (Twilio && hasAllEnvVars) {
  try {
    client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  } catch (err) {
    console.warn('[twilioAlertService] Failed to initialize Twilio client — SMS alerts not configured:', err.message);
    client = null;
  }
}

if (!client) {
  const reason = !Twilio
    ? 'the "twilio" package is not installed'
    : !hasAllEnvVars
      ? 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER / ALERT_RECIPIENT_PHONE are not all set'
      : 'client initialization failed';
  console.warn(`[twilioAlertService] SMS alerts not configured (${reason}). BeltGuard AI will run normally without SMS.`);
}

function isConfigured() {
  return !!client;
}

/* =========================
   MESSAGE BUILDER
   Uses ONLY the actual live analysis fields passed in — every line is
   optional and simply omitted when that value isn't available. Never
   invents sensor values, fault names, scores, or confidence.
========================= */
function buildCriticalMessage(alertData = {}) {
  const lines = ['🚨 BELTGUARD AI CRITICAL ALERT', '', 'Conveyor: CV-01'];

  if (alertData.predictedFault) {
    const conf = alertData.confidencePct != null ? ` (~${alertData.confidencePct}% confidence)` : '';
    lines.push(`Fault association: ${alertData.predictedFault}${conf}`);
  }

  if (alertData.healthScore != null) {
    lines.push(`Health Score: ${alertData.healthScore}/100`);
  }

  if (alertData.aiConfidencePct != null) {
    lines.push(`AI Confidence: ${alertData.aiConfidencePct}%`);
  }

  const sensorParts = [];
  if (alertData.vibration != null) sensorParts.push(`Vibration ${alertData.vibration} m/s²`);
  if (alertData.temperature != null) sensorParts.push(`Temp ${alertData.temperature}°C`);
  if (alertData.load != null) sensorParts.push(`Load ${alertData.load}kg`);
  if (alertData.speed != null) sensorParts.push(`Speed ${alertData.speed}rpm`);
  if (alertData.current != null) sensorParts.push(`Current ${alertData.current}A`);
  if (sensorParts.length) {
    lines.push('');
    lines.push(sensorParts.join(', '));
  }

  lines.push('');
  lines.push(`Visual inspection: ${alertData.visualInspection || 'unavailable'}`);

  lines.push('');
  lines.push(alertData.recommendation || 'Inspect conveyor belt system immediately.');

  return lines.join('\n');
}

async function sendSms(body) {
  if (!client) {
    return { success: false, error: 'SMS alerts not configured' };
  }
  try {
    const message = await client.messages.create({
      body,
      from: TWILIO_PHONE_NUMBER,
      to: ALERT_RECIPIENT_PHONE
    });
    return { success: true, sid: message.sid };
  } catch (err) {
    console.error('[twilioAlertService] Failed to send SMS:', err.message);
    return { success: false, error: err.message };
  }
}

// Trial Twilio accounts reject any custom `body` text — the API only
// accepts one of these fixed keywords, and Twilio renders its own
// pre-written English text for whichever one is sent. This is a Twilio
// account-tier restriction, not something an app can work around;
// custom bodies (our real sensor data) only work after upgrading.
const TRIAL_TEMPLATE_FALLBACK = 'sms_internal_alerts';

function isTrialTemplateError(err) {
  return !!err && typeof err.message === 'string' && /template/i.test(err.message);
}

async function sendSmsWithTrialFallback(body) {
  const primary = await sendSms(body);
  if (primary.success) return { ...primary, usedTrialTemplate: false };

  // If it failed specifically because this is a trial account that
  // requires a predefined template, retry once with the closest
  // matching Twilio template keyword so the demo still sends a real
  // SMS — just with Twilio's own fixed wording instead of our real
  // sensor data (which is still logged server-side, see callers below).
  if (/template/i.test(primary.error || '')) {
    console.warn('[twilioAlertService] Trial account rejected custom SMS body — retrying with Twilio\'s predefined template.');
    const fallback = await sendSms(TRIAL_TEMPLATE_FALLBACK);
    return { ...fallback, usedTrialTemplate: fallback.success };
  }

  return { ...primary, usedTrialTemplate: false };
}

// sendCriticalAlert never throws — callers can safely fire-and-forget it
// without risking an unhandled rejection taking down the server.
async function sendCriticalAlert(alertData) {
  if (!client) {
    return { status: 'NOT_CONFIGURED', error: 'SMS alerts not configured' };
  }
  try {
    const body = buildCriticalMessage(alertData);
    // Server-side record of the real, data-driven alert text even when
    // the trial-account fallback below has to send Twilio's fixed
    // template wording instead (spec requirement 15: never lose the
    // actual AI/sensor values, even if Twilio can't deliver them yet).
    console.log('[twilioAlertService] CRITICAL alert (intended content):\n' + body);
    const result = await sendSmsWithTrialFallback(body);
    if (result.success) {
      return {
        status: 'SENT',
        sentAt: new Date().toISOString(),
        sid: result.sid,
        note: result.usedTrialTemplate
          ? 'Sent using Twilio\'s trial-account predefined template — upgrade Twilio to send the real alert content.'
          : null
      };
    }
    return { status: 'FAILED', error: result.error, sentAt: new Date().toISOString() };
  } catch (err) {
    return { status: 'FAILED', error: err.message, sentAt: new Date().toISOString() };
  }
}

async function sendTestAlert() {
  if (!client) {
    return { status: 'NOT_CONFIGURED', error: 'SMS alerts not configured' };
  }
  try {
    const result = await sendSmsWithTrialFallback('BeltGuard AI test alert — no fault detected.');
    if (result.success) {
      return {
        status: 'SENT',
        sentAt: new Date().toISOString(),
        sid: result.sid,
        note: result.usedTrialTemplate
          ? 'Sent using Twilio\'s trial-account predefined template — upgrade Twilio to send the real alert content.'
          : null
      };
    }
    return { status: 'FAILED', error: result.error, sentAt: new Date().toISOString() };
  } catch (err) {
    return { status: 'FAILED', error: err.message, sentAt: new Date().toISOString() };
  }
}

/* =========================
   CRITICAL VOICE CALL (Twilio Voice / TwiML)
   Emergency escalation companion to the SMS above. When BeltGuard AI
   transitions INTO a CRITICAL state, the supervisor phone is called and
   the message below is spoken back to them.

   Uses the exact same Twilio client and credentials as SMS (TWILIO_ACCOUNT_SID /
   TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER) and calls only the configured
   ALERT_RECIPIENT_PHONE. No credentials are ever returned to callers or
   reachable from the frontend.

   Trial-account note: Twilio trial accounts reject the inline `twiml`
   parameter for outbound calls. They only accept `url` (a public URL
   Twilio can fetch the call instructions from). So this service uses the
   `url` parameter instead, pointing at VOICE_TWIML_URL — by default the
   backend's own /api/twilio/voice-twiml endpoint (see server.js), or any
   TwiML Bin URL you configure. The message itself is still produced by
   buildCriticalVoiceTwiML below.

   Like sendCriticalAlert, this function never throws — callers can
   fire-and-forget it and the backend keeps running even if Twilio
   rejects the call.
======================== */

const VOICE_TWIML_URL = process.env.VOICE_TWIML_URL;

// Returns valid TwiML that speaks the emergency message to the recipient.
// Kept as its own function so the recipients / message can later be
// extended (e.g. multiple supervisors) without touching the call logic.
function buildCriticalVoiceTwiML() {
  const message =
    'Critical alert from BeltGuard AI. A critical conveyor belt condition has been detected. Immediate inspection is required.';
  // Escape anything that could break the TwiML XML (single quotes are safe
  // here, but stay defensive for future customisation).
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `
    <Response>
      <Say voice="alice" language="en-US">${safe}</Say>
    </Response>
  `.trim();
}

async function sendCriticalVoiceCall() {
  if (!client) {
    return { status: 'NOT_CONFIGURED', error: 'Voice alerts not configured' };
  }
  if (!ALERT_RECIPIENT_PHONE) {
    return { status: 'FAILED', error: 'ALERT_RECIPIENT_PHONE is not set' };
  }
  if (!VOICE_TWIML_URL) {
    return { status: 'FAILED', error: 'VOICE_TWIML_URL is not set — set it to the public URL of the voice TwiML endpoint (e.g. https://<your-backend>/api/twilio/voice-twiml or a TwiML Bin URL).' };
  }
  try {
    const call = await client.calls.create({
      url: VOICE_TWIML_URL,
      from: TWILIO_PHONE_NUMBER,
      to: ALERT_RECIPIENT_PHONE
    });
    return { status: 'INITIATED', sid: call.sid, createdAt: new Date().toISOString() };
  } catch (err) {
    console.error('[VOICE] Call failed:', err.message);
    return { status: 'FAILED', error: err.message, createdAt: new Date().toISOString() };
  }
}

module.exports = {
  isConfigured,
  buildCriticalMessage,
  buildCriticalVoiceTwiML,
  sendCriticalAlert,
  sendCriticalVoiceCall,
  sendTestAlert
};
