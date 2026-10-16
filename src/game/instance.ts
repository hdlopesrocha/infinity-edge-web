// GameInstance 37_T verbatim: build order, Update order, Draw order, HUD
// (ToVisualIngame scoreboard, aim, DrawPointer/MyClamp), scores, ghost.

import { mat4, vec3 } from '../engine/math';
import { frustumContains } from '../engine/frustum';
import type { Renderer } from '../engine/renderer';
import type { TexEntry } from '../engine/texture';
import { GameMap } from './map';
import type { DrawCtx } from './objects';
import { Ark, Base, Flag, SpaceObject, SpaceShip } from './objects';
import {
  Team, GameScore, Reward, CondDestroyed, CondMoreTime, CondLessTime, CondMorePoints, CondNoPath,
  CondTopScore, parseTimeSpan,
} from './team';
import type { RewardType, ScoreEntry } from './team';
import { TEAMS } from './config';
import { Control } from './controls';
import { applyAction, upgradeAIShips } from './ai';
import { addScore } from './store';
import { loadGhostFile, saveGhostFile } from './ghost';
import type { GhostRecord } from './ghost';
import type { LevelDef } from './levels';
import type { RC } from './resources';

export type GameType = 'CTF' | 'TT' | 'BACK' | 'KOTS' | 'SURV';

export interface PointerMark {
  x: number;
  y: number;
  w: number;
  h: number;
  iconUrl: string | null;
  over: boolean;
  color: [number, number, number];
  label: string | null;
}

export class GameInstance {
  map!: GameMap;
  teams = new Map<string, Team>();
  objects = new Map<string, SpaceObject>();
  control = new Control();
  selectedObject: SpaceShip | null = null;
  goals: Reward[] = [];
  /** Match length in ms from the level's MoreTime goal (0 = untimed). */
  matchTimeMs = 0;
  bestGhostRecords: GhostRecord[] = [];
  ghostRecords: GhostRecord[] = [];
  gameType: GameType = 'BACK';
  savefile = '';
  ghostFile: string | null = null;
  levelKey = '';
  levelTitle = '';
  levelText = '';
  dtMs = 16;
  notificationTime = 0;
  notificationText = '';
  finished = false;
  fireWasDown = false;
  homingWasDown = false;
  aimedTarget: SpaceObject | null = null;
  result: { won: boolean; reward: RewardType; message: string | null } | null = null;
  skyGpu: import('../engine/model').GpuModel | null = null;
  skyTex: TexEntry | null = null;
  cameraTarget = vec3.create();

  constructor(
    public renderer: Renderer,
    public rc: RC,
    public canvasW = 1280,
    public canvasH = 720,
  ) {}

