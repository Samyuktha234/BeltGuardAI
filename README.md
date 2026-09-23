# SIH26008 — BeltGuard AI Dashboard

A React + Node.js + Python(OpenCV) proof-of-concept for the conveyor monitoring project.

## Quick start (Windows)

Four processes, four terminals — `cmd.exe` or PowerShell both work with these commands.

```bat
:: Terminal 1 — backend
cd SIH26008-dashboard\backend
npm install
npm start

:: Terminal 2 — camera service (Python + OpenCV)
cd SIH26008-dashboard\camera_service
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
:: defaults already work: CAMERA_SOURCE=webcam, CAMERA_INDEX=0
:: (opens the laptop's own built-in webcam — no phone needed)
python camera_service.py

:: Terminal 3 — frontend
cd SIH26008-dashboard\frontend
npm install
npm run dev
```

Then open the Vite URL printed by Terminal 3 (normally `http://localhost:5173`).
The ESP32 should POST vibration readings to `http://<this-laptop-IP>:5000/api/live`
on the same Wi-Fi network.

## Quick start (macOS/Linux)

```bash
cd backend && npm install && npm start &
cd ../camera_service && pip install -r requirements.txt && cp .env.example .env && python camera_service.py &
cd ../frontend && npm install && npm run dev
```

## Architecture

```
LAPTOP WEBCAM (cv2.VideoCapture)
        │ local video frames
        ▼
LAPTOP: camera_service/ (Python + OpenCV)
        │  belt detection, position, tracking, motion, direction,
        │  joint/visual inspection
        ▼
POST /api/vision/observation
        ▼
LAPTOP: backend/ (Node/Express)  ◄── POST /api/live ── ESP32 + MPU6050
        │  fusion (camera = primary internally, vibration = secondary)
        ▼
GET /api/state
        ▼
frontend/ (React dashboard)
```

**The laptop's own built-in webcam is the default camera source.** A
dedicated Python service (`camera_service/`) is the only thing that
opens the camera and runs OpenCV — no Android phone or IP Webcam app
is required. See `camera_service/README.md` for webcam setup, optional
IP-camera fallback, and ROI tuning.

## Folder structure

```text
SIH26008-dashboard/
├── README.md
├── camera_service/                  <-- Python + OpenCV (laptop webcam -> backend)
│   ├── camera_service.py
│   ├── requirements.txt
│   ├── .env.example
│   └── README.md
├── backend/
│   ├── package.json
│   ├── server.js
│   └── conveyor_fault_dataset.csv   <-- PUT YOUR REAL CSV HERE
└── frontend/
    ├── package.json
    ├── index.html
    └── src/
        ├── App.jsx
        ├── App.css
        └── main.jsx
```

## 1. Add your dataset
Copy your actual `conveyor_fault_dataset.csv` into `backend/`.

The backend automatically finds the column whose name contains `vibration` and reads the `Fault` column when present.

## 2. Start the backend

```bash
cd backend
npm install
cp .env.example .env     # optional: fill in Twilio vars for SMS alerts
npm start
```

> **Already had this project set up before?** New dependencies
> (`dotenv`, `twilio`) were added for the SMS feature — re-run
> `npm install` in `backend/` after pulling these changes, or the
> server will crash on startup with `Cannot find module 'dotenv'` and
> *every* endpoint (including Dataset Mode) will return nothing.

Expected:

```text
Dataset loaded successfully: 1209 vibration records
Backend running at http://localhost:5000
```

### SMS alerts (Twilio, optional)

The backend can send a real SMS the moment Live Mode's fused condition
transitions into `CRITICAL` (see `backend/services/twilioAlertService.js`).
It's entirely optional — with no env vars set, the backend just logs
`SMS alerts not configured` and everything else runs normally.

To enable it, fill in `backend/.env` (copied from `.env.example`):

```text
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...        # your Twilio number
ALERT_RECIPIENT_PHONE=+91...     # phone that receives alerts
SMS_ALERT_COOLDOWN_MS=300000     # optional, defaults to 5 min
```

