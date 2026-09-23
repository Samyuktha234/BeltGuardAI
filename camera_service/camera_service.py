"""
BeltGuard AI — Camera Service
==============================

LAPTOP WEBCAM --OpenCV--> THIS SERVICE (Python + OpenCV) --HTTP--> Node backend

This process is the ONLY thing that touches a camera in this project.
By default it opens the laptop's own built-in webcam with
`cv2.VideoCapture(CAMERA_INDEX)`, pulls frames with OpenCV, and derives
structured belt/vision observations which it POSTs to the Node
backend's `POST /api/vision/observation`. The React dashboard never
talks to a camera directly — it only ever polls the backend for the
observations/snapshots this service sends.

An optional secondary mode still exists for a network/IP camera (e.g.
an Android phone running "IP Webcam") for setups where a laptop
webcam isn't available or desired — see CAMERA_SOURCE below — but no
phone, IP Webcam app, or mobile Wi-Fi stream is required to run this
service.

Run:
    pip install -r requirements.txt
    cp .env.example .env      # CAMERA_INDEX=0 works out of the box
    python camera_service.py

This is a deliberately transparent, classical-OpenCV pipeline
(no trained neural network ships with this prototype). Every result
reports modelStatus="OPENCV_HEURISTIC" so nothing pretends to be more
than it is.
"""

import os
import sys
import time
import json
import logging
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone

import cv2
import numpy as np
import requests
from dotenv import load_dotenv

load_dotenv()

# =============================================================
# CONFIG
# =============================================================

def _float_env(name, default):
    try:
        return float(os.getenv(name, default))
    except (TypeError, ValueError):
        return float(default)


def _int_env(name, default):
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return int(default)


# ---- Camera source ----
# "webcam" (default) opens the laptop's own built-in/USB webcam via
# cv2.VideoCapture(CAMERA_INDEX) — no phone or network stream needed.
# "ip" is an optional secondary mode for a network/IP camera (e.g. an
# Android phone running "IP Webcam"), kept for setups that still want
# it, using IP_CAMERA_URL below.
CAMERA_SOURCE = os.getenv("CAMERA_SOURCE", "webcam").strip().lower()
CAMERA_INDEX = _int_env("CAMERA_INDEX", 0)
IP_CAMERA_URL = os.getenv("IP_CAMERA_URL", "").strip()
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:5000").rstrip("/")
OBSERVATION_ENDPOINT = f"{BACKEND_URL}/api/vision/observation"

PROCESS_FPS = _float_env("PROCESS_FPS", 6)
PROCESS_INTERVAL = 1.0 / max(PROCESS_FPS, 0.5)
MAX_FRAME_WIDTH = _int_env("MAX_FRAME_WIDTH", 480)

ROI = dict(
    x=_float_env("ROI_X", 0.1),
    y=_float_env("ROI_Y", 0.35),
    w=_float_env("ROI_WIDTH", 0.8),
    h=_float_env("ROI_HEIGHT", 0.3),
)
JOINT_ROI = dict(
    x=_float_env("JOINT_ROI_X", 0.42),
    y=_float_env("JOINT_ROI_Y", 0.35),
    w=_float_env("JOINT_ROI_WIDTH", 0.16),
    h=_float_env("JOINT_ROI_HEIGHT", 0.3),
)

RECONNECT_DELAY_SEC = _float_env("RECONNECT_DELAY_SEC", 3)
ANOMALY_PERSISTENCE_FRAMES = _int_env("ANOMALY_PERSISTENCE_FRAMES", 8)
SMOOTHING_WINDOW = _int_env("SMOOTHING_WINDOW", 15)

# ---- Annotated snapshot (for the dashboard's Camera Analysis card) ----
# The dashboard shows a still, annotated snapshot of what the OpenCV
# pipeline is currently seeing — not a live video player. This is a
# real frame from the camera, drawn on with the same ROI boxes
# and readings the backend fuses, never a placeholder image.
SNAPSHOT_ENABLED = os.getenv("SNAPSHOT_ENABLED", "true").strip().lower() != "false"
SNAPSHOT_MAX_WIDTH = _int_env("SNAPSHOT_MAX_WIDTH", 480)
SNAPSHOT_JPEG_QUALITY = _int_env("SNAPSHOT_JPEG_QUALITY", 70)
SNAPSHOT_EVERY_N_FRAMES = _int_env("SNAPSHOT_EVERY_N_FRAMES", 12)