  static async create(
    renderer: Renderer, rc: RC, def: LevelDef, levelText: string,
  ): Promise<GameInstance> {
    const gi = new GameInstance(renderer, rc);
    gi.levelKey = def.key;
    const t = def.description.type;
    const types: GameType[] = ['CTF', 'TT', 'BACK', 'KOTS', 'SURV'];
    gi.gameType = types.includes(t as GameType) ? (t as GameType) : 'BACK';
    gi.levelTitle = def.description.name;
    gi.levelText = levelText;
    gi.savefile = def.description.save;
    gi.ghostFile = def.importGhost ?? null;
    gi.map = new GameMap(def.description.sky, def.description.size || 2048);
    gi.map.rng = rc.random;
    const modelNames = new Set<string>([def.description.sky]);
    for (const o of def.objects) {
      if (o.model) modelNames.add(o.model);
    }
    for (const m of ['Bullet', 'HomingMissile2', 'Base', 'adHomingMissile', 'adRepair', 'adShield', 'adNitro', 'Wheel']) {
      modelNames.add(m);
    }
    await rc.preload([...modelNames], [
      'flare1', 'flare2',
      'holoSmoke1', 'holoSmoke2', 'holoSmoke3', 'holoSmoke4', 'holoSmoke5', 'holoSmoke6', 'holoSmoke7',
      'hexagon', 'aim', 'over',
      'Fighter3_icon', 'Ark_icon', 'Base_icon', 'Flag_icon',
    ]);
    const sky = rc.model(def.description.sky);
    if (sky) {
      const lod0 = sky.solid[0] ?? sky.color[0];
      if (lod0) {
        gi.skyGpu = lod0;
        gi.skyTex = sky.tex;
      }
    }
    for (const cfg of TEAMS) gi.teams.set(cfg.name, new Team(cfg.name, [...cfg.color] as [number, number, number]));
    // Every team that fields objects fights every other one (two factions in
    // CTF, free-for-all in the solo King of the System / Survival levels).
    const combatants = [...new Set(def.objects.map((o) => o.team))].filter((n) => n !== 'ambient');
    for (const a of combatants) {
      const ta = gi.teams.get(a);
      if (!ta) continue;
      for (const b of combatants) {
        if (a === b) continue;
        const tb = gi.teams.get(b);
        if (tb) ta.enemys.push(tb);
      }
    }
    for (const o of def.objects) {
      gi.map.buildObject(
        { team: o.team, type: o.type, model: o.model, position: o.position, name: o.name, life: o.life, amount: o.amount },
        gi,
      );
    }
    gi.map.setRotationPath();
    if (def.camara.name === 'LookAtObject') {
      const obj = gi.objects.get(def.camara.value) as SpaceShip | undefined;
      if (obj) gi.selectedObject = obj;
    } else {
      const v = (def.camara.value || '').split('|').map(Number);
      gi.cameraTarget = vec3.fromValues(v[0] || 0, v[1] || 0, v[2] || 0);
    }
    renderer.camera.far = rc.options.distance;
    for (const a of def.actions) applyAction(gi, a.name, a.from, a.to ?? null);
    // Web addition: every AI ship hunts the addons it can use (repair, nitro,
    // missiles, shield) and fires its homing missiles / nitro; `?ai=smart`
    // layers the experimental brain underneath. The arena guard is always on.
    upgradeAIShips(gi);
    for (const g of def.goals) {
      const reward = (
        g.reward === 'Gold' || g.reward === 'Silver' || g.reward === 'Bronze' ||
        g.reward === 'Victory' || g.reward === 'Defeat' ? g.reward : 'None'
      ) as RewardType;
      const r = new Reward(reward, g.message ?? null);
      for (const goal of g.goals) {
        if (goal.name === 'NoPath') r.addCondition(new CondNoPath());
        else if (goal.name === 'LessTime') r.addCondition(new CondLessTime(parseTimeSpan(goal.value ?? '00:00:00')));
        else if (goal.name === 'MoreTime') {
          const limit = parseTimeSpan(goal.value ?? '00:00:00');
          // The HUD's match clock: the longest MoreTime goal is when the match
          // ends (CTF levels: 5:00).
          gi.matchTimeMs = Math.max(gi.matchTimeMs, limit);
          r.addCondition(new CondMoreTime(limit));
        }
        else if (goal.name === 'MoreHillTime') r.addCondition(new CondTopScore((t) => t.hillMs));
        else if (goal.name === 'MoreKills') r.addCondition(new CondTopScore((t) => t.kills));
        else if (goal.name === 'Destroyed') {
          r.addCondition(new CondDestroyed((gi.objects.get(goal.value ?? '') as SpaceObject | undefined) ?? null));
        } else if (goal.name === 'MorePoints') {
          const team = gi.teams.get(goal.value ?? '');
          if (team) r.addCondition(new CondMorePoints(team));
        }
      }
      gi.goals.push(r);
    }
    if (gi.ghostFile) {
      const best = await loadGhostFile(gi.ghostFile);
      if (best) gi.bestGhostRecords = best;
    }
    gi.snapCamera();
    return gi;
  }

  setNotification(voiceField: string): void {
    this.notificationText = this.rc.playVoice(voiceField);
    this.notificationTime = 3000;
  }

  update(dtMs: number): void {
    this.dtMs = dtMs;
    if (this.gameType === 'BACK') {
      this.map.update(this, dtMs);
      this.renderer.camera.lookAtPositionAuto(this.cameraTarget, dtMs);
      return;
    }
    if (this.finished) return;
    this.control.update(this.canvasW, this.canvasH);
    this.updateObjectUI();
    for (const t of this.teams.values()) {
      if (t.base) {
        const found: import('../engine/octree').OctItem[] = [];
        this.map.octree.sphereSelect(t.base.sx, t.base.sy, t.base.sz, t.base.sradius, found);
        if (found.length === 1 || this.gameType !== 'TT') t.timeMs += dtMs;
      }
      const list = [...t.objects];
      for (const ob of list) {
        if (!(ob instanceof Flag)) ob.automaticAction(this, dtMs);
      }
    }
    this.map.update(this, dtMs);
    this.updateRegion(dtMs);
    if (this.selectedObject) {
      const o = this.selectedObject;
      this.renderer.camera.lookAtObject(
        o.pos, o.dir, o.side, o.rot,
        { stickX: this.control.analogStick.value.x, stickY: this.control.analogStick.value.y },
        this.rc.options.axisX, this.rc.options.axisY, this.rc.options.distance,
      );
    }
    this.notificationTime -= dtMs;
    if (this.notificationTime < 0) {
      this.notificationTime = 0;
      this.notificationText = '';
    }
    for (const t of this.teams.values()) {
      if (t.flag) t.flag.automaticAction(this, dtMs);
    }
    for (const r of this.goals) {
      if (r.check(this)) {
        if (r.reward !== 'Defeat') {
          this.result = { won: true, reward: r.reward, message: r.message };
          this.rc.playVoice('objectiveCompleted');
        } else {
          this.result = { won: false, reward: r.reward, message: r.message };
          this.rc.playVoice('youLost');
        }
        this.finished = true;
        this.onFinish();
        break;
      }
    }
  }

