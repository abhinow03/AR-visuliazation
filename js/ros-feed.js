/* ros-feed.js — rosbridge WebSocket client for live base-station telemetry.

   SCOPE OF THIS FILE (deliberately limited):
   Connects to rosbridge_websocket, subscribes to one topic, translates each
   incoming message into this app's internal emitter contract, and maintains
   a smoothed live-state buffer on window.RFX.ros.emitters. It does NOT spawn
   3D entities or touch rf-emitter.js/emitter-source.js — the current demo
   modes (blobs/swarm) are fixed-size arrays built at load time, and how a
   dynamically-growing/shrinking live feed should join the render system
   (a third mode? merged into swarm? something else?) is a design decision
   for later, not guessed at here. This file proves the data pipeline works
   end to end and is ready to be consumed once that decision is made.

   THE ONE SEAM: translateEmitter(). Every assumption about the real base
   station's message shape lives in that one function. Today it matches the
   Stage-1 test publisher's placeholder schema
     [{"id":..,"cls":..,"confidence":..,"pos":[x,y,z],"vel":[vx,vy,vz]}, ...]
   wrapped in a std_msgs/String's .data field (itself a JSON string, per the
   verified rosbridge envelope). When the real schema arrives, this is the
   only function that should need to change.

   COORDINATE FRAME ASSUMPTION (also isolated, also unconfirmed): ROS's
   REP-103 convention is a right-handed ENU world frame (x=East, y=North,
   z=Up). This app's scene convention (set from the very first swarm/CSV
   work) is x=East, y=Up, z=-North. rosEnuToScene() does that conversion.
   If the real base station does NOT publish REP-103 ENU (e.g. NED, or a
   body-relative frame), this is the only function that needs to change.
*/

// ---- frame conversion: ROS ENU (x=E,y=N,z=Up) -> scene (x=E,y=Up,z=-N) ----
function rosEnuToScene(x, y, z) {
  return [x, z, -y];
}

// ---- THE SEAM: raw rosbridge payload -> this app's emitter contract ----
// Returns null (and logs once, rate-limited) for anything unusable, so one
// malformed entry never takes the rest of the batch down with it.
let _translateWarnCount = 0;
function translateEmitter(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
    if (_translateWarnCount++ < 5) console.warn('[ros-feed] dropping entry: missing/invalid id', raw);
    return null;
  }
  const p = raw.pos;
  if (!Array.isArray(p) || p.length < 3 || !p.every(n => typeof n === 'number' && isFinite(n))) {
    if (_translateWarnCount++ < 5) console.warn('[ros-feed] dropping entry: bad pos', raw);
    return null;
  }
  const v = Array.isArray(raw.vel) && raw.vel.length >= 3 &&
    raw.vel.every(n => typeof n === 'number' && isFinite(n)) ? raw.vel : [0, 0, 0];

  const scenePos = rosEnuToScene(p[0], p[1], p[2]);
  const sceneVel = rosEnuToScene(v[0], v[1], v[2]);

  return {
    id: raw.id,
    cls: (typeof raw.cls === 'string' && CLASSES[raw.cls]) ? raw.cls : 'unknown',
    confidence: (typeof raw.confidence === 'number' && isFinite(raw.confidence))
      ? clamp(raw.confidence, 0, 1) : 0.5,
    pos: scenePos,
    vel: sceneVel
  };
}

/* ============================================================
   ros-feed — connection lifecycle, buffering, extrapolation.
   Attached to <a-scene>, inert unless CONFIG.rosbridgeUrl is set.
   ============================================================ */