MODEL_STATUS = "OPENCV_HEURISTIC"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [camera_service] %(levelname)s %(message)s",
)
log = logging.getLogger("camera_service")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# =============================================================
# CAMERA CONNECTION
# Default: laptop's built-in/USB webcam via cv2.VideoCapture(CAMERA_INDEX).
# Optional secondary mode: a network/IP camera stream (e.g. phone
# running "IP Webcam") via cv2.VideoCapture(IP_CAMERA_URL).
# =============================================================

class CameraConnection:
    """Owns the cv2.VideoCapture for the configured camera source
    (laptop webcam index, or optionally an IP camera URL). Detects
    failure and reconnects automatically instead of letting the whole
    service die if the camera hiccups."""

    def __init__(self, source, source_label):
        self.source = source
        self.source_label = source_label
        self.cap = None
        self.connected = False
        self.last_error = None

    def connect(self):
        if self.source is None or self.source == "":
            self.last_error = f"camera source is not configured ({self.source_label})"
            self.connected = False
            return False
        try:
            if self.cap is not None:
                self.cap.release()
            self.cap = cv2.VideoCapture(self.source)
            # Small buffer so we always get roughly the latest frame
            # instead of drifting behind a growing backlog.
            try:
                self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            except Exception:
                pass
            self.connected = self.cap.isOpened()
            if not self.connected:
                self.last_error = f"could not open camera source {self.source_label}"
            return self.connected
        except Exception as exc:  # noqa: BLE001 - keep service alive
            self.last_error = str(exc)
            self.connected = False
            return False

    def read(self):
        """Returns (ok, frame). Never raises — caller decides what to
        do with a failed read (retry vs reconnect)."""
        if self.cap is None or not self.connected:
            return False, None
        try:
            ok, frame = self.cap.read()
            if not ok or frame is None:
                self.connected = False
                self.last_error = "stream returned no frame"
                return False, None
            return True, frame
        except Exception as exc:  # noqa: BLE001
            self.last_error = str(exc)
            self.connected = False
            return False, None

    def release(self):
        if self.cap is not None:
            self.cap.release()
        self.connected = False


# =============================================================
# BELT ANALYSIS (position, tracking, motion, direction)
# =============================================================