  /** King of the System: a team whose ship sits inside the region scores time. */
  private updateRegion(dtMs: number): void {
    const r = this.map.region;
    if (!r) return;
    const r2 = r.radius * r.radius;
    for (const t of this.teams.values()) {
      if (t.name === 'ambient') continue;
      for (const o of t.objects) {
        if (!(o instanceof SpaceShip) || !o.active) continue;
        const dx = o.pos[0] - r.pos[0];
        const dy = o.pos[1] - r.pos[1];
        const dz = o.pos[2] - r.pos[2];
        if (dx * dx + dy * dy + dz * dz <= r2) {
          t.hillMs += dtMs;
          break;
        }
      }
    }
  }

  private updateObjectUI(): void {
    const obj = this.selectedObject;
    if (obj) {
      this.ghostRecords.push({
        pos: vec3.clone(obj.pos),
        rot: [obj.rot[0], obj.rot[1], obj.rot[2], obj.rot[3]] as unknown as import('../engine/math').quat,
        timeMs: obj.team.timeMs,
      });
      if (this.ghostRecords.length > 30000) this.ghostRecords.shift();
    }
    for (const t of this.teams.values()) t.manage(this, obj);
    if (this.control.nitroButton.value && obj) obj.launchNitro(this.dtMs);
    if (obj) {
      this.control.homings = obj.homings;
      this.control.nitroFrac = obj.nitro / 3000;
    }
  }

  private onFinish(): void {
    if (!this.result) return;
    if (this.result.won) {
      const gs = this.getGameScore();
      const best = addScore(gs, this.gameType === 'BACK' ? 'CTF' : this.gameType, this.savefile);
      if (best && this.ghostFile) saveGhostFile(this.ghostFile, this.ghostRecords);
    }
  }

  getGameScore(): GameScore {
    const gs = new GameScore();
    for (const t of this.teams.values()) {
      if (t.objects.length > 0 && this.selectedObject) {
        const control = t === this.selectedObject.team;
        gs.scores.push({
          name: control ? this.rc.options.username : t.name,
          points: t.points,
          timeMs: t.timeMs,
          control,
          score: this.gameType === 'KOTS' ? Math.round(t.hillMs) : this.gameType === 'SURV' ? t.kills : undefined,
        });
      }
    }
    return gs;
  }

  draw(): void {
    const r = this.renderer;
    const d: DrawCtx = {
      draw: r.draw,
      view: r.camera.view,
      proj: r.camera.proj,
      camPos: r.camera.position,
      camDistance: (pos: vec3) => {
        const c = r.camera.position;
        return Math.hypot(pos[0] - c[0], pos[1] - c[1], pos[2] - c[2]);
      },
      rc: this.rc,
    };
    this.drawSky();
    if (this.gameType === 'BACK') {
      this.map.draw(d);
      return;
    }
    this.map.draw(d);
    this.drawGhost(d);
    void d;
  }

  private drawSky(): void {
    if (!this.skyGpu) return;
    const r = this.renderer;
    const draw = r.draw;
    // The dome goes to its own target so the blur stage never touches it.
    r.post.beginSky();
    draw.setNoDepth();
    draw.setCull('none');
    const m = mat4.create();
    mat4.fromTranslation(m, r.camera.position);
    // The dome is camera-locked: comparing against the *previous* camera
    // translation keeps its motion-blur velocity at zero (it is "at infinity").
    const prev = mat4.create();
    mat4.fromTranslation(prev, r.prevCameraPos);
    draw.drawUnlit(this.skyGpu, this.skyTex, m, r.camera.view, r.camera.proj, [1, 1, 1], 1, prev);
    r.trackDraws(this.skyGpu.meshes.length);
    draw.setCull('none');
    draw.setDepth();
    r.post.bindScene();
  }

