/* rf-emitter.js — the per-emitter beacon: model, beam, occlusion ghost,
   claim state, breadcrumb trail. Includes its sole-consumer helpers
   (model builder, wireframe clone, beam shader) rather than utils.js. */
function makeBeamMaterial(colorHex) {
  return new THREE.ShaderMaterial({
    transparent:true, depthWrite:false, blending:THREE.NormalBlending, side:THREE.DoubleSide,
    uniforms: {
      uColor:{ value:new THREE.Color(colorHex) }, uTime:{ value:0 },
      uActive:{ value:0.0 }, uOpacity:{ value:0.9 }
    },
    vertexShader: [
      'varying vec2 vUv;',
      'void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uColor; uniform float uTime; uniform float uActive; uniform float uOpacity;',
      'varying vec2 vUv;',
      'void main(){',
      '  float fade = pow(1.0 - vUv.y, 1.5);',
      '  float bands = sin((vUv.y * 20.0) - uTime * 2.4);',
      '  bands = smoothstep(0.5, 1.0, bands) * 0.6;',
      '  float sweep = smoothstep(0.88, 1.0, sin((vUv.y * 3.0) - uTime * (2.0 + uActive * 5.0)));',
      '  float edge = sin(vUv.x * 3.14159);',
      '  float a = (fade * (0.48 + bands + sweep * 0.8)) * edge;',
      '  a *= uOpacity * (0.7 + uActive * 0.8);',
      '  gl_FragColor = vec4(uColor * (1.0 + uActive * 0.7), a);',
      '}'
    ].join('\n')
  });
}

// Confidence [0,1] -> emissive intensity: low confidence reads as a dim,
// uncertain indicator; high confidence reads as a bright, saturated one.
function confidenceToGlow(confidence) {
  const c = (typeof confidence === 'number' && isFinite(confidence)) ? clamp(confidence, 0, 1) : 0.7;
  return 0.6 + c * 1.8;   // range ~0.6 (dim) .. 2.4 (vivid)
}