@dataclass
class BeltAnalyzer:
    position_history: deque = field(default_factory=lambda: deque(maxlen=SMOOTHING_WINDOW))
    prev_gray_roi: np.ndarray = None
    motion_history: deque = field(default_factory=lambda: deque(maxlen=SMOOTHING_WINDOW))
    direction_history: deque = field(default_factory=lambda: deque(maxlen=SMOOTHING_WINDOW))

    def crop_roi(self, frame, roi):
        h, w = frame.shape[:2]
        x0 = int(roi["x"] * w)
        y0 = int(roi["y"] * h)
        x1 = int(min(w, x0 + roi["w"] * w))
        y1 = int(min(h, y0 + roi["h"] * h))
        x0, y0 = max(0, x0), max(0, y0)
        if x1 <= x0 or y1 <= y0:
            return None
        return frame[y0:y1, x0:x1]

    def detect_belt(self, roi_bgr):
        """Belt detection + horizontal position via edge density and
        the largest horizontal band of edges in the ROI. Classical,
        transparent heuristic — no trained model."""
        if roi_bgr is None or roi_bgr.size == 0:
            return False, "UNKNOWN", None

        gray = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(blurred, 40, 120)

        edge_density = float(np.count_nonzero(edges)) / edges.size
        belt_detected = edge_density > 0.02  # tuned for a visible belt edge/texture

        if not belt_detected:
            return False, "UNKNOWN", None

        # Column-wise edge energy -> weighted centroid gives the belt's
        # horizontal position inside the ROI.
        col_energy = edges.sum(axis=0).astype(np.float64)
        total = col_energy.sum()
        if total <= 0:
            return belt_detected, "UNKNOWN", None

        width = edges.shape[1]
        centroid = float((col_energy * np.arange(width)).sum() / total)
        center_offset = (centroid - (width / 2.0)) / (width / 2.0)  # -1..1

        if center_offset < -0.15:
            position = "LEFT"
        elif center_offset > 0.15:
            position = "RIGHT"
        else:
            position = "CENTER"

        return belt_detected, position, center_offset

    def tracking_deviation(self, center_offset):
        if center_offset is None:
            return None
        self.position_history.append(center_offset)
        if len(self.position_history) < 3:
            return 0.0
        arr = np.array(self.position_history)
        # Deviation = how much the belt's position wanders around its
        # own recent mean, normalized to roughly 0..1.
        deviation = float(np.std(arr))
        return float(min(1.0, deviation * 3.0))

    def motion_and_direction(self, roi_bgr):
        """Motion state from frame differencing; direction from dense
        optical flow. Both use TEMPORAL information (never a single
        frame) as required for a moving conveyor belt."""
        if roi_bgr is None or roi_bgr.size == 0:
            return "UNKNOWN", "UNKNOWN", None, None, None

        gray = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)

        if self.prev_gray_roi is None or self.prev_gray_roi.shape != gray.shape:
            self.prev_gray_roi = gray
            return "UNKNOWN", "UNKNOWN", None, None, None

        # --- Motion magnitude via frame differencing ---
        diff = cv2.absdiff(gray, self.prev_gray_roi)
        motion_magnitude = float(np.mean(diff)) / 255.0
        self.motion_history.append(motion_magnitude)
        smoothed_motion = float(np.mean(self.motion_history))
        motion_stability = float(1.0 - min(1.0, np.std(self.motion_history) * 4.0)) if len(self.motion_history) > 2 else 0.5

        motion_state = "MOVING" if smoothed_motion > 0.015 else "STOPPED"

        # --- Direction via dense optical flow (Farneback) ---
        direction = "UNKNOWN"
        direction_confidence = None
        if motion_state == "MOVING":
            flow = cv2.calcOpticalFlowFarneback(
                self.prev_gray_roi, gray, None,
                pyr_scale=0.5, levels=2, winsize=15,
                iterations=2, poly_n=5, poly_sigma=1.1, flags=0,
            )
            horizontal_flow = flow[..., 0]
            mean_flow = float(np.mean(horizontal_flow))
            flow_consistency = float(1.0 - min(1.0, np.std(horizontal_flow) / (abs(mean_flow) + 1e-3) / 10.0))
            self.direction_history.append(mean_flow)

            avg_flow = float(np.mean(self.direction_history))
            if abs(avg_flow) < 0.05:
                direction = "UNKNOWN"
                direction_confidence = 0.2
            else:
                direction = "FORWARD" if avg_flow > 0 else "REVERSE"
                direction_confidence = float(max(0.3, min(0.95, flow_consistency)))
        else:
            self.direction_history.clear()

        self.prev_gray_roi = gray
        return motion_state, direction, smoothed_motion, motion_stability, direction_confidence


# =============================================================
# JOINT / VISUAL INSPECTION — conservative anomaly logic
# =============================================================