  private drawGhost(d: DrawCtx): void {
    const sel = this.selectedObject;
    if (!sel || this.bestGhostRecords.length === 0) return;
    while (this.bestGhostRecords.length > 1 && this.bestGhostRecords[0].timeMs < sel.team.timeMs) {
      this.bestGhostRecords.shift();
    }
    const gr = this.bestGhostRecords[0];
    const m = mat4.create();
    mat4.fromRotationTranslationScale(m, gr.rot, gr.pos, vec3.fromValues(sel.scale, sel.scale, sel.scale));
    const L = sel.lod(d, 'solid');
    if (!L) return;
    d.draw.drawModel(L.gpu, sel.model.tex, m, d.view, d.proj, d.camPos, {
      alpha: 0.5 * L.alpha, emissive: [0.2, 0.2, 0.2], light: true, prevWorld: m,
    });
    d.rc.renderer.trackDraws(L.gpu.meshes.length);
  }

  snapCamera(): void {
    if (this.gameType === 'BACK' || !this.selectedObject) {
      this.renderer.camera.lookAtPositionAuto(this.cameraTarget, 100000);
      return;
    }
    const o = this.selectedObject;
    this.renderer.camera.lookAtObject(
      o.pos, o.dir, o.side, o.rot, { stickX: 0, stickY: 0 },
      this.rc.options.axisX, this.rc.options.axisY, this.rc.options.distance,
    );
  }

  project(px: number, py: number, pz: number): { x: number; y: number } {
    const cam = this.renderer.camera;
    const m = mat4.create();
    mat4.multiply(m, cam.proj, cam.view);
    const a = m as unknown as Float32Array;
    const cx = a[0] * px + a[4] * py + a[8] * pz + a[12];
    const cy = a[1] * px + a[5] * py + a[9] * pz + a[13];
    const cw = a[3] * px + a[7] * py + a[11] * pz + a[15];
    return {
      x: ((cx / cw) * 0.5 + 0.5) * this.canvasW,
      y: (1 - ((cy / cw) * 0.5 + 0.5)) * this.canvasH,
    };
  }