AFRAME.registerComponent('ros-feed', {
  init: function () {
    this.enabled = !!(CONFIG.rosbridgeUrl && CONFIG.rosbridgeUrl.length);
    window.RFX = window.RFX || {};
    window.RFX.ros = {
      status: this.enabled ? 'connecting' : 'disabled',
      lastMsgAt: 0,
      msgCount: 0,
      emitters: new Map()   // id -> {id,cls,confidence,pos,vel,lastMsgTime,
                             //        renderPos, correctionFrom, correctionT, stale}
    };
    if (!this.enabled) return;

    this.ws = null;
    this.reconnectMs = CONFIG.rosReconnectMinMs;
    this.reconnectTimer = null;
    this.subscribed = false;
    this._destroyed = false;

    this.connect();

    // best-effort cleanup if the page unloads mid-session
    const self = this;
    window.addEventListener('beforeunload', function () { self.disconnect(); });
  },

  connect: function () {
    if (this._destroyed) return;
    const S = window.RFX.ros;
    S.status = 'connecting';
    let ws;
    try {
      ws = new WebSocket(CONFIG.rosbridgeUrl);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    const self = this;

    ws.addEventListener('open', function () {
      self.reconnectMs = CONFIG.rosReconnectMinMs;   // reset backoff on success
      const sub = {
        op: 'subscribe',
        topic: CONFIG.rosbridgeTopic,
        type: CONFIG.rosbridgeMsgType,
        queue_length: CONFIG.rosbridgeQueueLength
      };
      if (CONFIG.rosbridgeThrottleMs > 0) sub.throttle_rate = CONFIG.rosbridgeThrottleMs;
      ws.send(JSON.stringify(sub));
      self.subscribed = true;
      // status flips to 'live' only once we actually receive a message —
      // a successful subscribe with zero data yet is still "connecting"
    });

    ws.addEventListener('message', function (evt) { self.onMessage(evt); });

    ws.addEventListener('close', function () {
      window.RFX.ros.status = self._destroyed ? 'disabled' : 'disconnected';
      self.subscribed = false;
      if (!self._destroyed) self.scheduleReconnect();
    });
    ws.addEventListener('error', function () {
      // 'close' fires right after 'error' on a failed connection; let close
      // own the reconnect scheduling so we don't double-schedule.
    });
  },

  scheduleReconnect: function () {
    if (this._destroyed || this.reconnectTimer) return;
    const self = this;
    this.reconnectTimer = setTimeout(function () {
      self.reconnectTimer = null;
      self.connect();
    }, this.reconnectMs);
    this.reconnectMs = Math.min(this.reconnectMs * 2, CONFIG.rosReconnectMaxMs);
  },

  disconnect: function () {
    this._destroyed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
  },

  onMessage: function (evt) {
    let envelope;
    try { envelope = JSON.parse(evt.data); } catch (e) { return; }
    if (!envelope || envelope.op !== 'publish' || envelope.topic !== CONFIG.rosbridgeTopic) return;
    const msg = envelope.msg;
    if (!msg || typeof msg.data !== 'string') return;

    let batch;
    try { batch = JSON.parse(msg.data); } catch (e) {
      if (_translateWarnCount++ < 5) console.warn('[ros-feed] msg.data was not valid JSON', msg.data);
      return;
    }
    if (!Array.isArray(batch)) return;

    const now = performance.now();
    const S = window.RFX.ros;
    S.lastMsgAt = now; S.msgCount++;
    S.status = 'live';

    for (let i = 0; i < batch.length; i++) {
      const translated = translateEmitter(batch[i]);
      if (translated) this.applyUpdate(translated, now);
    }
  },

  // fold a freshly-translated update into the live buffer. First sighting
  // snaps immediately; subsequent updates blend from wherever we'd currently
  // predicted the object to be, so a network hiccup never causes a visible
  // pop back to some earlier position.
  applyUpdate: function (e, now) {
    const S = window.RFX.ros;
    const existing = S.emitters.get(e.id);
    if (!existing) {
      S.emitters.set(e.id, {
        id: e.id, cls: e.cls, confidence: e.confidence,
        pos: e.pos, vel: e.vel,
        renderPos: e.pos.slice(),
        correctionFrom: e.pos.slice(), correctionT: 1,
        lastMsgTime: now, stale: false
      });
      return;
    }
    existing.correctionFrom = this.extrapolate(existing, now);
    existing.correctionT = 0;
    existing.pos = e.pos; existing.vel = e.vel;
    existing.cls = e.cls; existing.confidence = e.confidence;
    existing.lastMsgTime = now;
    existing.stale = false;
  },

  // dead-reckon from an emitter's last authoritative pos+vel, capped so a
  // prediction never slides forever once updates stop arriving.
  extrapolate: function (e, now) {
    const ageMs = Math.min(now - e.lastMsgTime, CONFIG.rosExtrapolationCapMs);
    const t = ageMs / 1000;
    return [
      e.pos[0] + e.vel[0] * t,
      e.pos[1] + e.vel[1] * t,
      e.pos[2] + e.vel[2] * t
    ];
  },

  tick: function (time, dt) {
    if (!this.enabled) return;
    const S = window.RFX.ros;
    const now = performance.now();
    const step = Math.min(dt || 16, 50);

    // whole-feed staleness: connected and subscribed, but nothing arriving
    if (S.status === 'live' && S.lastMsgAt && (now - S.lastMsgAt) > CONFIG.rosFeedStaleMs) {
      S.status = 'stale';
    }

    // per-emitter smoothing + staleness/lost lifecycle
    S.emitters.forEach((e, id) => {
      const age = now - e.lastMsgTime;
      if (age > CONFIG.rosEmitterLostMs) { S.emitters.delete(id); return; }
      e.stale = age > CONFIG.rosEmitterStaleMs;

      if (e.correctionT < 1) {
        e.correctionT = clamp(e.correctionT + step / CONFIG.rosCorrectionMs, 0, 1);
        const a = cosineRamp(e.correctionT);
        e.renderPos = [
          e.correctionFrom[0] + (e.pos[0] - e.correctionFrom[0]) * a,
          e.correctionFrom[1] + (e.pos[1] - e.correctionFrom[1]) * a,
          e.correctionFrom[2] + (e.pos[2] - e.correctionFrom[2]) * a
        ];
      } else {
        e.renderPos = this.extrapolate(e, now);
      }
    });
  }
});