function buildEmitterModel(shape, color, confidence) {
  const g = new THREE.Group();
  const bodyMats = [], accentMats = [];
  const glow = confidenceToGlow(confidence);

  // Sleek matte/glossy black chassis — MeshStandardMaterial for real
  // roughness/metalness response (MeshLambertMaterial has neither). No
  // envmap is set up in this scene, so metalness is kept moderate rather
  // than near-1: a fully metallic material with no environment to reflect
  // reads as flat near-black instead of glossy, since real metals derive
  // most of their look from reflected environment, not diffuse light.
  const BODY = () => {
    const m = new THREE.MeshStandardMaterial({
      color: 0x0b0d10, roughness: 0.35, metalness: 0.55, flatShading: true,
      fog: false, toneMapped: false
    });
    bodyMats.push(m); return m;
  };
  // Glowing indicator marker: dark base so diffuse shading stays subdued,
  // full-saturation emissive so it genuinely reads as an active light
  // rather than a shaded plastic part. Intensity carries confidence.
  const ACCENT = () => {
    const m = new THREE.MeshStandardMaterial({
      color: color.clone().multiplyScalar(0.15), emissive: color.clone(),
      emissiveIntensity: glow, roughness: 0.4, metalness: 0.2, flatShading: true,
      fog: false, toneMapped: false
    });
    accentMats.push(m); return m;
  };
  // Faint always-on metallic trim line (distinct from the gaze-triggered
  // lock-on shell elsewhere): a thin neutral highlight, not class-coloured.
  const TRIM = () => new THREE.MeshStandardMaterial({
    color: 0x3a4048, roughness: 0.2, metalness: 0.8, flatShading: true,
    fog: false, toneMapped: false
  });

  if (shape === 'drone') {
    // hexagonal "puck" chassis reads as designed hardware, not a cube
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.32, 0.15, 6), BODY()));
    const armG = new THREE.CylinderGeometry(0.032, 0.032, 0.9, 6);
    for (let i=0;i<2;i++){
      const arm = new THREE.Mesh(armG, BODY());
      arm.rotation.z = Math.PI/2; arm.rotation.y = (i===0?1:-1)*Math.PI/4;
      g.add(arm);
    }
    // glowing rotor rings — the drone's active/live indicator
    const rotG = new THREE.TorusGeometry(0.20, 0.026, 6, 14);
    [[0.45,0.45],[0.45,-0.45],[-0.45,0.45],[-0.45,-0.45]].forEach(function(p){
      const r = new THREE.Mesh(rotG, ACCENT());
      r.rotation.x = Math.PI/2; r.position.set(p[0],0.10,p[1]);
      g.add(r);
      const hub = new THREE.Mesh(new THREE.SphereGeometry(0.045,6,5), TRIM());
      hub.position.set(p[0],0.10,p[1]); g.add(hub);
    });
    // sensor-eye: a small glowing dome on top, the classification indicator
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 6, 0, Math.PI*2, 0, Math.PI/2), ACCENT());
    eye.position.y = 0.08; g.add(eye);
  } else if (shape === 'remote') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.5,0.14,0.75), BODY()));
    const antG = new THREE.CylinderGeometry(0.022,0.022,0.55,6);
    [-0.16,0.16].forEach(function(x,i){
      const a = new THREE.Mesh(antG, BODY());
      a.position.set(x,0.32,-0.28); a.rotation.x = -0.5; a.rotation.z = i===0?0.25:-0.25;
      g.add(a);
      // glowing antenna tip: the active-transmit indicator
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.045,6,5), ACCENT());
      tip.position.set(x + (i===0?0.13:-0.13), 0.55, -0.53); g.add(tip);
    });
    [-0.13,0.13].forEach(function(x){
      const stick = new THREE.Mesh(new THREE.SphereGeometry(0.06,8,6), TRIM());
      stick.position.set(x,0.11,0.16); g.add(stick);
    });
  } else if (shape === 'antenna') {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.4,0.14,0.4), BODY());
    base.position.y = -0.35; g.add(base);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035,0.045,0.8,6), BODY());
    pole.position.y = 0.05; g.add(pole);
    // glowing transmit tip
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.065,8,6), ACCENT());
    tip.position.y = 0.48; g.add(tip);
    // signal-wave rings: glowing, growing outward — the wifi/RF icon language
    [0.22,0.38,0.54].forEach(function(r){
      const arc = new THREE.Mesh(new THREE.TorusGeometry(r,0.020,6,14,Math.PI*0.55), ACCENT());
      arc.position.y = 0.48; arc.rotation.z = Math.PI*0.225;
      g.add(arc);
    });
  } else {
    // general floater: low-poly geodesic sensor-pod body, glowing
    // equatorial band, thin always-on metallic trim ring
    g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), BODY()));
    const eq = new THREE.Mesh(new THREE.TorusGeometry(0.68,0.028,6,24), ACCENT());
    eq.rotation.x = Math.PI/2; g.add(eq);
    const trim = new THREE.Mesh(new THREE.TorusGeometry(0.58,0.008,4,24), TRIM());
    trim.rotation.x = Math.PI/2; trim.rotation.z = Math.PI/3; g.add(trim);
  }
  g.userData.bodyMats = bodyMats;
  g.userData.accentMats = accentMats;
  g.userData.mats = accentMats;   // legacy alias: existing callers that recolor
                                   // "the whole model" now correctly touch only
                                   // the glowing accent parts, not the chassis
  return g;
}

function makeWireframeClone(src, color) {
  const g = new THREE.Group(); const mats = [];
  src.traverse(function (o) {
    if (o.isMesh) {
      const m = new THREE.Mesh(o.geometry,
        new THREE.MeshBasicMaterial({ color:color.clone(), wireframe:true, transparent:true,
          opacity:0.6, depthTest:false, fog:false, toneMapped:false }));
      m.position.copy(o.position); m.rotation.copy(o.rotation); m.scale.copy(o.scale);
      m.renderOrder = 12; mats.push(m.material); g.add(m);
    }
  });
  g.userData.mats = mats;
  return g;
}

