/* gaze-hud.js — contextual info box shown while gazing at a claimed/focused emitter. */
AFRAME.registerComponent('gaze-hud', {
  init: function () {
    this.panel = makeCanvasPanel(0.46, 0.26, 2200);
    this.panel.mesh.visible = false;
    this.el.object3D.add(this.panel.mesh);
    this.flashT = 0; this.flashOn = false; this.last = 0;
    this.v = new THREE.Vector3(); this.w = new THREE.Vector3();
  },
  flash: function (on) { this.flashT = 900; this.flashOn = on; },
  tick: function (time, dt) {
    const S = window.RFX;
    if (!S) return;
    if (this.flashT > 0) this.flashT -= (dt || 16);
    const g = S.gazed;
    this.panel.mesh.visible = !!g || this.flashT > 0;
    if (!this.panel.mesh.visible) return;
    if (time - this.last < 90) return;
    this.last = time;
    if (g) this.draw(g, S.claimProgress, time);
  },
  draw: function (g, prog, time) {
    const e = g.e, color = g.currentColor();
    const ctx = this.panel.ctx, cv = this.panel.cv, W = cv.width, H = cv.height;
    const range = Math.hypot(e.pos[0], e.pos[2]);
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle = 'rgba(2,10,7,0.92)';
    roundRect(ctx,4,4,W-8,H-8,18); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.stroke();
    ctx.textBaseline='middle';
    ctx.fillStyle = color; ctx.textAlign='left';
    ctx.font = 'bold ' + Math.round(H*0.155) + 'px ui-monospace, monospace';
    ctx.fillText(e.id, W*0.055, H*0.16);
    ctx.textAlign='right';
    ctx.fillText(Math.round(e.confidence*100) + '%', W*0.945, H*0.16);
    ctx.strokeStyle = color; ctx.globalAlpha=0.4; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(W*0.055,H*0.27); ctx.lineTo(W*0.945,H*0.27); ctx.stroke();
    ctx.globalAlpha=1;
    ctx.fillStyle = g.claimed ? CLAIM_COLOR : '#eafff6'; ctx.textAlign='left';
    ctx.font = 'bold ' + Math.round(H*0.115) + 'px ui-monospace, monospace';
    ctx.fillText(g.claimed ? 'HANDLED \u2713' : CLASSES[e.cls].name, W*0.055, H*0.40);
    const hd = bearing(e.vel[0], e.vel[2]);
    const cols = [
      ['RANGE', Math.round(range) + 'm'],
      ['SPEED', Math.hypot(e.vel[0],e.vel[2]).toFixed(1)],
      ['BRG',   Math.round(hd) + '\u00b0' + cardinal(hd)]
    ];
    for (let i=0;i<3;i++){
      const x = W*(0.19 + i*0.31);
      ctx.textAlign='center';
      ctx.fillStyle='#7fae9c'; ctx.font = Math.round(H*0.082) + 'px ui-monospace, monospace';
      ctx.fillText(cols[i][0], x, H*0.585);
      ctx.fillStyle='#eafff6'; ctx.font='bold ' + Math.round(H*0.135) + 'px ui-monospace, monospace';
      ctx.fillText(cols[i][1], x, H*0.72);
    }
    const by = H*0.87, bh = H*0.075, bx = W*0.055, bw = W*0.89;
    ctx.fillStyle='rgba(255,255,255,0.10)';
    roundRect(ctx,bx,by-bh/2,bw,bh,bh/2); ctx.fill();
    if (this.flashT > 0) {
      ctx.fillStyle = this.flashOn ? CLAIM_COLOR : '#7fae9c';
      roundRect(ctx,bx,by-bh/2,bw,bh,bh/2); ctx.fill();
      ctx.fillStyle='#02120c'; ctx.textAlign='center';
      ctx.font='bold ' + Math.round(H*0.072) + 'px ui-monospace, monospace';
      ctx.fillText(this.flashOn ? 'CLAIMED' : 'RELEASED', W/2, by);
    } else if (prog > 0.01) {
      ctx.fillStyle = CLAIM_COLOR;
      roundRect(ctx,bx,by-bh/2,Math.max(bh,bw*prog),bh,bh/2); ctx.fill();
      ctx.fillStyle='#7fae9c'; ctx.textAlign='center';
      ctx.font=Math.round(H*0.068) + 'px ui-monospace, monospace';
      ctx.fillText('HOLD GAZE TO ' + (g.claimed ? 'RELEASE' : 'CLAIM'), W/2, by - bh);
    } else {
      ctx.fillStyle='#5c7d70'; ctx.textAlign='center';
      ctx.font=Math.round(H*0.068) + 'px ui-monospace, monospace';
      ctx.fillText('TRIGGER OR HOLD GAZE TO ' + (g.claimed ? 'RELEASE' : 'CLAIM'), W/2, by);
    }
    this.panel.tex.needsUpdate = true;
  }
});
