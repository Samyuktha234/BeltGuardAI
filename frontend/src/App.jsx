import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Camera,
  CheckCircle2,
  ChevronRight,
  Database,
  Gauge,
  History,
  LayoutDashboard,
  Menu,
  Play,
  Pause,
  RotateCcw,
  Settings,
  ShieldCheck,
  Thermometer,
  Wifi,
  WifiOff,
  Wrench,
  Zap,
  X,
  Cpu,
  Eye,
  CircleDot,
  MessageSquare,
  Send
} from "lucide-react";

import {
  AreaChart,
  Area,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
  PieChart,
  Pie,
  Cell,
  Legend
} from "recharts";

import "./App.css";


// Never hard-code a single laptop IP: prefer an explicit build-time
// VITE_API_URL. If unset, derive the backend URL from the page host.
// In dev, the Vite proxy (vite.config.js) forwards /api to localhost:5000.
// In production (Render), the backend serves the built frontend AND the
// API at the same origin, so relative "/api" paths just work.
const API = (() => {
  const url = (import.meta.env && import.meta.env.VITE_API_URL) || "";
  if (url) return url.replace(/\/+$/, "");
  return `/api`;
})();
const PLAY_MS = 900;

// Add a timeout to every fetch so unresponsive backends don't leave the
// UI in an infinite loading state.
async function apiFetch(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// The live camera is the phone's external IP Webcam (MJPEG) feed
// (see IpWebcamLive below). The separate camera_service.py + OpenCV
// pipeline still posts structured observations + annotated snapshots to
// the backend for visual analysis.


function fmt(n, d = 2) {
  return n == null || Number.isNaN(Number(n))
    ? "--"
    : Number(n).toFixed(d);
}


function badgeClass(status) {
  return String(status || "")
    .toLowerCase();
}


function App() {

  /* =========================
     ORIGINAL STATE
  ========================= */

  const [mode, setMode] = useState("dashboard");

  const [dataset, setDataset] = useState([]);
  const [info, setInfo] = useState(null);
  const [index, setIndex] = useState(0);

  /* =========================
     DATASET MODE — MULTI-SENSOR STATE
     Kept entirely separate from Live/Camera state above. `datasetRecord`
     always holds ALL sensor values for the single currently-selected CSV
     row (never independent per-sensor indexes) and `datasetStats` holds
     dataset-wide averages/distributions/formula, fetched once.
  ========================= */
  const [datasetRecord, setDatasetRecord] = useState(null);
  const [datasetStats, setDatasetStats] = useState(null);
  // Rolling buffer of ALL FIVE sensor values together, one entry per
  // playback step — same index as `history` (vibration-only, shared with
  // Live Mode) but scoped to Dataset Mode so it never touches Live/Camera
  // state. Powers the per-sensor trend graphs below.
  const [datasetSensorHistory, setDatasetSensorHistory] = useState([]);

  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(null);
  const [history, setHistory] = useState([]);

  // Critical test: drive the REAL /api/live pipeline (the same one the
  // ESP32 uses) so the vibration KPI, trend chart, fusion condition,
  // actuator command, alarm, and SMS all react authentically — no fake
  // frontend state, no "simulated" banner. Sequence:
  //   1. If the live baseline is still calibrating (< 20 samples), post
  //      healthy ~0.7 m/s² readings first so it calibrates on NORMAL
  //      values (the burst must never pollute its own baseline).
  //   2. Hold a genuinely-CRITICAL 2.6 m/s² condition for ~9 seconds.
  //   3. Post a few NORMAL readings so the condition clears itself
  //      (de-escalation needs 3 consecutive non-critical frames).
  const [criticalDemo, setCriticalDemo] = useState(false);

  const triggerCriticalDemo = useCallback(async () => {
    if (criticalDemo) return;
    setCriticalDemo(true);
    try {
      const post = (vibration) =>
        apiFetch(`${API}/live`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vibration })
        }, 4000).catch(() => null);
      const pause = (ms) => new Promise(r => setTimeout(r, ms));

      // 1. Baseline warm-up so a fresh/unrestarted backend calibrates
      //    on healthy values before the alarm.
      const bl = await apiFetch(`${API}/baseline`, {}, 3000)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);
      const need = Math.min(20, Math.max(0, 20 - (bl?.count || 0)));
      for (let i = 0; i < need; i++) {
        await post(0.7);
        await pause(90);
      }
      if (need) await pause(400);

      // 2. Hold real CRITICAL for ~9s.
      const start = Date.now();
      while (Date.now() - start < 9000) {
        await post(2.6);
        await pause(100);
      }

      // 3. Clear: three+ NORMAL frames return the condition to NORMAL.
      for (let i = 0; i < 4; i++) {
        await post(0.7);
        await pause(100);
      }
    } finally {
      setCriticalDemo(false);
    }
  }, [criticalDemo]);
  // Test Mode's OWN rolling vibration buffer — deliberately separate from
  // the Live/Dashboard `history` above so a test run's graph always comes
  // from the same test-state source as the numeric Test Vibration KPI,
  // and never shows stale/unrelated Live data (or vice versa).
  const [testHistory, setTestHistory] = useState([]);
  const testSampleIdRef = useRef(0);
  const [alerts, setAlerts] = useState([]);
  const [baseline, setBaseline] = useState(null);

  const [espStatus, setEspStatus] =
    useState("OFFLINE");

  const [sidebarOpen, setSidebarOpen] =
    useState(false);

  /* =========================
     CAMERA-FUSION STATE
     The camera itself is a separate Python + OpenCV service watching
     the laptop's built-in webcam (see camera_service/). The
     frontend never opens a camera — it only polls the backend for the
     latest structured observation and connection status.
  ========================= */

  const [cameraResult, setCameraResult] =
    useState(null);

  // The status/text fields (belt position, tracking, freshness, etc.)
  // refresh on the fast 2s poll below, but the SNAPSHOT IMAGE itself is
  // deliberately held for longer stretches between swaps — the dashboard
  // is meant to show a still inspection photo, not something that
  // flickers like a live video feed every couple of seconds.
  const SNAPSHOT_DISPLAY_INTERVAL_MS = 6000;
  const lastSnapshotRef = useRef({ time: 0, snapshot: null, frameTimestamp: null });

  const [sensorStatus, setSensorStatus] =
    useState(null);

  const [smsState, setSmsState] = useState(null);
  const [smsSending, setSmsSending] = useState(false);

  const lastVibTimeRef = useRef(null);


  /* =========================
     LOAD BACKEND DATA
     Runs asynchronously — the dashboard always renders immediately even
     if the backend is slow or unavailable. Timeouts prevent endless
     loading. If all fetches fail, set a disconnected state.
  ========================= */

  const [backendConnected, setBackendConnected] = useState(null); // null=checking, true/false

  useEffect(() => {

    let cancelled = false;

    Promise.all([
      apiFetch(`${API}/vibration`).then(r => r.ok ? r.json() : []).catch(() => []),
      apiFetch(`${API}/info`).then(r => r.ok ? r.json() : null).catch(() => null),
      apiFetch(`${API}/alerts`).then(r => r.ok ? r.json() : []).catch(() => []),
      apiFetch(`${API}/baseline`).then(r => r.ok ? r.json() : null).catch(() => null),
      apiFetch(`${API}/dataset/stats`).then(r => r.ok ? r.json() : null).catch(() => null)
    ])
      .then(([rows, meta, a, b, stats]) => {
        if (cancelled) return;
        setDataset(rows);
        setInfo(meta);
        setAlerts(a);
        setBaseline(b);
        setDatasetStats(stats);
        setBackendConnected(true);

        if (rows[0]) {
          loadDatasetRow(0, rows);
        }

        setEspStatus("READY");

      })
      .catch(() => {
        if (cancelled) return;
        setBackendConnected(false);
        setEspStatus("BACKEND DISCONNECTED");
      });

    return () => { cancelled = true; };

  }, []);


  /* =========================
     DATASET PLAYBACK
  ========================= */

  useEffect(() => {

    if (
      !playing ||
      mode !== "dataset" ||
      !dataset.length
    ) {
      return;
    }

    const timer = setInterval(() => {

      setIndex(prev => {

        const next =
          prev >= dataset.length - 1
            ? 0
            : prev + 1;

        loadDatasetRow(next);

        return next;

      });

    }, PLAY_MS);

    return () =>
      clearInterval(timer);

  }, [
    playing,
    mode,
    dataset.length
  ]);


  /* =========================
     SENSOR STATUS POLLING
     Uses the unified /api/state endpoint (single sync snapshot)
     instead of 3 separate calls per tick. The ESP32 connection
     status and actuator command state come from state.esp32.
  ========================= */

  const [esp32State, setEsp32State] = useState(null);
  const [actuatorCmd, setActuatorCmd] = useState(null);

  useEffect(() => {

    let cancelled = false;

    async function pollStatus() {
      try {
        const resp = await apiFetch(`${API}/state`, {}, 4000);
        if (!resp.ok || cancelled) return;
        const state = await resp.json();
        if (cancelled) return;
        if (state.sensorStatus) setSensorStatus(state.sensorStatus);
        if (state.sms) setSmsState(state.sms);
        if (state.esp32) {
          setEsp32State(state.esp32);
          setActuatorCmd(state.esp32.command);
        }
        if (state.camera) {
          // /api/state returns camera: cameraState.latest — the raw
          // observation object, which has no `available` field (and there
          // is no top-level state.cameraStatus). Only the /api/vision/latest
          // endpoint uses { available:false } as its "no data" placeholder,
          // so match on `=== false` to avoid nulling out real observations.
          if (state.camera.available === false) {
            setCameraResult(null);
            lastSnapshotRef.current = { time: 0, snapshot: null, frameTimestamp: null };
          } else {
            const now = Date.now();
            const prev = lastSnapshotRef.current;
            let snapshot = prev.snapshot;
            let frameTimestamp = prev.frameTimestamp;
            const dueForSwap = !prev.snapshot || (now - prev.time >= SNAPSHOT_DISPLAY_INTERVAL_MS);
            if (state.camera.snapshot && dueForSwap) {
              snapshot = state.camera.snapshot;
              frameTimestamp = state.camera.frameTimestamp || state.camera.timestamp || null;
              lastSnapshotRef.current = { time: now, snapshot, frameTimestamp };
            }
            const ageMs = frameTimestamp
              ? now - new Date(frameTimestamp).getTime()
              : state.camera.ageMs;
            setCameraResult({ ...state.camera, snapshot, ageMs });
          }
        }
        setBackendConnected(true);
      } catch {
        if (!cancelled) {
          setBackendConnected(false);
        }
      }
    }

    pollStatus();
    const t = setInterval(pollStatus, 2000);

    return () => {
      cancelled = true;
      clearInterval(t);
    };

  }, []);


  /* =========================
     LIVE ESP32 POLLING
     While the Live view is open, pull real incoming vibration
     samples from the backend's /api/live/history buffer (fed by
     the ESP32's POST /api/live) instead of waiting on a manual
     trigger. This is what actually makes the Live screen live.
  ========================= */

  useEffect(() => {

    // The Dashboard is the primary live screen now, not just the
    // dedicated Live page — both need this poll running, otherwise the
    // Dashboard's vibration trend just sits on stale data.
    if (mode !== "live" && mode !== "dashboard") return;

    let cancelled = false;
    const ROLLING_WINDOW = 40;

    // Rolling/incremental strategy: fetch the full buffer once, then on
    // every later poll only ask for samples newer than the last one we
    // already have (?since=...) and append+trim locally instead of
    // re-downloading and re-rendering the entire history each tick.
    async function pollLiveHistory() {
      try {
        const since = lastVibTimeRef.current;
        const url = since
          ? `${API}/live/history?since=${encodeURIComponent(since)}`
          : `${API}/live/history`;
        const r = await apiFetch(url, {}, 4000);
        if (!r.ok || cancelled) return;

        const rows = await r.json();
        if (!rows.length) return;

        lastVibTimeRef.current = rows[rows.length - 1].time;

        setHistory(prev => {
          const appended = since
            ? [
                ...prev,
                ...rows.map(row => ({
                  t: new Date(row.time).toLocaleTimeString(),
                  vibration: row.vibration
                }))
              ]
            : rows.map(row => ({
                t: new Date(row.time).toLocaleTimeString(),
                vibration: row.vibration
              }));
          return appended.slice(-ROLLING_WINDOW);
        });

        const last = rows[rows.length - 1];
        setCurrent({
          vibration: last.vibration,
          fault: "LIVE",
          index: "-",
          analysis: last.analysis || null
        });

      } catch {}
    }

    pollLiveHistory();
    const t = setInterval(pollLiveHistory, 1500);

    return () => {
      cancelled = true;
      clearInterval(t);
    };

  }, [mode]);


  /* =========================
     LIVE ESP32 CONNECTION STATUS
     Derives the Live view's connection badge from the unified
     /api/state esp32 status (heartbeat freshness), falling back
     to the vibration freshness check.
  ========================= */

  useEffect(() => {

    if (!backendConnected) {
      setEspStatus("BACKEND DISCONNECTED");
      return;
    }

    if (esp32State?.connectionStatus === "CONNECTED") {
      setEspStatus("LIVE");
    } else if (sensorStatus?.vibrationLive) {
      setEspStatus("LIVE");
    } else if (sensorStatus?.vibrationAvailable || esp32State?.lastVibrationAt) {
      setEspStatus("STALE");
    } else {
      setEspStatus("OFFLINE");
    }

  }, [mode, sensorStatus, esp32State, backendConnected]);


  /* =========================
     LOAD DATASET RECORD
  ========================= */

  async function loadDatasetRow(
    i,
    rows = dataset
  ) {

    const row = rows[i];

    if (!row) return;

    try {

      const r = await apiFetch(
        `${API}/analyze`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            vibration: row.vibration,
            source: "CSV dataset",
            context: "DATASET"
          })
        },
        6000
      );

      const analysis =
        await r.json();

      setCurrent({
        ...row,
        analysis
      });

      setHistory(prev =>
        [
          ...prev,
          {
            t:
              new Date()
                .toLocaleTimeString(),
            vibration:
              row.vibration
          }
        ].slice(-40)
      );

      if (
        analysis.condition ===
          "WARNING" ||
        analysis.condition ===
          "CRITICAL"
      ) {
        refreshAlerts();
      }

    } catch (error) {
      console.error(error);
    }

    // Multi-sensor record for the SAME index — Dataset Mode always moves
    // every sensor together, so this rides along with the existing
    // vibration analyze() call above rather than keeping its own index.
    try {

      const sr = await apiFetch(
        `${API}/dataset/record/${i}`,
        {},
        6000
      );

      if (sr.ok) {
        const record = await sr.json();
        setDatasetRecord(record);

        setDatasetSensorHistory(prev =>
          [
            ...prev,
            {
              sample: i + 1,
              temperature: record.temperature,
              speed: record.speed,
              vibration: record.vibration,
              load: record.load,
              current: record.current
            }
          ].slice(-40)
        );
      }

    } catch (error) {
      console.error(error);
    }
  }


  /* =========================
     ALERTS
  ========================= */

  async function refreshAlerts() {

    try {

      const r =
        await apiFetch(`${API}/alerts`, {}, 4000);

      if (r.ok) {
        setAlerts(await r.json());
      }

    } catch {}
  }


  async function clearAlerts() {

    await apiFetch(
      `${API}/alerts`,
      {
        method: "DELETE"
      },
      4000
    );

    setAlerts([]);

  }


  /* =========================
     SOFTWARE TEST MODE
     Uses /api/analyze with context: "TEST" — deliberately NOT the
     /api/live ESP32 endpoint — so a test run never becomes a real
     live sample, never touches liveHistory, and never raises a real
     live alert (see maybeRecordAlert isolation on the backend).
  ========================= */

  async function startLiveSimulation() {

    setMode("test");
    setPlaying(false);

    const row =
      dataset[
        Math.floor(
          Math.random() *
            dataset.length
        )
      ];

    if (!row) return;

    try {

      const r = await apiFetch(
        `${API}/analyze`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            vibration: row.vibration,
            source: "Software test source",
            context: "TEST"
          })
        },
        6000
      );

      const analysis = await r.json();

      setCurrent({
        vibration: row.vibration,
        fault: "TEST",
        index: "-",
        analysis
      });

      setEspStatus("TEST MODE");

      // Append this same test-run vibration value to the Test Mode
      // graph's own buffer — same source as the KPI above, so the
      // numeric value and the graph can never drift apart. The id
      // guards against a duplicate point if this ever fires twice for
      // the same click (e.g. a React re-render), and the rolling
      // window keeps the graph readable.
      testSampleIdRef.current += 1;
      const sampleId = testSampleIdRef.current;
      setTestHistory(prev => {
        if (prev.length && prev[prev.length - 1].id === sampleId) {
          return prev;
        }
        return [
          ...prev,
          {
            id: sampleId,
            t: new Date().toLocaleTimeString(),
            vibration: row.vibration
          }
        ].slice(-40);
      });

    } catch (error) {
      console.error(error);
    }

  }


  /* =========================
     LIVE ESP32 PROCESSING
  ========================= */

  async function processLive(
    vibration,
    source = "ESP32 + MPU6050"
  ) {

    try {

      const r =
        await apiFetch(
          `${API}/live`,
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json"
            },
            body: JSON.stringify({
              vibration
            })
          },
          5000
        );

      const payload =
        await r.json();

      if (!r.ok) return;

      setCurrent({
        vibration:
          payload.vibration,

        fault: "LIVE",

        index: "-",

        analysis:
          payload.analysis
      });

      setHistory(prev =>
        [
          ...prev,
          {
            t:
              new Date()
                .toLocaleTimeString(),
            vibration:
              payload.vibration
          }
        ].slice(-40)
      );

      setEspStatus(
        source ===
          "ESP32 + MPU6050"
          ? "ONLINE"
          : "TEST"
      );

      refreshAlerts();

    } catch {

      setEspStatus(
        "BACKEND OFFLINE"
      );

    }

  }


  /* =========================
     BASELINE
  ========================= */

  async function resetBaseline() {

    await apiFetch(
      `${API}/baseline/reset`,
      {
        method: "POST"
      },
      4000
    );

    const r =
      await apiFetch(
        `${API}/baseline`,
        {},
        4000
      );

    setBaseline(
      await r.json()
    );

  }


  async function sendTestSms() {
    setSmsSending(true);
    try {
      const r = await apiFetch(`${API}/alerts/test-sms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true })
      }, 8000);
      const result = await r.json();
      setSmsState(result);
    } catch (err) {
      setSmsState({ status: "FAILED", error: err.message });
    } finally {
      setSmsSending(false);
    }
  }


  /* =========================
     CALCULATIONS
  ========================= */

  const avg = useMemo(
    () =>
      history.length
        ? history.reduce(
            (s, x) =>
              s + x.vibration,
            0
          ) / history.length
        : null,
    [history]
  );


  const peak = useMemo(
    () =>
      history.length
        ? Math.max(
            ...history.map(
              x => x.vibration
            )
          )
        : null,
    [history]
  );


  const status =
    current?.analysis?.condition ||
    "WAITING";


  const progress =
    dataset.length
      ? ((index + 1) /
          dataset.length) *
        100
      : 0;


  // Health score is derived from the backend's fused final risk, never
  // hard-coded per-status numbers. If there is no valid live evidence yet
  // (finalRisk == null, e.g. WAITING) we show "--" rather than inventing one.
  const finalRisk = current?.analysis?.fusion?.finalRisk;
  const healthScore =
    finalRisk == null
      ? null
      : Math.round(Math.max(0, Math.min(100, 100 - finalRisk)));


  const chartData =
    history.map(
      (item, i) => ({
        sample: i + 1,
        vibration:
          item.vibration
      })
    );


  // Test Mode's chart data — derived ONLY from testHistory (never the
  // shared Live `history`) so the graph always tracks the same
  // sequence of simulated values shown in the Test Vibration KPI.
  const testChartData = useMemo(
    () =>
      testHistory.map((item, i) => ({
        sample: i + 1,
        vibration: item.vibration
      })),
    [testHistory]
  );


  /* =========================
     NAVIGATION
  ========================= */

  function navigate(target) {

    setMode(target);
    setSidebarOpen(false);

    // The camera is a separate background subsystem — a Python +
    // OpenCV process capturing the laptop's built-in webcam — so
    // navigating between dashboard pages never starts/stops it.

  }


  return (

    <div className="app">


      {/* =========================
          MOBILE OVERLAY
      ========================= */}

      {sidebarOpen && (
        <div
          className="sidebarOverlay"
          onClick={() =>
            setSidebarOpen(false)
          }
        />
      )}


      {/* =========================
          SIDEBAR
      ========================= */}

      <aside
        className={
          `sidebar ${
            sidebarOpen
              ? "sidebar-open"
              : ""
          }`
        }
      >

        <div className="brand">

          <div className="brand-logo">
            <ShieldCheck />
          </div>

          <div>
            <h2>BELTGUARD</h2>
            <span>AI MONITORING</span>
          </div>

        </div>


        <div className="nav-label">
          MONITORING
        </div>


        <NavItem
          icon={<LayoutDashboard />}
          text="Dashboard"
          active={
            mode === "dashboard"
          }
          onClick={() =>
            navigate("dashboard")
          }
        />


        <NavItem
          icon={<Activity />}
          text="Live Mode"
          active={
            mode === "live"
          }
          onClick={() =>
            navigate("live")
          }
          live
        />


        <NavItem
          icon={<Database />}
          text="Dataset Mode"
          active={
            mode === "dataset"
          }
          onClick={() =>
            navigate("dataset")
          }
        />


        <NavItem
          icon={<Zap />}
          text="Test Mode"
          active={
            mode === "test"
          }
          onClick={() =>
            navigate("test")
          }
        />


        <div className="nav-label">
          ANALYSIS
        </div>


        <NavItem
          icon={<BarChart3 />}
          text="Fault Analysis"
          active={
            mode === "analysis"
          }
          onClick={() =>
            navigate("analysis")
          }
        />


        <NavItem
          icon={<Bell />}
          text="Alert History"
          active={
            mode === "alerts"
          }
          badge={
            alerts.length
          }
          onClick={() =>
            navigate("alerts")
          }
        />


        <NavItem
          icon={<History />}
          text="Data History"
          active={
            mode === "history"
          }
          onClick={() =>
            navigate("history")
          }
        />


        <div className="nav-label">
          TOOLS
        </div>


        <NavItem
          icon={<Settings />}
          text="System"
          active={
            mode === "system"
          }
          onClick={() =>
            navigate("system")
          }
        />


        {/* SIDEBAR STATUS */}

        <div className="sidebar-bottom">

          <div className="connection-box">

            <div
              className={
                espStatus ===
                "ONLINE" || espStatus === "LIVE"
                  ? "connection-icon online"
                  : "connection-icon"
              }
            >

              {(espStatus ===
              "ONLINE" || espStatus === "LIVE")
                ? <Wifi />
                : <WifiOff />}

            </div>

            <div>

              <strong>
                {espStatus}
              </strong>

              <span>
                {(espStatus ===
                "ONLINE" || espStatus === "LIVE")
                  ? "ESP32 connected"
                  : espStatus === "BACKEND DISCONNECTED"
                  ? "Backend unavailable"
                  : "Awaiting device"}
              </span>

            </div>

          </div>


          <div className="version">
            SIH26008 • v1.0
          </div>

        </div>

      </aside>


      {/* =========================
          MAIN
      ========================= */}

      <main className="main">


        {/* TOPBAR */}

        <header className="topbar">

          <button
            className="mobile-menu"
            onClick={() =>
              setSidebarOpen(
                !sidebarOpen
              )
            }
          >
            <Menu />
          </button>


          <div className="page-heading">

            <span>
              SMART INDIA HACKATHON 2026
            </span>

            <h1>
              Conveyor Health Center
            </h1>

          </div>


          <div className="top-actions">

            <div className="top-status">

              <span
                className={
                  backendConnected === true
                    ? "status-dot green"
                    : "status-dot"
                }
              />

              {backendConnected === true
                ? "BACKEND CONNECTED"
                : backendConnected === false
                ? "BACKEND DISCONNECTED"
                : "CONNECTING…"}

            </div>


            <div className="top-divider" />


            <div className="top-time">

              <strong>
                {new Date()
                  .toLocaleTimeString()}
              </strong>

              <span>
                SYSTEM TIME
              </span>

            </div>

          </div>

        </header>


        {/* =========================
            CONTENT
        ========================= */}

        <div className="content">


          {/* =========================
              DASHBOARD
          ========================= */}

          {mode === "dashboard" && (

            <DashboardView
              current={current}
              status={status}
              avg={avg}
              peak={peak}
              healthScore={healthScore}
              history={history}
              chartData={chartData}
              alerts={alerts}
              navigate={navigate}
              startLiveSimulation={
                startLiveSimulation
              }
              cameraResult={cameraResult}
              sensorStatus={sensorStatus}
              backendConnected={backendConnected}
              esp32State={esp32State}
              actuatorCmd={actuatorCmd}
              criticalDemo={criticalDemo}
              triggerCriticalDemo={triggerCriticalDemo}
            />

          )}


          {/* =========================
              DATASET MODE
          ========================= */}

          {mode === "dataset" && (

            <DatasetView
              current={current}
              status={status}
              dataset={dataset}
              info={info}
              index={index}
              progress={progress}
              playing={playing}
              setPlaying={
                setPlaying
              }
              loadDatasetRow={
                loadDatasetRow
              }
              setIndex={setIndex}
              resetBaseline={
                resetBaseline
              }
              baseline={baseline}
              history={history}
              chartData={chartData}
              datasetRecord={datasetRecord}
              datasetStats={datasetStats}
              datasetSensorHistory={datasetSensorHistory}
            />

          )}


          {/* =========================
              LIVE MODE
          ========================= */}

          {mode === "live" && (

            <LiveView
              current={current}
              status={status}
              history={history}
              chartData={chartData}
              espStatus={espStatus}
              processLive={
                processLive
              }
              cameraResult={cameraResult}
              sensorStatus={sensorStatus}
            />

          )}


          {/* =========================
              TEST MODE
          ========================= */}

          {mode === "test" && (

            <TestView
              current={current}
              status={status}
              startLiveSimulation={
                startLiveSimulation
              }
              history={testHistory}
              chartData={testChartData}
            />

          )}


          {/* =========================
              ANALYSIS
          ========================= */}

          {mode === "analysis" && (

            <AnalysisView
              current={current}
              status={status}
              baseline={baseline}
            />

          )}


          {/* =========================
              ALERTS
          ========================= */}

          {mode === "alerts" && (

            <AlertsView
              alerts={alerts}
              clearAlerts={
                clearAlerts
              }
            />

          )}


          {/* =========================
              HISTORY
          ========================= */}

          {mode === "history" && (

            <HistoryView
              history={history}
            />

          )}


          {/* =========================
              SYSTEM
          ========================= */}

          {mode === "system" && (

            <SystemView
              info={info}
              baseline={baseline}
              resetBaseline={
                resetBaseline
              }
              sensorStatus={sensorStatus}
              smsState={smsState}
              smsSending={smsSending}
              sendTestSms={sendTestSms}
            />

          )}

        </div>

      </main>

    </div>

  );
}


/* =====================================================
   NAV ITEM
===================================================== */

function NavItem({
  icon,
  text,
  active,
  onClick,
  badge,
  live
}) {

  return (

    <button
      className={
        `nav-item ${
          active
            ? "active"
            : ""
        }`
      }
      onClick={onClick}
    >

      <span className="nav-icon">
        {icon}
      </span>

      <span className="nav-text">
        {text}
      </span>

      {live && (
        <span className="live-mini">
          LIVE
        </span>
      )}

      {badge > 0 && (
        <span className="nav-badge">
          {badge}
        </span>
      )}

      {active && (
        <ChevronRight
          className="nav-arrow"
        />
      )}

    </button>

  );
}


/* =====================================================
   IP WEBCAM (PHONE) LIVE STREAM
   Plays the IP Webcam app's MJPEG URL directly in the browser.
   Configure VITE_PHONE_CAM_URL in frontend/.env, e.g.
     VITE_PHONE_CAM_URL=http://192.168.43.201:8080/video
   (or /shot.jpg for a still capture — reconnect keeps latency bounded).

   A single long-lived <img> MJPEG connection accumulates buffered frames
   any time the phone can't push frames out as fast as it encodes them,
   so the latency keeps growing. Instead we re-point the <img> src on a
   short timer (~1.2s) with a cache-buster, so each fetch only ever shows
   what the phone is streaming *right now*.
==================================================== */

const IP_WEBCAM_REFRESH_MS = 1200;

function IpWebcamLive({ label = "PHONE CAMERA (IP WEBCAM)" }) {
  const imgRef = useRef(null);
  const [streamError, setStreamError] = useState(false);

  const url = (import.meta.env && import.meta.env.VITE_PHONE_CAM_URL) || "";

  const buildUrl = useCallback((refresh) => {
    if (!url) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}t=${refresh}`;
  }, [url]);

  useEffect(() => {
    if (!url) return;
    setStreamError(false);

    // Kick the stream periodically so latency stays bounded. Also
    // recovers automatically if the phone drops the stream.
    let timer = null;

    const reconnect = () => {
      if (imgRef.current) {
        imgRef.current.src = buildUrl(Date.now());
      }
    };

    timer = setInterval(reconnect, IP_WEBCAM_REFRESH_MS);

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [url, buildUrl]);

  if (!url) {
    return (
      <div className="live-stream-frame phone-stream-frame">
        <div className="live-stream-placeholder">
          <Camera />
          <span>
            PHONE CAMERA NOT CONFIGURED — set VITE_PHONE_CAM_URL in
            frontend/.env to your IP Webcam MJPEG URL.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="live-stream-frame phone-stream-frame">
      <img
        ref={imgRef}
        src={buildUrl(Date.now())}
        alt="IP Webcam live feed"
        className="live-stream-video ip-webcam-img"
        onLoad={() => setStreamError(false)}
        onError={() => setStreamError(true)}
      />
      {streamError && (
        <div className="live-stream-placeholder">
          <WifiOff />
          <span>
            CAMERA ERROR — cannot reach the IP Webcam stream at {url}.
            Is the IP Webcam app running on your phone (same network)?
          </span>
        </div>
      )}
      <div className="live-stream-overlay">
        <span className={`live-stream-dot ${streamError ? "is-camera-error" : "is-live"}`}>
          {streamError ? "CAMERA ERROR" : "LIVE — PHONE CAMERA"}
        </span>
      </div>
    </div>
  );
}


function DashboardView({
  current,
  status,
  avg,
  peak,
  healthScore,
  history,
  chartData,
  alerts,
  navigate,
  startLiveSimulation,
  cameraResult,
  sensorStatus,
  backendConnected,
  esp32State,
  actuatorCmd,
  criticalDemo,
  triggerCriticalDemo
}) {

  const fusion = current?.analysis?.fusion;
  const cam = cameraResult || current?.analysis?.camera;
  const camStatus = sensorStatus?.cameraStatus || cam?.cameraStatus || "WAITING";
  const camLive = camStatus === "CONNECTED";

  return (

    <>

      {backendConnected === false && (
        <div className="disconnected-banner">
          <WifiOff />
          <div>
            <strong>Backend Disconnected</strong>
            <span>The dashboard is running, but cannot reach the backend server. Live data, conditions, and ESP32 control are unavailable until the backend is reachable.</span>
          </div>
        </div>
      )}

      <div className="welcome-row">

        <div>

          <div className="section-kicker">
            SYSTEM OVERVIEW
          </div>

          <h2>
            Conveyor Control Dashboard
          </h2>

          <p>
            Real-time vibration monitoring
            and predictive maintenance.
          </p>

        </div>


        <div className="quick-actions">

          <button
            className="btn secondary"
            onClick={() =>
              navigate("dataset")
            }
          >
            <Database />
            Dataset
          </button>

          <button
            className="btn primary"
            onClick={
              startLiveSimulation
            }
          >
            <Play />
            Run Test
          </button>

          <button
            className="btn danger demo-btn"
            onClick={triggerCriticalDemo}
            disabled={criticalDemo}
            title="Inject a real 2.6 m/s² critical spike through the live pipeline"
          >
            <AlertTriangle />
            CRIT Test
          </button>

        </div>

      </div>


      {/* KPI ROW */}

      <div className="kpi-grid">

        <Kpi
          icon={<Activity />}
          title="Current Vibration"
          value={
            fmt(
              current?.vibration,
              3
            )
          }
          unit="m/s²"
          color="blue"
        />

        <Kpi
          icon={<BarChart3 />}
          title="Window Average"
          value={
            fmt(avg, 3)
          }
          unit="m/s²"
          color="green"
        />

        <Kpi
          icon={<Zap />}
          title="Peak Vibration"
          value={
            fmt(peak, 3)
          }
          unit="m/s²"
          color="orange"
        />

        <Kpi
          icon={<ShieldCheck />}
          title="Health Score"
          value={
            healthScore != null
              ? `${healthScore}`
              : "--"
          }
          unit="%"
          color="purple"
        />

      </div>


      {/* SYSTEM CONNECTION STATUS */}
      <div className="connection-status-strip">
        <div className="conn-chip">
          <span className={`conn-dot ${backendConnected === true ? "green" : "red"}`} />
          <strong>Backend</strong>
          <em>{backendConnected === true ? "CONNECTED" : backendConnected === false ? "DISCONNECTED" : "CHECKING"}</em>
        </div>
        <div className="conn-chip">
          <span className={`conn-dot ${esp32State?.connectionStatus === "CONNECTED" ? "green" : "red"}`} />
          <strong>ESP32</strong>
          <em>{esp32State?.connectionStatus === "CONNECTED" ? "CONNECTED" : "DISCONNECTED"}</em>
        </div>
        <div className="conn-chip">
          <span className={`conn-dot ${sensorStatus?.cameraStatus === "CONNECTED" ? "green" : "red"}`} />
          <strong>Camera Analysis</strong>
          <em>{sensorStatus?.cameraStatus || "WAITING"}</em>
        </div>
        <div className="conn-chip">
          <span className={`conn-dot ${actuatorCmd?.status === "CRITICAL" ? "red" : actuatorCmd?.status === "WARNING" ? "amber" : "green"}`} />
          <strong>Actuators</strong>
          <em>Buzzer {actuatorCmd?.buzzer ? "ON" : "OFF"} · Red {actuatorCmd?.redLed ? (actuatorCmd?.status === "CRITICAL" ? "BLINK" : "ON") : "OFF"} · Green {actuatorCmd?.greenLed ? "ON" : "OFF"}</em>
        </div>
        <div className="conn-chip">
          <span className={`conn-dot ${actuatorCmd?.status === "CRITICAL" ? "red" : actuatorCmd?.status === "WARNING" ? "amber" : "green"}`} />
          <strong>System</strong>
          <em>{actuatorCmd?.status || status || "WAITING"}</em>
        </div>
        <div className="conn-chip">
          <span className="conn-dot blue" />
          <strong>Vibration</strong>
          <em>{fmt(current?.vibration, 3)} m/s²</em>
        </div>
      </div>

      {/* MAIN VISUAL GRID */}

      <div className="dashboard-grid">


        {/* CONDITION */}

        <section className="panel condition-panel">

          <PanelHeader
            icon={<ShieldCheck />}
            title="Overall Condition"
            subtitle="EARLY-WARNING ENGINE"
          />


          <div className="condition-display">

            <div
              className={
                `condition-orbit ${
                  badgeClass(status)
                }`
              }
            >

              <div className="orbit-inner">

                <ShieldCheck />

                <strong>
                  {status}
                </strong>

                <span>
                  SYSTEM STATE
                </span>

              </div>

            </div>

          </div>


          <div className="condition-message">

            {current?.analysis
              ?.recommendation ||
              "Start Dataset Mode or Live Mode to begin monitoring."}

          </div>


          <div className="process-flow">

            <Flow
              icon={<Activity />}
              text="SENSE"
            />

            <span>→</span>

            <Flow
              icon={<Cpu />}
              text="ANALYZE"
            />

            <span>→</span>

            <Flow
              icon={<Eye />}
              text="EXPLAIN"
            />

            <span>→</span>

            <Flow
              icon={<Wrench />}
              text="ACT"
            />

          </div>

        </section>


        {/* GRAPH */}

        <section className="panel graph-panel">

          <PanelHeader
            icon={<Activity />}
            title="Vibration Trend"
            subtitle="LAST 40 SAMPLES"
            right={
              <span className="live-label">
                ● LIVE
              </span>
            }
          />


          <div className="large-chart">

            <ResponsiveContainer
              width="100%"
              height="100%"
            >

              <AreaChart
                data={chartData}
              >

                <defs>

                  <linearGradient
                    id="blueArea"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >

                    <stop
                      offset="0%"
                      stopOpacity={0.35}
                    />

                    <stop
                      offset="100%"
                      stopOpacity={0.01}
                    />

                  </linearGradient>

                </defs>


                <CartesianGrid
                  strokeDasharray="3 3"
                  opacity={0.08}
                />


                <XAxis
                  dataKey="sample"
                  tick={{
                    fontSize: 10
                  }}
                />


                <YAxis
                  domain={[
                    "dataMin - 0.05",
                    "dataMax + 0.05"
                  ]}
                  tick={{
                    fontSize: 10
                  }}
                />


                <Tooltip
                  contentStyle={{
                    background:
                      "#081525",
                    border:
                      "1px solid #203b59",
                    borderRadius:
                      "8px"
                  }}
                />


                <Area
                  type="monotone"
                  dataKey="vibration"
                  strokeWidth={2.5}
                  fill="url(#blueArea)"
                  isAnimationActive={false}
                />

              </AreaChart>

            </ResponsiveContainer>

          </div>


          <div className="chart-footer">

            <MiniStat
              title="MIN"
              value={
                history.length
                  ? fmt(
                      Math.min(
                        ...history.map(
                          x =>
                            x.vibration
                        )
                      ),
                      3
                    )
                  : "--"
              }
            />

            <MiniStat
              title="AVG"
              value={
                fmt(avg, 3)
              }
            />

            <MiniStat
              title="PEAK"
              value={
                fmt(peak, 3)
              }
            />

            <MiniStat
              title="SAMPLES"
              value={
                history.length
              }
            />

          </div>

        </section>


        {/* CONVEYOR VISUAL */}

        <section className="panel conveyor-panel">

          <PanelHeader
            icon={<Settings />}
            title="Conveyor Overview"
            subtitle="PROTOTYPE MODEL"
          />


          <div className="conveyor-scene">

            <div className="conveyor-belt">

              <div className="belt-texture" />

              <div className="roller left">
                <CircleDot />
              </div>

              <div className="roller center">
                <CircleDot />
              </div>

              <div className="roller right">
                <CircleDot />
              </div>

            </div>


            <div className="motor-box">

              <Zap />

              <span>
                MOTOR
              </span>

            </div>


            <SensorTag
              className="sensor-one"
              text="MPU6050"
            />

            <SensorTag
              className="sensor-two"
              text="BELT"
            />

            <SensorTag
              className="sensor-three"
              text="PULLEY"
            />

          </div>


          <div className="conveyor-status">

            <StatusItem
              label="Vibration"
              value="ACTIVE"
              ok
            />

            <StatusItem
              label="Camera"
              value={
                sensorStatus
                  ? sensorStatus.cameraStatus || (sensorStatus.cameraAvailable ? "LIVE" : "OFFLINE")
                  : "WAITING"
              }
              ok={sensorStatus?.cameraAvailable}
            />

            <StatusItem
              label="Temperature"
              value="FUTURE"
            />

          </div>

        </section>


        {/* AI ANALYSIS */}

        <section className="panel analysis-panel">

          <PanelHeader
            icon={<BarChart3 />}
            title="AI / Anomaly Analysis"
            subtitle="EXPLAINABLE"
          />


          <div className="score-box">

            <div className="score-circle">

              <strong>
                {fmt(
                  current?.analysis
                    ?.anomalyScore,
                  2
                )}
              </strong>

              <span>
                SCORE
              </span>

            </div>


            <div>

              <span className="small-label">
                CURRENT ASSESSMENT
              </span>

              <h3
                className={
                  `status-${badgeClass(
                    status
                  )}`
                }
              >
                {status}
              </h3>

              <p>
                {current?.analysis
                  ?.note ||
                  "No analysis available yet."}
              </p>

            </div>

          </div>


          <div className="evidence-list">

            <Evidence
              label="Baseline mean"
              value={
                current?.analysis
                  ?.baselineMean != null
                  ? `${fmt(
                      current.analysis
                        .baselineMean,
                      3
                    )} m/s²`
                  : "--"
              }
            />

            <Evidence
              label="Baseline deviation"
              value={
                current?.analysis
                  ?.baselineStd != null
                  ? `${fmt(
                      current.analysis
                        .baselineStd,
                      3
                    )} m/s²`
                  : "--"
              }
            />

            <Evidence
              label="Fault association"
              value={
                current?.analysis
                  ?.mlFaultAssociation ||
                "—"
              }
            />

            <Evidence
              label="Model confidence"
              value={
                current?.analysis
                  ?.mlConfidence != null
                  ? `${Math.round(
                      current.analysis
                        .mlConfidence *
                        100
                    )}%`
                  : "—"
              }
            />

          </div>

        </section>


        {/* CAMERA ANALYSIS */}

        <section className="panel camera-analysis-panel">

          <PanelHeader
            icon={<Camera />}
            title="Camera Analysis"
            subtitle="PHONE CAMERA + OPENCV"
            right={
              <span
                className={
                  `live-label ${camLive ? "" : "text-dim"}`
                }
              >
                {`● ${camStatus}`}
              </span>
            }
          />

          {/* LIVE PHONE CAMERA — external IP Webcam (MJPEG) feed,
              with the belt analysis evidence from camera_service below. */}
          <IpWebcamLive />

          {cam ? (

            <div className="camera-inspection-card">

            <div className="evidence-list">

              <Evidence
                label="Belt detected"
                value={cam.beltDetected ? "YES" : "NO"}
              />

              <Evidence
                label="Belt position"
                value={cam.beltPosition || "UNKNOWN"}
              />

              <Evidence
                label="Movement"
                value={cam.motionState || "UNKNOWN"}
              />

              <Evidence
                label="Direction"
                value={cam.direction || "UNKNOWN"}
              />

              <Evidence
                label="Tracking deviation"
                value={
                  cam.trackingDeviation != null
                    ? `${Math.round(cam.trackingDeviation * 100)}%`
                    : "--"
                }
              />

              <Evidence
                label="Joint/visual condition"
                value={cam.jointStatus || "UNKNOWN"}
              />

              <Evidence
                label="Visual severity"
                value={cam.visualSeverity || "NONE"}
              />

              <Evidence
                label="Camera confidence"
                value={
                  cam.visualConfidence != null
                    ? `${Math.round(cam.visualConfidence * 100)}%`
                    : "--"
                }
              />

              <Evidence
                label="Frame age"
                value={cam.ageMs != null ? `${Math.round(cam.ageMs / 100) / 10}s` : "--"}
              />

            </div>

            </div>

          ) : (

            <div className="empty-state">
              <Camera />
              <span>
                No camera data yet. Start camera_service.py on the laptop
                to begin capturing from the laptop's webcam.
              </span>
            </div>

          )}

        </section>


        {/* FINAL FUSED PREDICTION */}

        <section className="panel fusion-panel">

          <PanelHeader
            icon={<ShieldCheck />}
            title="Final Prediction"
            subtitle="FUSED VIBRATION + CAMERA"
          />

          <div className="score-box">

            <div className="score-circle">

              <strong>
                {fusion?.finalRisk != null
                  ? Math.round(fusion.finalRisk)
                  : "--"}
              </strong>

              <span>
                RISK
              </span>

            </div>

            <div>

              <span className="small-label">
                OVERALL BELT HEALTH
              </span>

              <h3
                className={
                  `status-${badgeClass(
                    fusion?.finalCondition || "waiting"
                  )}`
                }
              >
                {fusion?.finalCondition || "WAITING"}
              </h3>

              <p>
                {fusion?.note ||
                  "Fusion begins once vibration and/or camera data is available."}
              </p>

            </div>

          </div>

          <div className="status-item">
            <span>Mode</span>
            <strong>
              {fusion?.degradedMode ? "DEGRADED (single sensor)" : "FUSED (both sensors)"}
            </strong>
          </div>

          {fusion?.evidence?.length > 0 && (
            <div className="evidence-reason-block">
              <span className="small-label">EVIDENCE / REASON</span>
              <ul className="evidence-reason-list">
                {fusion.evidence.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          {fusion?.recommendation && (
            <div className="maintenance-action-block">
              <span className="small-label">MAINTENANCE ACTION</span>
              <p>{fusion.recommendation}</p>
            </div>
          )}

        </section>


        {/* ALERTS */}

        <section className="panel alerts-panel">

          <PanelHeader
            icon={<Bell />}
            title="Recent Alerts"
            subtitle={`${alerts.length} EVENTS`}
            right={
              <button
                className="text-button"
                onClick={() =>
                  navigate("alerts")
                }
              >
                VIEW ALL
              </button>
            }
          />


          <div className="dashboard-alerts">

            {alerts.length === 0 ? (

              <div className="empty-state">

                <CheckCircle2 />

                <span>
                  No warning events yet
                </span>

              </div>

            ) : (

              alerts
                .slice(0, 5)
                .map(alert => (

                  <AlertRow
                    key={alert.id}
                    alert={alert}
                  />

                ))

            )}

          </div>

        </section>


        {/* MAINTENANCE */}

        <section className="panel maintenance-panel">

          <PanelHeader
            icon={<Wrench />}
            title="Maintenance Workflow"
            subtitle="PREDICTIVE PATH"
          />


          <WorkflowStep
            number="01"
            title="Monitor"
            text="Collect vibration behaviour"
            done
          />

          <WorkflowStep
            number="02"
            title="Detect"
            text="Compare with baseline"
            done
          />

          <WorkflowStep
            number="03"
            title="Explain"
            text="Generate evidence"
            done
          />

          <WorkflowStep
            number="04"
            title="Inspect"
            text="Recommend inspection"
          />

        </section>

      </div>


      {/* BOTTOM STRIP */}

      <div className="info-strip">

        <InfoItem
          icon={<Cpu />}
          title="Sensor"
          value="MPU6050"
        />

        <InfoItem
          icon={<Wifi />}
          title="Communication"
          value="ESP32 / Wi-Fi"
        />

        <InfoItem
          icon={<Database />}
          title="Dataset"
          value="1,209 Records"
        />

        <InfoItem
          icon={<ShieldCheck />}
          title="Architecture"
          value="Hybrid AI"
        />

        <InfoItem
          icon={<Wrench />}
          title="Current Scope"
          value="Vibration + Camera"
        />

      </div>

    </>

  );

}


/* =====================================================
   DATASET VIEW
===================================================== */

const SENSOR_STATUS_COLOR = {
  NORMAL: "#3dd575",
  WARNING: "#e2ad39",
  CRITICAL: "#e4534c",
  UNKNOWN: "#536d85"
};

const LOAD_CATEGORY_COLOR = {
  Low: "#3dd575",
  Medium: "#23a7d5",
  High: "#e2ad39",
  Critical: "#e4534c"
};

function DatasetView({
  current,
  status,
  dataset,
  info,
  index,
  progress,
  playing,
  setPlaying,
  loadDatasetRow,
  setIndex,
  resetBaseline,
  baseline,
  history,
  chartData,
  datasetRecord,
  datasetStats,
  datasetSensorHistory
}) {

  const sensors = datasetRecord?.condition?.sensors;
  const loadCategory = datasetRecord?.condition?.loadCategory;
  const overallCondition = datasetRecord?.condition?.overallCondition;
  const formula = datasetStats?.conditionFormula;
  const sensorHistory = datasetSensorHistory || [];

  const [faultFilter, setFaultFilter] = React.useState("ALL");
  const faultOptions = ["ALL", ...(datasetStats?.faultNames || [])];
  const filteredSensorHistory = React.useMemo(() => {
    if (!datasetStats?.faultNames || faultFilter === "ALL") return sensorHistory;
    return sensorHistory.filter(r => (r.fault || "") === faultFilter);
  }, [sensorHistory, faultFilter, datasetStats]);

  return (

    <>

      <PageIntro
        kicker="DATASET ANALYSIS"
        title="CSV Dataset Mode"
        description="Replay and analyse the conveyor fault sensor records from the reference dataset."
      />

      {/* DATASET SUMMARY KPIs — computed from the real dataset */}
      <div className="kpi-grid five">
        <Kpi
          icon={<Database />}
          title="Total Records"
          value={datasetStats?.recordCount ?? dataset.length ?? "--"}
          unit="records"
          color="blue"
        />
        <Kpi
          icon={<Gauge />}
          title="Sensors"
          value={datasetStats?.sensorCount ?? "5"}
          unit="channels"
          color="green"
        />
        <Kpi
          icon={<CheckCircle2 />}
          title="Normal"
          value={datasetStats?.conditionDistribution?.find(c => c.condition === "NORMAL")?.count ?? "--"}
          unit="records"
          color="green"
        />
        <Kpi
          icon={<AlertTriangle />}
          title="Warning"
          value={datasetStats?.conditionDistribution?.find(c => c.condition === "WARNING")?.count ?? "--"}
          unit="records"
          color="orange"
        />
        <Kpi
          icon={<AlertTriangle />}
          title="Critical"
          value={datasetStats?.conditionDistribution?.find(c => c.condition === "CRITICAL")?.count ?? "--"}
          unit="records"
          color="purple"
        />
        <Kpi
          icon={<ShieldCheck />}
          title="Fault Types"
          value={datasetStats?.faultDistribution?.length ?? "--"}
          unit="classes"
          color="purple"
        />
      </div>

      {/* DATASET FILTERS */}
      <div className="dataset-filter-bar">
        <div className="dataset-filter-item">
          <label>Sensor / Fault Filter</label>
          <select
            value={faultFilter}
            onChange={e => setFaultFilter(e.target.value)}
          >
            {faultOptions.map(opt => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </div>
        <div className="dataset-filter-item filter-note">
          <span>Showing {faultFilter === "ALL" ? "all records" : `"${faultFilter}" records`} in sensor trend charts below.</span>
        </div>
      </div>


      <div className="two-column">

        <section className="panel">

          <PanelHeader
            icon={<Activity />}
            title="Vibration Playback"
            subtitle="LIVE GRAPH"
          />

          <div className="mode-chart">

            <ResponsiveContainer
              width="100%"
              height="100%"
            >

              <AreaChart
                data={chartData}
              >

                <CartesianGrid
                  strokeDasharray="3 3"
                  opacity={0.08}
                />

                <XAxis
                  dataKey="sample"
                />

                <YAxis
                  domain={[
                    "dataMin - 0.05",
                    "dataMax + 0.05"
                  ]}
                />

                <Tooltip />

                <Area
                  type="monotone"
                  dataKey="vibration"
                  fillOpacity={0.15}
                  isAnimationActive={false}
                />

              </AreaChart>

            </ResponsiveContainer>

          </div>

        </section>


        <section className="panel">

          <PanelHeader
            icon={<Database />}
            title="Playback Control"
            subtitle="DATA SOURCE"
          />


          <div className="record-big">

            <span>
              RECORD
            </span>

            <strong>
              {dataset.length
                ? index + 1
                : "--"}
            </strong>

            <small>
              OF {dataset.length}
            </small>

          </div>


          <div className="progress-bar">

            <div
              style={{
                width:
                  `${progress}%`
              }}
            />

          </div>


          <div className="progress-label">

            <span>
              {fmt(progress, 0)}%
            </span>

            <span>
              Dataset Progress
            </span>

          </div>


          <div className="control-buttons">

            <button
              className="btn primary"
              onClick={() => {

                setPlaying(
                  !playing
                );

                if (!playing) {
                  loadDatasetRow(
                    index
                  );
                }

              }}
            >

              {playing
                ? <Pause />
                : <Play />}

              {playing
                ? "Pause"
                : "Play Data"}

            </button>


            <button
              className="btn secondary"
              onClick={() => {

                const next =
                  index >=
                  dataset.length - 1
                    ? 0
                    : index + 1;

                setIndex(next);

                loadDatasetRow(
                  next
                );

              }}
            >

              NEXT

            </button>

          </div>


          <button
            className="reset-button"
            onClick={
              resetBaseline
            }
          >

            <RotateCcw />

            Reset Prototype Baseline

          </button>

          {baseline && (

            <div className="baseline-box">

              <span>
                CURRENT BASELINE
              </span>

              <strong>
                {fmt(
                  baseline.mean,
                  3
                )} m/s²
              </strong>

            </div>

          )}

        </section>

      </div>


      <div className="three-column">

        <DataCard
          title="Fault"
          value={
            current?.fault ||
            "--"
          }
        />

        <DataCard
          title="Vibration"
          value={
            current
              ? `${fmt(
                  current.vibration,
                  3
                )} m/s²`
              : "--"
          }
        />

        <DataCard
          title="Analysis"
          value={status}
        />

      </div>


      {/* =========================
          MULTI-SENSOR CARDS
          All five values come from the SAME selected record — the
          playback index above is the only index in Dataset Mode.
      ========================= */}

      <PageIntro
        kicker="MULTI-SENSOR"
        title="Sensor Breakdown — Current Record"
        description="Every value below belongs to the same CSV row selected in Playback Control."
      />

      <div className="kpi-grid three sensor-card-grid">

        <SensorCard
          icon={<Thermometer />}
          title="Temperature"
          value={fmt(datasetRecord?.temperature, 1)}
          unit="℃"
          avg={datasetStats?.averages?.temperature}
          avgUnit="℃"
          statusInfo={sensors?.temperature}
          stats={datasetStats?.sensorStats?.temperature}
        />

        <SensorCard
          icon={<Gauge />}
          title="Speed / IR Sensor"
          value={fmt(datasetRecord?.speed, 0)}
          unit="rpm"
          avg={datasetStats?.averages?.speed}
          avgUnit="rpm"
          statusInfo={sensors?.speed}
          stats={datasetStats?.sensorStats?.speed}
        />

        <SensorCard
          icon={<Activity />}
          title="Vibration"
          value={fmt(datasetRecord?.vibration, 3)}
          unit="m/s²"
          avg={datasetStats?.averages?.vibration}
          avgUnit="m/s²"
          statusInfo={sensors?.vibration}
          stats={datasetStats?.sensorStats?.vibration}
        />

        <SensorCard
          icon={<BarChart3 />}
          title="Load"
          value={fmt(datasetRecord?.load, 0)}
          unit="kg"
          avg={datasetStats?.averages?.load}
          avgUnit="kg"
          statusInfo={sensors?.load}
          tag={loadCategory}
          tagColor={LOAD_CATEGORY_COLOR[loadCategory]}
          stats={datasetStats?.sensorStats?.load}
        />

        <SensorCard
          icon={<Zap />}
          title="Current"
          value={fmt(datasetRecord?.current, 2)}
          unit="A"
          avg={datasetStats?.averages?.current}
          avgUnit="A"
          statusInfo={sensors?.current}
          stats={datasetStats?.sensorStats?.current}
        />

        <div
          className="kpi-card sensor-overall-card"
          style={{
            borderColor:
              SENSOR_STATUS_COLOR[overallCondition] || SENSOR_STATUS_COLOR.UNKNOWN
          }}
        >
          <div className="kpi-top">
            <span>Overall Record Condition</span>
            <div className="kpi-icon">
              <ShieldCheck />
            </div>
          </div>
          <div className="kpi-value">
            <strong
              style={{
                color:
                  SENSOR_STATUS_COLOR[overallCondition] || SENSOR_STATUS_COLOR.UNKNOWN
              }}
            >
              {overallCondition || "--"}
            </strong>
            <span>
              score {fmt(datasetRecord?.condition?.overallScore, 2)}
            </span>
          </div>
          <div className="kpi-line" />
        </div>

      </div>


      {/* =========================
          LIVE SENSOR TREND GRAPHS
          One graph per sensor, all built from the same rolling
          per-record buffer (datasetSensorHistory) — so they always
          advance together with playback, never on separate indexes.
      ========================= */}

      <PageIntro
        kicker="TREND"
        title="Live Sensor Graphs"
        description="Updates with every playback step, across the last 40 records shown."
      />

      <div className="two-column sensor-trend-grid">

        <SensorTrendPanel
          icon={<Thermometer />}
          title="Temperature"
          unit="℃"
          data={filteredSensorHistory}
          dataKey="temperature"
          color="#ff8a5c"
        />

        <SensorTrendPanel
          icon={<Gauge />}
          title="Speed / IR Sensor"
          unit="rpm"
          data={filteredSensorHistory}
          dataKey="speed"
          color="#58c4ff"
        />

      </div>

      <div className="two-column sensor-trend-grid">

        <SensorTrendPanel
          icon={<BarChart3 />}
          title="Load"
          unit="kg"
          data={filteredSensorHistory}
          dataKey="load"
          color="#b98af5"
        />

        <SensorTrendPanel
          icon={<Zap />}
          title="Current"
          unit="A"
          data={filteredSensorHistory}
          dataKey="current"
          color="#ffd166"
        />

      </div>


      {/* =========================
          LOAD DISTRIBUTION + DATASET AVERAGES
      ========================= */}

      <div className="two-column">

        <section className="panel">

          <PanelHeader
            icon={<BarChart3 />}
            title="Load Distribution"
            subtitle="ALL RECORDS"
          />

          <div className="mode-chart">

            <ResponsiveContainer width="100%" height="100%">

              <PieChart>

                <Pie
                  data={datasetStats?.loadDistribution || []}
                  dataKey="count"
                  nameKey="category"
                  innerRadius="45%"
                  outerRadius="75%"
                  paddingAngle={2}
                  isAnimationActive={false}
                  label={({ category, percentage }) => `${category} ${percentage}%`}
                >
                  {(datasetStats?.loadDistribution || []).map((entry) => (
                    <Cell
                      key={entry.category}
                      fill={LOAD_CATEGORY_COLOR[entry.category] || "#536d85"}
                    />
                  ))}
                </Pie>

                <Legend />
                <Tooltip />

              </PieChart>

            </ResponsiveContainer>

          </div>

          <div className="stat-line-group">
            {(datasetStats?.loadDistribution || []).map(d => (
              <StatLine
                key={d.category}
                label={d.category}
                value={`${d.count} records (${d.percentage}%)`}
              />
            ))}
          </div>

        </section>


        <section className="panel">

          <PanelHeader
            icon={<Gauge />}
            title="Dataset Statistics"
            subtitle="AVERAGES ACROSS ALL RECORDS"
          />

          <StatLine label="Average Temperature" value={datasetStats ? `${fmt(datasetStats.averages.temperature, 1)} ℃` : "--"} />
          <StatLine label="Average Speed" value={datasetStats ? `${fmt(datasetStats.averages.speed, 0)} rpm` : "--"} />
          <StatLine label="Average Vibration" value={datasetStats ? `${fmt(datasetStats.averages.vibration, 3)} m/s²` : "--"} />
          <StatLine label="Average Load" value={datasetStats ? `${fmt(datasetStats.averages.load, 0)} kg` : "--"} />
          <StatLine label="Average Current" value={datasetStats ? `${fmt(datasetStats.averages.current, 2)} A` : "--"} />
          <StatLine label="Total Records" value={datasetStats?.recordCount ?? "--"} />

          <p className="dataset-note">
            These are dataset-wide averages, not a live reading. The
            "Overall Record Condition" card above reflects only the
            currently selected record.
          </p>

        </section>

      </div>


      {/* =========================
          CONDITION CALCULATION METHOD
      ========================= */}

      {formula && (

        <section className="panel full-panel formula-panel">

          <PanelHeader
            icon={<Settings />}
            title="Condition Calculation Method"
            subtitle="HOW THE CURRENT RECORD CONDITION IS COMPUTED"
          />

          <p className="formula-summary">{formula.summary}</p>

          <ol className="formula-steps">
            {formula.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>

          <div className="formula-thresholds">
            {Object.entries(formula.thresholds).map(([sensor, t]) => (
              <div key={sensor} className="formula-threshold-row">
                <span>{sensor}</span>
                <strong>
                  {sensor === "speed"
                    ? `normal ${t.normalMin}–${t.normalMax} ${t.unit}, critical band width ${t.criticalBandWidth} ${t.unit}`
                    : `normal ≤ ${t.normalMax} ${t.unit}, critical ≥ ${t.criticalMax} ${t.unit}`}
                </strong>
              </div>
            ))}
          </div>

          <p className="dataset-note">
            Overall: NORMAL if score &lt; {formula.overallThresholds.warningAt},
            {" "}WARNING if score &lt; {formula.overallThresholds.criticalAt}, else CRITICAL
            {" "}(weights: {Object.entries(formula.weights).map(([k, v]) => `${k} ${v}`).join(", ")}).
          </p>

        </section>

      )}


      {/* =========================
          FAULT & CONDITION ANALYSIS
      ========================= */}

      <div className="two-column">

        <section className="panel">

          <PanelHeader
            icon={<Wrench />}
            title="Fault — Current Record"
            subtitle={`RECORD ${dataset.length ? index + 1 : "--"}`}
          />

          <div className="record-big">
            <span>FAULT TYPE</span>
            <strong className="fault-label">{datasetRecord?.fault || current?.fault || "--"}</strong>
          </div>

          <div className="stat-line-group">
            <StatLine label="Fault Classes (dataset)" value={datasetStats?.faultDistribution?.length ?? "--"} />
          </div>

        </section>

        <section className="panel">

          <PanelHeader
            icon={<Database />}
            title="Fault Distribution"
            subtitle="ALL RECORDS"
          />

          {(datasetStats?.faultDistribution || []).map(f => (
            <StatLine
              key={f.fault}
              label={f.fault}
              value={`${f.count} (${f.percentage}%)`}
            />
          ))}

        </section>

      </div>

    </>

  );

}


function SensorTrendPanel({
  icon,
  title,
  unit,
  data,
  dataKey,
  color
}) {

  return (

    <section className="panel">

      <PanelHeader
        icon={icon}
        title={title}
        subtitle={`TREND (${unit})`}
      />

      <div className="mode-chart trend-chart">

        <ResponsiveContainer width="100%" height="100%">

          <AreaChart data={data}>

            <CartesianGrid strokeDasharray="3 3" opacity={0.08} />

            <XAxis dataKey="sample" />

            <YAxis
              domain={["dataMin - 1", "dataMax + 1"]}
              width={40}
            />

            <Tooltip />

            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              fill={color}
              fillOpacity={0.15}
              isAnimationActive={false}
              connectNulls
            />

          </AreaChart>

        </ResponsiveContainer>

      </div>

    </section>

  );

}


function SensorCard({
  icon,
  title,
  value,
  unit,
  avg,
  avgUnit,
  statusInfo,
  tag,
  tagColor,
  stats
}) {

  const status = statusInfo?.status || "UNKNOWN";
  const color = SENSOR_STATUS_COLOR[status] || SENSOR_STATUS_COLOR.UNKNOWN;

  return (

    <div className="kpi-card sensor-card" style={{ borderColor: color }}>

      <div className="kpi-top">
        <span>{title}</span>
        <div className="kpi-icon">{icon}</div>
      </div>

      <div className="kpi-value">
        <strong>{value}</strong>
        <span>{unit}</span>
      </div>

      <div className="sensor-card-footer">

        <span
          className="sensor-status-pill"
          style={{ color, borderColor: color }}
        >
          {status}
        </span>

        {tag && (
          <span
            className="sensor-status-pill"
            style={{ color: tagColor, borderColor: tagColor }}
          >
            {tag}
          </span>
        )}

        {stats && stats.min != null && (
          <span className="sensor-avg-note">
            min {fmt(stats.min, 2)} · max {fmt(stats.max, 2)} · range {fmt(stats.range, 2)} {stats.unit}
          </span>
        )}

        {!stats && avg != null && (
          <span className="sensor-avg-note">
            avg {fmt(avg, avgUnit === "rpm" ? 0 : avgUnit === "kg" ? 0 : 2)} {avgUnit}
          </span>
        )}

      </div>

      <div className="kpi-line" />

    </div>

  );

}


/* =====================================================
   LIVE VIEW
===================================================== */

function LiveView({
  current,
  status,
  history,
  chartData,
  espStatus,
  processLive,
  cameraResult,
  sensorStatus
}) {

  const cam = cameraResult || null;
  const camStatus = sensorStatus?.cameraStatus || (cam ? "LIVE" : "WAITING");
  const camLive = camStatus === "LIVE" || camStatus === "CONNECTED";

  return (

    <>

      <PageIntro
        kicker="HARDWARE PIPELINE"
        title="Live / ESP32 Mode"
        description="This screen is ready to receive vibration readings from your ESP32 + MPU6050."
      />


      <div className="live-connection">

        <div className="live-pulse">

          <span />

        </div>

        <div>

          <strong>
            {espStatus}
          </strong>

          <p>
            ESP32 → Wi-Fi → Node.js → React
          </p>

        </div>

      </div>


      <section className="panel camera-analysis-panel">

        <PanelHeader
          icon={<Camera />}
          title="Camera Analysis"
          subtitle="PHONE CAMERA + OPENCV"
          right={
            <span className={`live-label ${camLive ? "" : "text-dim"}`}>
              {`● ${camStatus}`}
            </span>
          }
        />

        <IpWebcamLive />

        {cam ? (
          <div className="camera-inspection-card">
            <div className="evidence-list">
              <Evidence label="Belt detected" value={cam.beltDetected ? "YES" : "NO"} />
              <Evidence label="Belt position" value={cam.beltPosition || "UNKNOWN"} />
              <Evidence label="Movement" value={cam.motionState || "UNKNOWN"} />
              <Evidence label="Direction" value={cam.direction || "UNKNOWN"} />
              <Evidence
                label="Tracking deviation"
                value={cam.trackingDeviation != null ? `${Math.round(cam.trackingDeviation * 100)}%` : "--"}
              />
              <Evidence label="Joint/visual condition" value={cam.jointStatus || "UNKNOWN"} />
              <Evidence label="Visual severity" value={cam.visualSeverity || "NONE"} />
              <Evidence
                label="Camera confidence"
                value={cam.visualConfidence != null ? `${Math.round(cam.visualConfidence * 100)}%` : "--"}
              />
              <Evidence label="Frame age" value={cam.ageMs != null ? `${Math.round(cam.ageMs / 100) / 10}s` : "--"} />
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <Camera />
            <span>
              No OpenCV analysis data yet. Start camera_service.py on the
              laptop to begin capturing the belt and producing belt
              analysis evidence.
            </span>
          </div>
        )}

      </section>


      <div className="kpi-grid three">

        <Kpi
          icon={<Activity />}
          title="Live Vibration"
          value={
            fmt(
              current?.vibration,
              3
            )
          }
          unit="m/s²"
          color="blue"
        />

        <Kpi
          icon={<ShieldCheck />}
          title="Condition"
          value={status}
          unit=""
          color="green"
        />

        <Kpi
          icon={<Wifi />}
          title="Connection"
          value={espStatus}
          unit=""
          color="purple"
        />

      </div>


      <section className="panel full-panel">

        <PanelHeader
          icon={<Activity />}
          title="Live Vibration Stream"
          subtitle={
            espStatus === "LIVE"
              ? "RECEIVING FROM ESP32"
              : espStatus === "STALE"
              ? "LAST READING DELAYED"
              : "WAITING FOR ESP32"
          }
        />


        <div className="mode-chart tall">

          <ResponsiveContainer
            width="100%"
            height="100%"
          >

            <AreaChart
              data={chartData}
            >

              <CartesianGrid
                strokeDasharray="3 3"
                opacity={0.08}
              />

              <XAxis
                dataKey="sample"
              />

              <YAxis
                domain={[
                  "dataMin - 0.05",
                  "dataMax + 0.05"
                ]}
              />

              <Tooltip />

              <Area
                type="monotone"
                dataKey="vibration"
                fillOpacity={0.15}
                isAnimationActive={false}
              />

            </AreaChart>

          </ResponsiveContainer>

        </div>

      </section>


      <div className="info-callout">

        <Wifi />

        <div>

          <strong>
            Hardware integration ready
          </strong>

          <span>
            Your ESP32 should POST
            {" "}
            <code>
              {"{ vibration: value }"}
            </code>
            {" "}
            to
            {" "}
            <code>
              /api/live
            </code>
          </span>

        </div>

      </div>

    </>

  );

}


/* =====================================================
   TEST VIEW
===================================================== */

function TestView({
  current,
  status,
  startLiveSimulation,
  history,
  chartData
}) {

  return (

    <>

      <PageIntro
        kicker="SOFTWARE TEST"
        title="Prototype Test Mode"
        description="Generate a software test reading without pretending that it came from the physical ESP32."
      />


      <div className="test-hero">

        <div className="test-icon">
          <Zap />
        </div>

        <div>

          <span>
            SOFTWARE TEST SOURCE
          </span>

          <h2>
            Simulate Conveyor Reading
          </h2>

          <p>
            A random vibration value from
            the reference dataset is sent
            through the live analysis API.
          </p>

        </div>

        <button
          className="btn primary large"
          onClick={
            startLiveSimulation
          }
        >

          <Play />

          Run Test

        </button>

      </div>


      <div className="kpi-grid three">

        <Kpi
          icon={<Activity />}
          title="Test Vibration"
          value={
            fmt(
              current?.vibration,
              3
            )
          }
          unit="m/s²"
          color="blue"
        />

        <Kpi
          icon={<ShieldCheck />}
          title="Result"
          value={status}
          unit=""
          color="green"
        />

        <Kpi
          icon={<BarChart3 />}
          title="Samples"
          value={
            history.length
          }
          unit=""
          color="purple"
        />

      </div>


      <section className="panel full-panel">

        <PanelHeader
          icon={<Activity />}
          title="Test Signal"
          subtitle="LAST 40 SAMPLES"
        />

        <div className="mode-chart tall">

          <ResponsiveContainer
            width="100%"
            height="100%"
          >

            <AreaChart
              data={chartData}
            >

              <CartesianGrid
                strokeDasharray="3 3"
                opacity={0.08}
              />

              <XAxis
                dataKey="sample"
              />

              <YAxis
                domain={[
                  "dataMin - 0.05",
                  "dataMax + 0.05"
                ]}
              />

              <Tooltip />

              <Area
                type="monotone"
                dataKey="vibration"
                fillOpacity={0.15}
                isAnimationActive={false}
              />

            </AreaChart>

          </ResponsiveContainer>

        </div>

      </section>

    </>

  );

}


/* =====================================================
   ANALYSIS VIEW
===================================================== */

function AnalysisView({
  current,
  status,
  baseline
}) {

  const analysis =
    current?.analysis;

  return (

    <>

      <PageIntro
        kicker="INTELLIGENCE"
        title="Fault & Anomaly Analysis"
        description="Transparent evidence behind the current system condition."
      />


      <div className="analysis-hero">

        <div
          className={
            `analysis-status ${
              badgeClass(status)
            }`
          }
        >

          {status}

        </div>

        <div>

          <span>
            CURRENT ASSESSMENT
          </span>

          <h2>
            {analysis?.recommendation ||
              "No analysis available."}
          </h2>

          <p>
            {analysis?.note ||
              "Run Dataset Mode or Live Mode to generate analysis."}
          </p>

        </div>

      </div>


      <div className="two-column">

        <section className="panel">

          <PanelHeader
            icon={<BarChart3 />}
            title="Evidence"
            subtitle="EXPLAINABLE OUTPUT"
          />

          <Evidence
            label="Anomaly Score"
            value={fmt(
              analysis?.anomalyScore,
              3
            )}
          />

          <Evidence
            label="Baseline Mean"
            value={
              analysis?.baselineMean != null
                ? `${fmt(
                    analysis.baselineMean,
                    3
                  )} m/s²`
                : "--"
            }
          />

          <Evidence
            label="Baseline Std"
            value={
              analysis?.baselineStd != null
                ? `${fmt(
                    analysis.baselineStd,
                    3
                  )} m/s²`
                : "--"
            }
          />

          <Evidence
            label="Dataset Association"
            value={
              analysis
                ?.mlFaultAssociation ||
              "—"
            }
          />

          <Evidence
            label="Model Confidence"
            value={
              analysis
                ?.mlConfidence != null
                ? `${Math.round(
                    analysis.mlConfidence *
                      100
                  )}%`
                : "—"
            }
          />

        </section>


        <section className="panel">

          <PanelHeader
            icon={<ShieldCheck />}
            title="Baseline"
            subtitle="PROTOTYPE REFERENCE"
          />

          {baseline ? (

            <div className="baseline-big">

              <strong>
                {fmt(
                  baseline.mean,
                  3
                )}
              </strong>

              <span>
                m/s² mean vibration
              </span>

            </div>

          ) : (

            <div className="empty-state">
              Baseline unavailable
            </div>

          )}

          <p className="disclaimer">
            The reference dataset does not
            contain an explicit healthy class.
            Prototype baseline should be
            established from the real conveyor.
          </p>

        </section>

      </div>

    </>

  );

}


/* =====================================================
   ALERTS VIEW
===================================================== */

function AlertsView({
  alerts,
  clearAlerts
}) {

  return (

    <>

      <PageIntro
        kicker="EVENT CENTER"
        title="Alert History"
        description="Warning and critical events generated by the monitoring engine."
        action={
          alerts.length > 0 && (
            <button
              className="btn secondary"
              onClick={
                clearAlerts
              }
            >
              <X />
              Clear History
            </button>
          )
        }
      />


      <section className="panel">

        {alerts.length === 0 ? (

          <div className="empty-large">

            <CheckCircle2 />

            <h3>
              No Alerts
            </h3>

            <p>
              The monitoring system has
              not generated a warning event.
            </p>

          </div>

        ) : (

          alerts.map(alert => (

            <AlertRow
              key={alert.id}
              alert={alert}
              large
            />

          ))

        )}

      </section>

    </>

  );

}


/* =====================================================
   HISTORY VIEW
===================================================== */

function HistoryView({
  history
}) {

  return (

    <>

      <PageIntro
        kicker="SIGNAL HISTORY"
        title="Vibration History"
        description="Recent vibration observations captured by the dashboard."
      />


      <section className="panel">

        <PanelHeader
          icon={<History />}
          title="Recent Samples"
          subtitle={`${history.length} SAMPLES`}
        />


        <div className="history-table">

          <div className="table-head">
            <span>#</span>
            <span>TIME</span>
            <span>VIBRATION</span>
            <span>STATUS</span>
          </div>


          {history
            .slice()
            .reverse()
            .map(
              (row, i) => (

                <div
                  className="table-row"
                  key={i}
                >

                  <span>
                    {history.length -
                      i}
                  </span>

                  <span>
                    {row.t}
                  </span>

                  <span>
                    {fmt(
                      row.vibration,
                      3
                    )} m/s²
                  </span>

                  <span className="table-normal">
                    Recorded
                  </span>

                </div>

              )
            )}

        </div>

      </section>

    </>

  );

}


/* =====================================================
   SYSTEM VIEW
===================================================== */

function SystemView({
  info,
  baseline,
  resetBaseline,
  sensorStatus,
  smsState,
  smsSending,
  sendTestSms
}) {

  return (

    <>

      <PageIntro
        kicker="SYSTEM CONFIGURATION"
        title="System Information"
        description="Current monitoring architecture and prototype configuration."
      />


      <div className="three-column">

        <DataCard
          title="Sensor"
          value="MPU6050"
        />

        <DataCard
          title="Controller"
          value="ESP32"
        />

        <DataCard
          title="Backend"
          value="Node.js"
        />

      </div>


      <section className="panel">

        <PanelHeader
          icon={<Settings />}
          title="Reference Dataset"
          subtitle="BACKEND INFORMATION"
        />


        <div className="stats-grid">

          <StatLine
            label="Records"
            value={
              info?.records
            }
          />

          <StatLine
            label="Minimum vibration"
            value={
              info
                ? `${info.min} m/s²`
                : "--"
            }
          />

          <StatLine
            label="Maximum vibration"
            value={
              info
                ? `${info.max} m/s²`
                : "--"
            }
          />

          <StatLine
            label="Average vibration"
            value={
              info
                ? `${info.average} m/s²`
                : "--"
            }
          />

          <StatLine
            label="Fault classes"
            value={
              info?.faults
                ?.length
            }
          />

        </div>


        <div className="system-actions">

          <button
            className="btn secondary"
            onClick={
              resetBaseline
            }
          >

            <RotateCcw />

            Reset Prototype Baseline

          </button>

        </div>


        <div className="future-modules">

          <Module
            name="MPU6050 Vibration"
            state="ACTIVE"
          />

          <Module
            name="Camera (Laptop Webcam + OpenCV)"
            state={
              sensorStatus
                ? (sensorStatus.cameraStatus || (sensorStatus.cameraAvailable ? "ACTIVE" : "OFFLINE"))
                : "WAITING"
            }
          />

          <Module
            name="Sensor Fusion"
            state="ACTIVE"
          />

          <Module
            name="Temperature"
            state="FUTURE"
          />

          <Module
            name="Speed"
            state="FUTURE"
          />

          <Module
            name="Alignment"
            state="FUTURE"
          />

          <Module
            name="Motor Current"
            state="FUTURE"
          />

          <Module
            name="PLC / SCADA"
            state="INTEGRATION"
          />

        </div>

      </section>


      <section className="panel">

        <PanelHeader
          icon={<MessageSquare />}
          title="SMS Alerts (Twilio)"
          subtitle="CRITICAL CONDITION NOTIFICATIONS"
          right={
            <span
              className={
                `live-label ${smsState?.configured ? "" : "text-dim"}`
              }
            >
              {smsState?.configured ? "● CONFIGURED" : "● NOT CONFIGURED"}
            </span>
          }
        />

        <div className="stats-grid">

          <StatLine
            label="Status"
            value={smsState?.status || "--"}
          />

          <StatLine
            label="Last sent"
            value={
              smsState?.sentAt
                ? new Date(smsState.sentAt).toLocaleString()
                : "--"
            }
          />

          <StatLine
            label="Error"
            value={smsState?.error || "--"}
          />

        </div>

        {smsState?.note && (
          <p className="sms-note">{smsState.note}</p>
        )}

        <div className="system-actions">

          <button
            className="btn secondary"
            onClick={sendTestSms}
            disabled={smsSending}
          >

            <Send />

            {smsSending ? "Sending..." : "Send Test SMS"}

          </button>

        </div>

        <p className="sms-hint">
          Sends one clearly-labeled test SMS to verify your Twilio setup.
          Real CRITICAL alerts fire automatically from Live Mode — set
          TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER /
          ALERT_RECIPIENT_PHONE in backend/.env to enable them.
        </p>

      </section>

    </>

  );

}


/* =====================================================
   SMALL COMPONENTS
===================================================== */

function Kpi({
  icon,
  title,
  value,
  unit,
  color
}) {

  return (

    <div
      className={
        `kpi-card ${color}`
      }
    >

      <div className="kpi-top">

        <span>
          {title}
        </span>

        <div className="kpi-icon">
          {icon}
        </div>

      </div>


      <div className="kpi-value">

        <strong>
          {value}
        </strong>

        <span>
          {unit}
        </span>

      </div>


      <div className="kpi-line" />

    </div>

  );

}


function PanelHeader({
  icon,
  title,
  subtitle,
  right
}) {

  return (

    <div className="panel-header">

      <div className="panel-heading">

        <div className="panel-icon">
          {icon}
        </div>

        <div>

          <h3>
            {title}
          </h3>

          {subtitle && (
            <span>
              {subtitle}
            </span>
          )}

        </div>

      </div>

      {right}

    </div>

  );

}


function Flow({
  icon,
  text
}) {

  return (

    <div className="flow-item">

      {icon}

      <span>
        {text}
      </span>

    </div>

  );

}


function MiniStat({
  title,
  value
}) {

  return (

    <div className="mini-stat">

      <span>
        {title}
      </span>

      <strong>
        {value}
      </strong>

    </div>

  );

}


function SensorTag({
  className,
  text
}) {

  return (

    <div
      className={
        `sensor-tag ${className}`
      }
    >

      <span />

      {text}

    </div>

  );

}


function StatusItem({
  label,
  value,
  ok
}) {

  return (

    <div className="status-item">

      <span>
        {label}
      </span>

      <strong
        className={
          ok
            ? "text-green"
            : ""
        }
      >
        {value}
      </strong>

    </div>

  );

}


function Evidence({
  label,
  value
}) {

  return (

    <div className="evidence-row">

      <span>
        {label}
      </span>

      <strong>
        {value}
      </strong>

    </div>

  );

}


function AlertRow({
  alert,
  large
}) {

  return (

    <div
      className={
        `alert-row ${
          large
            ? "large"
            : ""
        }`
      }
    >

      <div
        className={
          `alert-symbol ${
            badgeClass(
              alert.condition
            )
          }`
        }
      >

        <AlertTriangle />

      </div>


      <div className="alert-content">

        <strong>
          {alert.condition}
        </strong>

        <span>
          {fmt(
            alert.vibration,
            3
          )} m/s²
          {" • "}
          {alert.source ||
            "system"}
        </span>

      </div>


      <time>
        {new Date(
          alert.time
        ).toLocaleTimeString()}
      </time>

    </div>

  );

}


function WorkflowStep({
  number,
  title,
  text,
  done
}) {

  return (

    <div className="workflow-step">

      <div className="workflow-number">
        {number}
      </div>

      <div>

        <strong>
          {title}
        </strong>

        <span>
          {text}
        </span>

      </div>

      <div
        className={
          done
            ? "workflow-check done"
            : "workflow-check"
        }
      >
        {done ? "✓" : "○"}
      </div>

    </div>

  );

}


function InfoItem({
  icon,
  title,
  value
}) {

  return (

    <div className="info-item">

      {icon}

      <div>

        <span>
          {title}
        </span>

        <strong>
          {value}
        </strong>

      </div>

    </div>

  );

}


function PageIntro({
  kicker,
  title,
  description,
  action
}) {

  return (

    <div className="page-intro">

      <div>

        <div className="section-kicker">
          {kicker}
        </div>

        <h2>
          {title}
        </h2>

        <p>
          {description}
        </p>

      </div>

      {action}

    </div>

  );

}


function DataCard({
  title,
  value
}) {

  return (

    <div className="data-card">

      <span>
        {title}
      </span>

      <strong>
        {value}
      </strong>

    </div>

  );

}


function StatLine({
  label,
  value
}) {

  return (

    <div className="stat-line">

      <span>
        {label}
      </span>

      <strong>
        {value ?? "--"}
      </strong>

    </div>

  );

}


function Module({
  name,
  state
}) {

  return (

    <div className="module-card">

      <div>

        <CircleDot />

        <strong>
          {name}
        </strong>

      </div>

      <span
        className={
          state === "ACTIVE"
            ? "module-active"
            : ""
        }
      >
        {state}
      </span>

    </div>

  );

}


export default App;