AFRAME.registerComponent('rf-emitter', {
  schema: { idx:{type:'int', default:0} },
  init: function () {
    const e = this.e = ALL_EMITTERS[this.data.idx];
    this.baseColor = e.colorOverride || CLASSES[e.cls].color;
    this.claimed = false;
    const root = this.el.object3D;
    const c3 = new THREE.Color(this.baseColor);

    // All beacon geometry uses NORMAL blending, never additive: additive adds
    // to the passthrough behind it, so it washes out toward white against a
    // bright wall. Normal blending composites properly and holds its colour.
    this.beamMat = makeBeamMaterial(this.baseColor);
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.34,0.34,30,12,1,true), this.beamMat);
    this.beam.position.y = 15; root.add(this.beam);

    const soft = (o) => new THREE.MeshBasicMaterial({
      color:c3, transparent:true, opacity:o, fog:false, depthWrite:false,
      toneMapped:false, blending:THREE.NormalBlending });
    const solid = () => new THREE.MeshBasicMaterial({
      color:c3, transparent:false, opacity:1, fog:false, toneMapped:false });

    this.spine = new THREE.Mesh(new THREE.CylinderGeometry(0.10,0.10,30,8), solid());
    this.spine.position.y = 15; root.add(this.spine);

    // dark opaque outline ring under the bright ring: pure contrast device,
    // gives the locator a hard edge on light-coloured floors
    this.underRing = new THREE.Mesh(new THREE.RingGeometry(1.55,2.35,48),
      new THREE.MeshBasicMaterial({ color:0x02100a, transparent:false,
        fog:false, toneMapped:false, depthTest:false, side:THREE.DoubleSide }));
    this.underRing.renderOrder = 7;
    this.underRing.rotation.x = -Math.PI/2; this.underRing.position.y = 0.02; root.add(this.underRing);

    this.ring = new THREE.Mesh(new THREE.RingGeometry(1.7,2.2,48), solid());
    this.ring.material.side = THREE.DoubleSide;
    this.ring.material.depthTest = false; this.ring.renderOrder = 8;
    this.ring.rotation.x = -Math.PI/2; this.ring.position.y = 0.03; root.add(this.ring);
    this.pulse = new THREE.Mesh(new THREE.RingGeometry(1.2,1.5,48), soft(0.85));
    this.pulse.material.side = THREE.DoubleSide;
    this.pulse.material.depthTest = false; this.pulse.renderOrder = 8;
    this.pulse.rotation.x = -Math.PI/2; this.pulse.position.y = 0.05; root.add(this.pulse);

    const shape = CLASSES[e.cls].shape || 'orb';
    this.model = buildEmitterModel(shape, c3, e.confidence);
    this.model.position.y = 2.6; this.model.scale.setScalar(MODEL_SCALE);
    root.add(this.model);

    this.hit = new THREE.Mesh(new THREE.SphereGeometry(1.7,10,8),
      new THREE.MeshBasicMaterial({ visible:false }));
    this.hit.position.y = 2.6; root.add(this.hit);
    this.orb = this.hit;


    this.ghost = makeWireframeClone(this.model, c3);
    this.ghost.position.y = 2.6; this.ghost.scale.setScalar(MODEL_SCALE);
    this.ghost.visible = false;
    root.add(this.ghost);
    this._occT = 0; this._occRay = new THREE.Raycaster();
    this._wp = new THREE.Vector3(); this._cp = new THREE.Vector3();

    // lock-on shell sized to ENCLOSE the model (radius scales with MODEL_SCALE,
    // otherwise it ends up buried inside the larger airframe)
    this.shell = new THREE.Mesh(new THREE.IcosahedronGeometry(MODEL_SCALE*0.72, 1),
      new THREE.MeshBasicMaterial({ color:c3, wireframe:true, transparent:true,
        opacity:0.0, fog:false, toneMapped:false, blending:THREE.NormalBlending }));
    this.shell.position.y = 2.6; root.add(this.shell);

    this.claimRing = new THREE.Mesh(new THREE.TorusGeometry(MODEL_SCALE*0.80, 0.10, 8, 44),
      new THREE.MeshBasicMaterial({ color:new THREE.Color(CLAIM_COLOR), transparent:false,
        fog:false, toneMapped:false, blending:THREE.NormalBlending }));
    this.claimRing.rotation.x = -Math.PI/2; this.claimRing.position.y = 0.12;
    this.claimRing.visible = false; root.add(this.claimRing);

    this.trailPts = []; this.trailLast = 0;
    const worldParent = this.el.object3D.parent || root;
    this.trailLine = new THREE.Line(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color:c3, transparent:true, opacity:0.45,
        depthTest:false, fog:false, toneMapped:false }));
    this.trailLine.renderOrder = 6; worldParent.add(this.trailLine);

    this.phase = Math.random()*1800;
    this.focused = false;
  },
  setFocused: function (f) {
    if (this.focused === f) return;
    this.focused = f;
    this.beamMat.uniforms.uActive.value = f ? 1.0 : 0.0;
    this.model.scale.setScalar(f ? MODEL_SCALE*1.22 : MODEL_SCALE);
    this.shell.material.opacity = f ? 0.9 : 0.0;
  },
  toggleClaim: function () {
    this.claimed = !this.claimed;
    this.claimRing.visible = this.claimed;
    const c = new THREE.Color(this.claimed ? CLAIM_COLOR : this.baseColor);
    this.beamMat.uniforms.uColor.value.copy(c);
    this.model.userData.mats.forEach(function(m){
      m.color.copy(c).multiplyScalar(0.15);
      if (m.emissive) m.emissive.copy(c);   // emissiveIntensity (confidence) stays as-created
    });
    this.ghost.userData.mats.forEach(function(m){ m.color.copy(c); });
    this.spine.material.color.copy(c);
    this.shell.material.color.copy(c);
    this.ring.material.color.copy(c);
    this.pulse.material.color.copy(c);
    return this.claimed;
  },
  currentColor: function () { return this.claimed ? CLAIM_COLOR : this.baseColor; },
  tick: function (time, dt) {
    const S = window.RFX;
    if (!S) return;
    const e = this.e, root = this.el.object3D;

    const active = (e.mode === S.mode);
    if (root.visible !== active) root.visible = active;
    this.trailLine.visible = active && S.showTrails;
    if (!active) return;

    const step = Math.min(dt || 16, 50) / 1000;
    if (e.driven) {
      root.position.set(e.pos[0], 0, e.pos[2]);
    } else if (S.playing) {
      e.pos[0] += e.vel[0] * step * S.speed;
      e.pos[2] += e.vel[2] * step * S.speed;
      e.vel[0] += Math.sin(time*0.0005 + this.phase)*0.02*step;
      e.vel[2] += Math.cos(time*0.0004 + this.phase)*0.02*step;
      if (Math.hypot(e.pos[0], e.pos[2]) > 75) { e.vel[0]*=-1; e.vel[2]*=-1; }
      root.position.set(e.pos[0], 0, e.pos[2]);
    }
    const ts = time * 0.001;
    this.beamMat.uniforms.uTime.value = ts;
    this.beam.visible = S.beams;
    this.spine.visible = S.beams;
    const t = ((time + this.phase) % 1800) / 1800;
    const s = 1 + t*4.0;
    this.pulse.scale.set(s,1,s);
    this.pulse.material.opacity = 0.85 * (1 - t);
    const bob = e.driven
      ? Math.max(2.0, e.pos[1])
      : 2.6 + Math.sin(time*0.0015 + this.phase)*0.10;
    this.model.position.y = this.hit.position.y = bob;
    this.shell.position.y = this.ghost.position.y = bob;
    if (e.driven) {
      const k = bob / 30;
      this.beam.scale.y = k;  this.beam.position.y = bob/2;
      this.spine.scale.y = k; this.spine.position.y = bob/2;
    }
    this.model.rotation.y += step * 0.4;
    this.ghost.rotation.y = this.model.rotation.y;

    if (time - this._occT > 250) {
      this._occT = time;
      let occluded = false;
      const occ = this.el.sceneEl.components['real-occluders'];
      const cam2 = this.el.sceneEl.camera;
      if (occ && occ.entries.size && cam2) {
        cam2.getWorldPosition(this._cp);
        this.model.getWorldPosition(this._wp);
        const dir = this._wp.clone().sub(this._cp);
        const dist = dir.length();
        this._occRay.set(this._cp, dir.normalize());
        this._occRay.far = dist - 0.05;
        occluded = this._occRay.intersectObjects(occ.group.children, false).length > 0;
      }
      this.ghost.visible = occluded;
    }
    this.shell.rotation.y += step * (this.focused ? 1.1 : 0.35);
    this.shell.rotation.x += step * 0.15;
    if (this.claimed) {
      this.claimRing.rotation.z += step * 0.8;
      this.claimRing.scale.setScalar(1 + Math.sin(time*0.004)*0.05);
    }

    if (time - this.trailLast > 150) {
      this.trailLast = time;
      this.trailPts.push(new THREE.Vector3(root.position.x, bob, root.position.z));
      if (this.trailPts.length > 40) this.trailPts.shift();
      // Fresh BufferGeometry each update, not setFromPoints() on the old one:
      // reusing a geometry whose point count keeps growing hits a fixed
      // buffer capacity and silently truncates (BufferGeometry warns
      // "buffer size too small" and drops the extra points). Trivial cost
      // at 6 drones / <=121 vertices each.
      let newGeo;
      if (this.trailPts.length > 2) {
        // Catmull-Rom through the raw samples so the trail reads as one
        // continuous curve rather than a faceted polyline.
        const curve = new THREE.CatmullRomCurve3(this.trailPts, false, 'catmullrom', 0.5);
        newGeo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(this.trailPts.length * 3));
      } else if (this.trailPts.length > 1) {
        newGeo = new THREE.BufferGeometry().setFromPoints(this.trailPts);
      }
      if (newGeo) {
        this.trailLine.geometry.dispose();
        this.trailLine.geometry = newGeo;
      }
    }
  }
});