Notes:
- One SMS is sent per transition **into** CRITICAL — not once per poll — and it re-arms automatically once the condition leaves CRITICAL.
- Never triggered by Dataset Mode or Test Mode playback — only real Live Mode readings.
- Trial Twilio accounts only allow a fixed set of pre-approved message templates; if your account is on trial, the service automatically falls back to Twilio's default template wording (the real sensor data is still logged server-side either way).
- To verify your Twilio setup without waiting for a real CRITICAL event, click **Send Test SMS** on the System tab, or call the endpoint directly:
  ```bash
  curl -X POST http://localhost:5000/api/alerts/test-sms \
    -H "Content-Type: application/json" \
    -d '{"confirm": true}'
  ```

## 3. Start the camera service (Python + OpenCV)

```bash
cd camera_service
pip install -r requirements.txt
cp .env.example .env     # defaults already work: CAMERA_SOURCE=webcam, CAMERA_INDEX=0
python camera_service.py
```

This runs independently of the dashboard — start it once and leave it
running in its own terminal. See `camera_service/README.md` for webcam
setup, optional IP-camera fallback, and ROI tuning after positioning
the camera.

### Using your phone as the camera

Set `camera_service/.env`:

```text
CAMERA_SOURCE=ip
IP_CAMERA_URL=http://<phone-ip>:8080/video
```

(Using the Android "IP Webcam" app: open it, tap "Start server", and copy
the URL under "Video streams" — the raw MJPEG stream, not the HTML
preview page.) The OpenCV pipeline reads from this exact same URL for
belt/joint analysis.

## 4. Start the frontend
Open another terminal:

```bash
cd frontend
npm install
cp .env.example .env     # optional: set VITE_API_URL / VITE_PHONE_CAM_URL
npm run dev
```

Open the Vite URL, normally `http://localhost:5173`.

### Live cameras (device + phone)

The dashboard's Camera Analysis panel (in both Dashboard and Live Mode)
shows two live camera sources side by side:

1. **Phone camera (IP Webcam app)** — a live MJPEG feed from
   `VITE_PHONE_CAM_URL` in `frontend/.env`, e.g.
   `VITE_PHONE_CAM_URL=http://192.168.43.201:8080/video` (the URL shown
   under "Video streams" in the IP Webcam Android app — NOT the HTML
   preview page). The feed reconnects every ~1.2s with a cache-buster so
   latency stays bounded (~1.2s) instead of growing, and it auto-recovers
   if the phone's stream drops. If unset, the panel shows a "PHONE CAMERA
   NOT CONFIGURED" placeholder and the rest of the dashboard is unaffected.
2. **Your browser's own device camera** — streamed directly with
   `navigator.mediaDevices.getUserMedia()` onto a `<video>` element
   (`video.srcObject`). Shows clear states: REQUESTING CAMERA /
   CAMERA CONNECTED / CAMERA ERROR / LIVE, with a Start/Stop button.

Below both live feeds, the panel shows the **predefined/reference
annotated snapshot** produced by the `camera_service/` OpenCV pipeline
plus the full analysis evidence (belt detected, belt position, movement,
direction, tracking deviation, joint/visual condition, visual severity,
confidence, frame age). The reference snapshot is never
regenerated/cycled/replaced by either live feed.

### API host / IP configuration

The frontend never hard-codes a laptop IP. It resolves the backend URL as:

1. `VITE_API_URL`, if set (see `frontend/.env.example`), otherwise
2. `http://<the hostname the page was loaded from>:5000/api`

So opening the dashboard from `http://192.168.x.x:5173` on another device automatically talks to `http://192.168.x.x:5000/api` with no config. The backend listens on `0.0.0.0`, so it's reachable from the ESP32, the camera service, and any device on the same LAN. On Render, the backend serves the built frontend (`../frontend/dist`) at the same origin, so relative `/api` paths work with no extra config.

## 5. What the dashboard does

**The Dashboard is the primary live monitoring screen.** It is not a mode picker — vibration (ESP32/MPU6050) and camera evidence (laptop webcam + OpenCV) are both internal sensor channels that feed one fusion engine, and the Dashboard shows their combined output: overall condition, current vibration + trend, camera evidence (belt position/tracking/movement/direction/joint condition, plus a live annotated snapshot), final fused prediction with evidence/reason and a maintenance action, alerts, and system health.

