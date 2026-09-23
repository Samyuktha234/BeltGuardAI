# BeltGuard AI — Camera Service (Python + OpenCV)

The camera is the laptop's own built-in (or USB) webcam, opened with
OpenCV. This Python service is the only thing that opens a camera and
runs OpenCV — the React dashboard never talks to a camera directly.

```
LAPTOP WEBCAM (cv2.VideoCapture)
        │  local video frames
        ▼
THIS SERVICE (Python + OpenCV)
        │  belt detection / position / motion / direction / joint inspection
        ▼
POST /api/vision/observation
        ▼
Node backend  →  fusion with vibration  →  React dashboard
```

No Android phone, IP Webcam app, phone IP address, or mobile Wi-Fi
stream is required to run this service.

## 1. Configure this service

```bash
cd camera_service
python3 -m venv venv && source venv/bin/activate   # optional but recommended
pip install -r requirements.txt
cp .env.example .env
```

The defaults already work out of the box:

- `CAMERA_SOURCE=webcam` — use the laptop's own webcam (the default
  camera source for this project).
- `CAMERA_INDEX=0` — the index OpenCV opens with
  `cv2.VideoCapture(CAMERA_INDEX)`. `0` is almost always the laptop's
  built-in camera. If you have more than one camera attached, try `1`,
  `2`, etc.

Also check `BACKEND_URL` points at the Node backend (default
`http://localhost:5000` is correct if both run on the same laptop).

## 2. Run it

```bash
python camera_service.py
```

You should see it log a successful connection to the laptop webcam and
then keep posting observations. If the webcam is busy or unavailable
it will log the failure and keep retrying — it does not crash.

## 3. Tuning the ROI

Because the camera's physical position/angle varies, the belt won't
always land in the default region of the frame. `.env` has two
configurable regions, each as **normalized** (0.0–1.0) coordinates
measured from the top-left corner:

- `ROI_X / ROI_Y / ROI_WIDTH / ROI_HEIGHT` — where the belt itself is
  expected to be, used for position/tracking/motion/direction.
- `JOINT_ROI_X / JOINT_ROI_Y / JOINT_ROI_WIDTH / JOINT_ROI_HEIGHT` — a
  smaller box over the visible belt joint/splice, used for visual
  inspection.

To tune: run the service, look at the annotated snapshot on the
dashboard's Camera Analysis card, and adjust the four numbers for each
ROI so the boxes line up with the belt (and, separately, the joint).
Restart the service after editing `.env`.

## 4. What it reports

Every processed frame produces one structured observation posted to
`POST /api/vision/observation` on the backend — see the schema in
`camera_service.py::build_observation`. Key fields:

- `beltDetected`, `beltPosition`, `centerOffset`, `trackingDeviation`
- `motionState`, `direction`, `motionMagnitude`, `motionStability`, `directionConfidence`
- `jointStatus`, `visualAnomaly`, `visualSeverity`, `visualConfidence`, `roiQuality`
- `snapshot` — an optional annotated JPEG (data URI) of the frame this
  observation was derived from, with the belt/joint ROI boxes and
  current readings drawn on it. This is a still image for the
  dashboard's Camera Analysis card, not a video stream. Controlled by
  `SNAPSHOT_ENABLED` / `SNAPSHOT_MAX_WIDTH` / `SNAPSHOT_JPEG_QUALITY` /
  `SNAPSHOT_EVERY_N_FRAMES` in `.env`.
- `modelStatus: "OPENCV_HEURISTIC"` — this is a transparent classical
  computer-vision pipeline, not a trained neural network. It never
  claims otherwise.

## 5. Why results don't jump straight to CRITICAL

The visual-anomaly logic in `JointInspector.inspect()` is deliberately
conservative:

- It first learns a live baseline of "normal" texture variance for
  *this* belt/lighting — it doesn't hard-code a universal threshold.
- A single odd-looking frame is recorded but capped at `ADVISORY`.
- Only when an anomaly persists across `ANOMALY_PERSISTENCE_FRAMES`
  consecutive/majority frames (default 8) can severity escalate to
  `WARNING`/`HIGH`/`CRITICAL`, and even then severity scales with how
  far the reading is from baseline and how good the ROI image quality
  is. This avoids exaggerated false positives from a single frame of
  glare, motion blur, or noise.

## 6. Status semantics

This service never claims a fake "LIVE"/"CONNECTED" state. The backend
derives real states (`CONNECTED` / `STALE` / `OFFLINE` / `WAITING` /
`ERROR`) purely from how recently an observation actually arrived here
— see `cameraConnectionStatus()` in `backend/server.js`.

## 7. Running continuously alongside the dashboard

This service is a standalone background process — it has no UI and
does not depend on any React page being open. Start it once (e.g. in
its own terminal, or as a background/systemd service) and it keeps
running and reporting regardless of which page is open in the
dashboard.

## 8. Optional: using an IP camera instead

If a laptop webcam isn't available or you'd rather use a network
camera (e.g. an Android phone running the "IP Webcam" app), you can
switch to that mode instead:

1. Install **IP Webcam** (Pavel Khlebovich) on the phone and connect it
   to the **same Wi-Fi network** as the laptop.
2. Open the app, scroll down, tap **Start server**, and note the URL
   shown, e.g. `http://192.168.1.42:8080` (the actual stream is
   usually at `http://192.168.1.42:8080/video`, some builds use
   `/videofeed` instead — try both).
3. In `.env`, set `CAMERA_SOURCE=ip` and `IP_CAMERA_URL` to that
   stream URL.
4. Restart the service.

The laptop webcam remains the default; this is purely an optional
fallback and is not required for normal use.