@dataclass
class JointInspector:
    """Looks for visible surface irregularities (cracks, edge damage,
    abnormal joint appearance) in a dedicated ROI. Uses classical
    OpenCV texture/edge measures with a REQUIRED persistence window —
    a single odd frame must never escalate straight to HIGH/CRITICAL.
    """

    baseline_variance: deque = field(default_factory=lambda: deque(maxlen=60))
    anomaly_flags: deque = field(default_factory=lambda: deque(maxlen=max(ANOMALY_PERSISTENCE_FRAMES * 2, 16)))

    def roi_quality(self, roi_gray):
        # Quality = enough brightness + contrast to trust the reading.
        mean_brightness = float(np.mean(roi_gray)) / 255.0
        contrast = float(np.std(roi_gray)) / 128.0
        brightness_ok = 0.15 < mean_brightness < 0.9
        quality = min(1.0, contrast) * (1.0 if brightness_ok else 0.4)
        return float(max(0.0, min(1.0, quality)))

    def inspect(self, roi_bgr):
        if roi_bgr is None or roi_bgr.size == 0:
            return dict(
                jointStatus="UNKNOWN", visualAnomaly=False,
                visualSeverity="NONE", visualConfidence=0.0, roiQuality=0.0,
            )

        gray = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (3, 3), 0)
        quality = self.roi_quality(gray)

        # Laplacian variance = a standard, well-understood texture/edge
        # "sharpness" measure. Cracks/edge-damage/abnormal joints tend
        # to add high-frequency irregularity relative to the belt's own
        # established baseline texture (learned live, not hard-coded,
        # so it adapts to this specific belt/lighting).
        lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        self.baseline_variance.append(lap_var)

        if len(self.baseline_variance) < 10:
            # Not enough history yet to know what "normal" looks like
            # for this belt — stay silent rather than guess.
            return dict(
                jointStatus="NORMAL", visualAnomaly=False,
                visualSeverity="NONE", visualConfidence=0.3, roiQuality=quality,
            )

        base_arr = np.array(self.baseline_variance)
        base_mean, base_std = float(np.mean(base_arr)), float(np.std(base_arr)) + 1e-6
        z = abs(lap_var - base_mean) / base_std

        # Contour irregularity as a corroborating signal (edge count
        # inside the joint ROI relative to its area).
        edges = cv2.Canny(gray, 50, 130)
        contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        contour_density = len(contours) / max(1, (gray.shape[0] * gray.shape[1]) / 500)

        frame_flagged = z > 2.2 and contour_density > 1.2 and quality > 0.35
        self.anomaly_flags.append(1 if frame_flagged else 0)

        recent = list(self.anomaly_flags)[-ANOMALY_PERSISTENCE_FRAMES:]
        persistence_ratio = sum(recent) / len(recent) if recent else 0.0
        persistent_enough = len(recent) >= ANOMALY_PERSISTENCE_FRAMES and persistence_ratio >= 0.6

        confidence = float(max(0.2, min(0.95, quality * (0.5 + 0.5 * min(1.0, z / 4)))))

        if not frame_flagged:
            return dict(
                jointStatus="NORMAL", visualAnomaly=False,
                visualSeverity="NONE", visualConfidence=confidence, roiQuality=quality,
            )

        if not persistent_enough:
            # Seen it, but not enough times yet — conservative: treat a
            # transient blip as advisory at most, never HIGH/CRITICAL.
            return dict(
                jointStatus="ADVISORY", visualAnomaly=True,
                visualSeverity="ADVISORY", visualConfidence=confidence, roiQuality=quality,
            )

        # Persistent across many frames -> escalate, but severity still
        # scales with how far past baseline + how good the evidence is.
        if z > 5 and persistence_ratio > 0.85 and quality > 0.6:
            severity = "CRITICAL" if z > 7 else "HIGH"
        else:
            severity = "WARNING"

        return dict(
            jointStatus="DAMAGED", visualAnomaly=True,
            visualSeverity=severity, visualConfidence=confidence, roiQuality=quality,
        )


# =============================================================
# SNAPSHOT ANNOTATION — draws what the pipeline actually measured
# onto a real frame, for the dashboard's Camera Analysis card.
# =============================================================

def _roi_pixels(frame, roi):
    h, w = frame.shape[:2]
    x0 = int(roi["x"] * w)
    y0 = int(roi["y"] * h)
    x1 = int(min(w, x0 + roi["w"] * w))
    y1 = int(min(h, y0 + roi["h"] * h))
    return max(0, x0), max(0, y0), x1, y1