- **CSV Dataset Mode** — retained for development/reference and hackathon demonstration; plays back the supplied CSV, scored against the CSV's *own* statistics. Tagged `context: "DATASET"` end-to-end so it never contaminates live alerts, live history, the live baseline, or the live fused condition. Includes a professional industrial analytics view: dataset-wide KPIs (record count, sensor count, normal/warning/critical counts, fault classes), real per-sensor trend charts for all five columns (temperature, vibration, speed/rpm, load, current), per-sensor min/max/avg/range statistics, condition + fault distribution charts, and a sensor/fault filter that scopes the trend charts to a single fault class.
- **Test Mode** — a clearly-labelled software test source; tagged `context: "TEST"` and posted through `/api/analyze`, never through the ESP32's `/api/live` contract, so it can never masquerade as a real live sample.
- **Live / ESP32** — `POST /api/live` (see contract below) stores incoming MPU6050 readings.
- **Live-only healthy baseline** — the baseline used to score LIVE vibration is built *exclusively* from real live samples that are themselves read as normal (or arrive during the first ~20-sample calibration window, before any baseline exists to judge against). The CSV dataset is never used as a stand-in, and a fault spike can never drag the "healthy" baseline toward itself — admission is gated on the raw (pre-confirmation) reading, not the display condition, so even the few frames while an anomaly is still being confirmed don't leak into what "normal" means.
- **Rolling vibration features** — RMS, peak, variance and trend are computed over a rolling window of recent live samples and included alongside the raw z-score (`analysis.features`).
- **Persistence, confirmation windows and hysteresis** — a raw per-sample condition (vibration, camera joint status, and the final fused condition) must be confirmed across several consecutive readings before it's allowed to change the *displayed* condition — more confirmations are required to escalate than to settle back down. This is what stops small normal vibration noise, or a single odd camera frame, from flickering the dashboard between NORMAL/ADVISORY/WARNING/CRITICAL.
- **Camera as a background subsystem** — `camera_service/` (Python + OpenCV) is a standalone process that captures the laptop's built-in webcam and keeps posting structured observations (plus a periodic annotated JPEG snapshot) regardless of which dashboard page is open. There is no manual camera start/stop in the UI — the dashboard just displays whatever the camera service last reported, including the latest snapshot.
- **Fusion engine** — combines vibration risk + camera risk (`backend/server.js`, `FUSION_CONFIG`). Camera is weighted as the primary evidence source internally; vibration is secondary. Internal weights are intentionally never surfaced in the UI as a labelled "priority" — the operator only sees Vibration / Camera / Overall condition / Final risk / Evidence / Maintenance action.
  - If camera is unavailable: continues on vibration alone, confidence reduced.
  - If vibration is unavailable: continues on camera alone, confidence reduced.
  - If both are unavailable: shows `WAITING FOR LIVE DATA`.