  pointers(): PointerMark[] {
    const out: PointerMark[] = [];
    const sel = this.selectedObject;
    if (!sel) return out;
    const cam = this.renderer.camera;
    const f = this.renderer.frustum;
    const inFrustum = (o: SpaceObject): boolean => {
      for (let i = 0; i < 6; i++) {
        if (f[i * 4] * o.sx + f[i * 4 + 1] * o.sy + f[i * 4 + 2] * o.sz + f[i * 4 + 3] < -o.sradius) return false;
      }
      return true;
    };
    const pushPointer = (obj: SpaceObject): void => {
      if (inFrustum(obj)) {
        if (obj instanceof SpaceShip) {
          const p = this.project(obj.pos[0], obj.pos[1], obj.pos[2]);
          out.push({
            x: p.x, y: p.y, w: 48, h: 48, iconUrl: null, over: true,
            color: obj.team.color, label: Math.floor(obj.lifePercentage() * 100) + '%',
          });
          return;
        }
        if (obj instanceof Ark) return;
      }
      let tx = obj.pos[0], ty = obj.pos[1], tz = obj.pos[2];
      const toObj = vec3.fromValues(tx - cam.position[0], ty - cam.position[1], tz - cam.position[2]);
      if (vec3.dot(toObj, cam.direction) < 0) {
        // XNA: Viewport.Project(Vector3.Reflect(obj.Position, Near.Normal)) --
        // reflects the absolute position about the plane through the origin.
        const n = vec3.fromValues(f[20], f[21], f[22]);
        const d = vec3.dot(vec3.fromValues(tx, ty, tz), n);
        tx -= 2 * d * n[0];
        ty -= 2 * d * n[1];
        tz -= 2 * d * n[2];
      }
      const p = this.project(tx, ty, tz);
      let sx = p.x, sy = p.y;
      const icon = obj.model.icon;
      const iw = icon ? icon.width : 32;
      const ih = icon ? icon.height : 32;
      if (!frustumContains(f, obj.pos[0], obj.pos[1], obj.pos[2])) {
        const cl = this.myClamp(sx, sy, iw / 2, ih / 2);
        sx = cl.x;
        sy = cl.y;
      }
      let c: [number, number, number] = [...obj.team.color] as [number, number, number];
      if (!(obj instanceof Base) && !(obj instanceof Flag) && !(obj instanceof Ark)) {
        c = [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5];
      }
      const sizeOverX = this.canvasW / 2;
      const sizeOverY = this.canvasH / 2;
      let vx = sx - sizeOverX, vy = sy - sizeOverY;
      const rate = sizeOverX / sizeOverY;
      if (vx * vx + rate * rate * vy * vy > sizeOverX * sizeOverX) {
        vx /= sizeOverX;
        vy /= sizeOverY;
        const l = Math.hypot(vx, vy) || 1;
        vx = (vx / l) * sizeOverX;
        vy = (vy / l) * sizeOverY;
      }
      vx = Math.max(-sizeOverX, Math.min(sizeOverX, vx));
      vy = Math.max(-sizeOverY, Math.min(sizeOverY, vy));
      out.push({
        x: sizeOverX + vx, y: sizeOverY + vy, w: iw, h: ih,
        iconUrl: icon ? icon.url : null, over: false, color: c, label: null,
      });
    };
    {
      const found: import('../engine/octree').OctItem[] = [];
      this.map.octree.sphereSelectInteractive(sel.sx, sel.sy, sel.sz, 256, found);
      for (const o of found) {
        if (o instanceof SpaceObject && sel.team.enemys.includes(o.team) && !(o instanceof Base)) {
          pushPointer(o);
        }
      }
    }
    for (const t of sel.team.allies) {
      for (const ob of t.objects) {
        if (ob !== sel) pushPointer(ob);
      }
    }
    if (this.map.path.length > 0) pushPointer(this.map.path[0]);
    for (const t of sel.team.enemys) {
      if (t.base) pushPointer(t.base);
      if (t.flag && t.flag.getOwner() !== sel) pushPointer(t.flag);
    }
    // King of the System: mark the scoring region (the sun at its centre) so
    // it can be found from anywhere in the arena, clamped to the screen edge
    // exactly like the base pointers.
    const region = this.map.region;
    if (region) {
      const f2 = this.renderer.frustum;
      let tx = region.pos[0];
      let ty = region.pos[1];
      let tz = region.pos[2];
      const toObj = vec3.fromValues(tx - cam.position[0], ty - cam.position[1], tz - cam.position[2]);
      if (vec3.dot(toObj, cam.direction) < 0) {
        const n = vec3.fromValues(f2[20], f2[21], f2[22]);
        const d = vec3.dot(vec3.fromValues(tx, ty, tz), n);
        tx -= 2 * d * n[0];
        ty -= 2 * d * n[1];
        tz -= 2 * d * n[2];
      }
      const p = this.project(tx, ty, tz);
      const icon = this.rc.tex('_kots');
      const iw = 48;
      const ih = 48;
      let sx = p.x;
      let sy = p.y;
      if (!frustumContains(f2, region.pos[0], region.pos[1], region.pos[2])) {
        const cl = this.myClamp(sx, sy, iw / 2, ih / 2);
        sx = cl.x;
        sy = cl.y;
      }
      out.push({
        x: sx, y: sy, w: iw, h: ih,
        iconUrl: icon ? icon.url : null, over: false,
        color: [0.55, 1, 0.65], label: null,
      });
    }
    return out;
  }

  private myClamp(px: number, py: number, hx: number, hy: number): { x: number; y: number } {
    const minx = hx, miny = hy;
    const maxx = this.canvasW - hx, maxy = this.canvasH - hy;
    const dimx = maxx - minx, dimy = maxy - miny;
    const midx = (minx + maxx) / 2, midy = (miny + maxy) / 2;
    let vx = px - midx, vy = py - midy;
    const l = Math.hypot(vx, vy) || 1;
    vx /= l;
    vy /= l;
    const vyx = (vx / Math.abs(vy)) * (dimy / 2);
    const vyy = (vy / Math.abs(vy)) * (dimy / 2);
    const vxx = (vx / Math.abs(vx)) * (dimx / 2);
    const vyx2 = (vy / Math.abs(vx)) * (dimx / 2);
    const useX = Math.abs(vyx2) < dimy / 2;
    return { x: midx + (useX ? vxx : vyx), y: midy + (useX ? vyx2 : vyy) };
  }

  aimPos(): { x: number; y: number } {
    const sel = this.selectedObject;
    if (!sel) return { x: this.canvasW / 2, y: this.canvasH / 2 };
    const d = this.rc.options.distance;
    return this.project(
      sel.pos[0] + sel.dir[0] * d, sel.pos[1] + sel.dir[1] * d, sel.pos[2] + sel.dir[2] * d,
    );
  }

  scoreText(): string {
    return this.getGameScore().toVisualIngame(this.gameType);
  }
}

export type { ScoreEntry };