def annotate_snapshot(frame, belt_detected, position, motion_state, direction,
                       joint_result, connection_ok):
    """Draws the belt ROI, joint ROI, and current readings onto a copy
    of the real frame. This is purely a visualization of the same
    values already sent in the observation — it never invents a
    reading that differs from what was fused."""
    annotated = resize_frame(frame, SNAPSHOT_MAX_WIDTH).copy()

    belt_color = (0, 200, 80) if belt_detected else (90, 90, 90)
    bx0, by0, bx1, by1 = _roi_pixels(annotated, ROI)
    cv2.rectangle(annotated, (bx0, by0), (bx1, by1), belt_color, 2)

    joint_status = joint_result.get("jointStatus", "UNKNOWN")
    joint_color = {
        "NORMAL": (0, 200, 80),
        "ADVISORY": (0, 200, 230),
        "DAMAGED": (0, 60, 230),
        "UNKNOWN": (140, 140, 140),
    }.get(joint_status, (140, 140, 140))
    jx0, jy0, jx1, jy1 = _roi_pixels(annotated, JOINT_ROI)
    cv2.rectangle(annotated, (jx0, jy0), (jx1, jy1), joint_color, 2)

    label = f"{position or 'UNKNOWN'} | {motion_state or 'UNKNOWN'} {direction or ''}".strip()
    cv2.putText(annotated, label, (bx0, max(15, by0 - 8)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, belt_color, 1, cv2.LINE_AA)
    cv2.putText(annotated, f"JOINT: {joint_status}", (jx0, min(annotated.shape[0] - 6, jy1 + 16)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.42, joint_color, 1, cv2.LINE_AA)

    banner = "LIVE" if connection_ok else "DISCONNECTED"
    banner_color = (0, 200, 80) if connection_ok else (0, 60, 230)
    cv2.putText(annotated, banner, (8, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, banner_color, 1, cv2.LINE_AA)

    return annotated


def encode_snapshot_data_uri(annotated_bgr):
    ok, buf = cv2.imencode(".jpg", annotated_bgr, [cv2.IMWRITE_JPEG_QUALITY, SNAPSHOT_JPEG_QUALITY])
    if not ok:
        return None
    import base64
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


# =============================================================
# REPORTER — sends structured observations to the Node backend
# =============================================================

class BackendReporter:
    def __init__(self, endpoint):
        self.endpoint = endpoint
        self.session = requests.Session()

    def send(self, observation):
        try:
            resp = self.session.post(self.endpoint, json=observation, timeout=2.5)
            if resp.status_code >= 400:
                log.warning("backend rejected observation: %s %s", resp.status_code, resp.text[:200])
            return resp.ok
        except requests.RequestException as exc:
            # Backend down/unreachable -> keep processing locally and
            # retry on the next tick. Never crash the vision loop.
            log.warning("could not reach backend (%s): %s", self.endpoint, exc)
            return False


# =============================================================
# MAIN LOOP
# =============================================================

def resize_frame(frame, max_width):
    h, w = frame.shape[:2]
    if w <= max_width:
        return frame
    scale = max_width / float(w)
    return cv2.resize(frame, (max_width, int(h * scale)), interpolation=cv2.INTER_AREA)


def build_observation(belt_ok, position, center_offset, deviation,
                       motion_state, direction, motion_mag, motion_stab,
                       direction_conf, joint_result, connection_ok, error=None,
                       snapshot=None, frame_captured_at=None):
    ts = now_iso()
    return {
        "cameraConnected": connection_ok,
        "frameFresh": True,
        "timestamp": ts,
        "frameTimestamp": frame_captured_at or ts,
        "processingTimestamp": ts,
        "snapshot": snapshot,
        "beltDetected": belt_ok,
        "beltPosition": position or "UNKNOWN",
        "centerOffset": None if center_offset is None else round(center_offset, 4),
        "trackingDeviation": None if deviation is None else round(deviation, 4),
        "motionState": motion_state,
        "direction": direction,
        "motionMagnitude": None if motion_mag is None else round(motion_mag, 4),
        "motionStability": None if motion_stab is None else round(motion_stab, 4),
        "directionConfidence": None if direction_conf is None else round(direction_conf, 4),
        "jointStatus": joint_result["jointStatus"],
        "visualAnomaly": joint_result["visualAnomaly"],
        "visualSeverity": joint_result["visualSeverity"],
        "visualConfidence": round(joint_result["visualConfidence"], 4),
        "roiQuality": round(joint_result["roiQuality"], 4),
        "modelStatus": MODEL_STATUS,
        "error": error,
    }


def run():
    if CAMERA_SOURCE == "ip":
        if not IP_CAMERA_URL:
            log.error(
                "CAMERA_SOURCE=ip but IP_CAMERA_URL is not set. Copy "
                ".env.example to .env and set it to your IP camera's stream "
                "URL, e.g. http://192.168.1.42:8080/video"
            )
        camera_source = IP_CAMERA_URL
        source_label = f"IP camera ({IP_CAMERA_URL or 'not configured'})"
    else:
        # Default: laptop's built-in/USB webcam. No phone, IP Webcam app,
        # or mobile Wi-Fi stream required.
        camera_source = CAMERA_INDEX
        source_label = f"laptop webcam (index {CAMERA_INDEX})"

    connection = CameraConnection(camera_source, source_label)
    belt = BeltAnalyzer()
    joint = JointInspector()
    reporter = BackendReporter(OBSERVATION_ENDPOINT)

    log.info("camera_service starting")
    log.info("  camera source: %s", source_label)
    log.info("  backend      : %s", OBSERVATION_ENDPOINT)
    log.info("  belt ROI     : %s", ROI)
    log.info("  joint ROI    : %s", JOINT_ROI)

    connected = connection.connect()
    if not connected:
        log.warning("initial connection failed: %s", connection.last_error)

    last_process_at = 0.0
    frame_counter = [0]

    while True:
        try:
            if not connection.connected:
                ok = connection.connect()
                if not ok:
                    reporter.send(build_observation(
                        False, "UNKNOWN", None, None, "UNKNOWN", "UNKNOWN",
                        None, None, None,
                        dict(jointStatus="UNKNOWN", visualAnomaly=False,
                             visualSeverity="NONE", visualConfidence=0.0, roiQuality=0.0),
                        connection_ok=False, error=connection.last_error or "OFFLINE",
                    ))
                    time.sleep(RECONNECT_DELAY_SEC)
                    continue
                log.info("connected to camera source (%s)", connection.source_label)

            ok, frame = connection.read()
            if not ok:
                log.warning("frame read failed (%s) — will reconnect", connection.last_error)
                reporter.send(build_observation(
                    False, "UNKNOWN", None, None, "UNKNOWN", "UNKNOWN",
                    None, None, None,
                    dict(jointStatus="UNKNOWN", visualAnomaly=False,
                         visualSeverity="NONE", visualConfidence=0.0, roiQuality=0.0),
                    connection_ok=False, error=connection.last_error or "STREAM_LOST",
                ))
                time.sleep(RECONNECT_DELAY_SEC)
                continue

            now = time.time()
            if now - last_process_at < PROCESS_INTERVAL:
                # Drain the buffer without doing full analysis on every
                # single frame — keeps CPU usage sane at the camera's
                # native frame rate while still reacting quickly.
                continue
            last_process_at = now

            frame = resize_frame(frame, MAX_FRAME_WIDTH)

            belt_roi = belt.crop_roi(frame, ROI)
            belt_detected, position, center_offset = belt.detect_belt(belt_roi)
            deviation = belt.tracking_deviation(center_offset) if belt_detected else None
            motion_state, direction, motion_mag, motion_stab, direction_conf = (
                belt.motion_and_direction(belt_roi) if belt_detected else ("UNKNOWN", "UNKNOWN", None, None, None)
            )

            joint_roi = belt.crop_roi(frame, JOINT_ROI)
            joint_result = joint.inspect(joint_roi)

            snapshot = None
            frame_captured_at = now_iso()
            if SNAPSHOT_ENABLED:
                frame_counter[0] += 1
                if frame_counter[0] % max(1, SNAPSHOT_EVERY_N_FRAMES) == 0:
                    try:
                        annotated = annotate_snapshot(
                            frame, belt_detected, position, motion_state, direction,
                            joint_result, connection_ok=True,
                        )
                        snapshot = encode_snapshot_data_uri(annotated)
                    except Exception:  # noqa: BLE001 - snapshot is best-effort only
                        log.exception("failed to build annotated snapshot")

            observation = build_observation(
                belt_detected, position, center_offset, deviation,
                motion_state, direction, motion_mag, motion_stab, direction_conf,
                joint_result, connection_ok=True,
                snapshot=snapshot, frame_captured_at=frame_captured_at,
            )
            reporter.send(observation)

        except KeyboardInterrupt:
            log.info("shutting down (keyboard interrupt)")
            break
        except Exception as exc:  # noqa: BLE001 - never let processing errors kill the service
            log.exception("unexpected error in processing loop: %s", exc)
            time.sleep(1.0)

    connection.release()


if __name__ == "__main__":
    run()