- **Evidence & maintenance recommendation** — every fused result includes a plain-language `evidence` list (what each sensor is currently reporting) and a `recommendation` (a generic, non-alarmist maintenance action), shown together on the dashboard for every condition, not just non-normal ones.
- **Sensor freshness** — vibration is tracked LIVE / STALE / OFFLINE; camera is tracked CONNECTED / STALE / OFFLINE / WAITING / ERROR, based purely on how recently a real reading arrived. If one channel drops, the fusion engine continues with the other and marks the result "reduced evidence" instead of crashing or freezing on stale data. With neither channel available, the Dashboard shows `WAITING`.
- **`GET /api/state`** — a single synchronized snapshot (`timestamp, vibration, vibrationTime, analysis, camera, sensorStatus, fusion, belt`) for polling, alongside the existing granular endpoints (`/api/live/history`, `/api/vision/latest`, `/api/sensor/status`) used elsewhere in the UI.
- **Health score** is always derived from the fused final risk (`100 - finalRisk`), never a hard-coded per-status number; it shows `--` when there's no valid evidence yet.
- **Alerts** are generated only from `context: "LIVE"` evidence and debounced (won't create a new alert every polling cycle for the same ongoing condition — see `ALERT_REPEAT_MS` in `backend/server.js`). Dataset/Test events are recorded separately (`/api/dataset/events`, `/api/test/events`) and never mixed into the live alert list.
- A lightweight KNN classifier provides a dataset fault *association* (not a diagnosis).
- A baseline-deviation anomaly engine gives Normal / Advisory / Warning / Critical states, held stable by the confirmation windows described above.

## 6. Important model honesty

The supplied dataset contains fault-labelled vibration observations but does not provide a healthy class. Therefore the dashboard does NOT claim that a fixed vibration value universally means a healthy conveyor or a belt-joint rupture.

For the physical prototype, collect healthy baseline readings from your own mini conveyor and use those readings for anomaly detection. The dataset is a development/reference source for vibration-associated fault classes, not the live healthy baseline.

The KNN label is an associated dataset class, not a diagnosis of exact industrial splice rupture.

The camera pipeline (`camera_service/`) is a transparent classical-OpenCV heuristic (`modelStatus: "OPENCV_HEURISTIC"`), not a trained neural network — it is never presented as one.

## 7. ESP32 integration contract

Send a JSON POST request to:

`POST http://localhost:5000/api/live`

Body:

```json
{"vibration":0.83}
```

The backend returns the live sample plus analysis. This is the only endpoint that feeds the live vibration history/baseline — Dataset and Test modes deliberately use `/api/analyze` with an explicit `context` instead.

### Two-way ESP32 control (actuators)

The ESP32 sends readings up via `/api/live` and receives actuator commands
down via polling, over plain HTTP (no WebSockets/MQTT needed).

- `GET /api/esp32/command` — returns the current actuator state, e.g.
  `{ "status": "NORMAL", "buzzer": false, "redLed": false, "greenLed": true, "esp32Status": "OFFLINE" }`.
  - CRITICAL → buzzer ON, red LED blinking, green OFF.
  - NORMAL → buzzer OFF, red OFF, green ON.
  - WARNING/other → existing per-condition behavior.
- `POST /api/esp32/heartbeat` — `{ "mac": "..." }` marks the board as
  ONLINE (the backend flips its status back to OFFLINE after ~15s with no
  heartbeat).
- `GET /api/esp32/status` — board connection + last-read vibration info.

Complete firmware is provided in `esp32_code/beltguard_esp32.ino`
(MPU6050 vibration, `/api/live` POST, `/api/esp32/command` GET,
`/api/esp32/heartbeat` POST, WiFi auto-reconnect, buzzer + red/green LEDs).

## 8. Camera data contract

See `camera_service/README.md` for the full pipeline. In short:

`POST http://<backend-host>:5000/api/vision/observation`

```json
{
  "cameraConnected": true,
  "beltDetected": true,
  "beltPosition": "CENTER",
  "centerOffset": 0.04,
  "trackingDeviation": 0.08,
  "motionState": "MOVING",
  "direction": "FORWARD",
  "motionMagnitude": 0.72,
  "motionStability": 0.91,
  "jointStatus": "NORMAL",
  "visualAnomaly": false,
  "visualSeverity": "NONE",
  "visualConfidence": 0.89,
  "roiQuality": 0.94,
  "modelStatus": "OPENCV_HEURISTIC",
  "snapshot": "data:image/jpeg;base64,...(optional, annotated still frame)..."
}
```

The backend never receives or stores raw video/frames — it stores at most one still, annotated JPEG snapshot per observation (draws the same ROI boxes and readings already in the JSON above onto a real captured frame; see `SNAPSHOT_*` settings in `camera_service/.env.example`), replacing the previous one. There is no live video stream anywhere in this pipeline, by design.

## 9. What this prototype does *not* claim

- The CSV is a development/reference vibration dataset, not NMDC historical failure data.
- No fabricated accuracy/confidence percentages or exact rupture dates.
- MPU6050 vibration alone does not "predict rupture."
- The OpenCV camera pipeline is a transparent heuristic, not a trained model, and is conservative by design — a single odd frame cannot escalate straight to HIGH/CRITICAL (see `camera_service/README.md` §6).
- This student prototype is not mine-ready, and the dashboard does not itself prevent accidents.

