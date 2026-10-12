// GameInstance port: level lifecycle, full Update order, Draw order
// (sky + map passes + ghost + HUD data), scoreboard/aim/pointers math,
// scores, Victory/Defeat resolution, ghost record/playback.

import { mat4, vec3 } from '../engine/math';
import type { Renderer } from '../engine/renderer';
import type { TexEntry } from '../engine/texture';
import { GameMap } from './map';
import type { DrawCtx } from './objects';
import { Ark, Base, Flag, SpaceObject, SpaceShip } from './objects';
import { Team, GameScore, Reward, CondDestroyed, CondMoreTime, CondLessTime, CondMorePoints, CondNoPath, parseTimeSpan } from './team';
import type { RewardType, ScoreEntry } from './team';
import { TEAMS } from './config';
import { Control } from './controls';
import { applyAction } from './ai';
import { loadScores, addScore } from './store';
import { loadGhostFile, saveGhostFile } from './ghost';
import type { GhostRecord } from './ghost';
import type { LevelDef } from './levels';
import type { RC } from './resources';

export type GameType = 'CTF' | 'TT' | 'BACK';

export interface PointerMark {
  x: number;
  y: number;
  size: number;
  iconUrl: string | null;
  over: boolean; // _over marker (in-frustum ship) vs icon marker
  color: [number, number, number];
  label: string | null; // life %
}

export class GameInstance {
  map!: GameMap;
  teams = new Map<string, Team>();
  objects = new Map<string, SpaceObject>();
  control = new Control();
  selectedObject: SpaceObject | null = null;
  goals: Reward[] = [];
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

  /** Build from converted Level JSON (EngineXML module order). */
  static async create(renderer: Renderer, rc: RC, def: LevelDef): Promise<GameInstance> {
    const gi = new GameInstance(renderer, rc);
    gi.levelKey = def.key;
    const t = def.description.type;
    gi.gameType = t === 'CTF' || t === 'TT' || t === 'BACK' ? t : 'BACK';
    gi.levelTitle = def.description.name;
    gi.levelText = def.description.text;
    gi.savefile = def.description.save;
    gi.ghostFile = def.importGhost ?? null;
    gi.map = new GameMap(def.description.sky, def.description.size || 2048);
    gi.map.rng = rc.random;
    // preload models + HUD textures
    const modelNames = new Set<string>([def.description.sky]);
    for (const o of def.objects) {
      if (o.model) modelNames.add(o.model);
    }
    modelNames.add('Bullet');
    modelNames.add('HomingMissile2');
    modelNames.add('Base');
    // dynamically spawned: addon drops, bullet/homing visuals, fallback
    modelNames.add('adHomingMissile');
    modelNames.add('adRepair');
    modelNames.add('adShield');
    modelNames.add('adNitro');
    modelNames.add('Wheel');
    await rc.preload([...modelNames], [
      'flare1', 'flare3', 'holoSmoke1', 'holoSmoke2', 'holoSmoke3', 'holoSmoke4',
      'holoSmoke5', 'holoSmoke6', 'holoSmoke7', 'hexagon', 'aim', 'over',
      'Fighter1_icon', 'Fighter2_icon', 'Fighter3_icon', 'Ark_icon', 'Base_icon', 'Flag_icon',
    ]);
    // sky
    const sky = rc.model(def.description.sky);
    if (sky) {
      gi.skyGpu = sky.gpu;
      gi.skyTex = sky.tex;
    }
    // teams + diplomacies (TeamConfig: human/ambient/alien; human<>alien enemies)
    for (const t of TEAMS) gi.teams.set(t.name, new Team(t.name, [...t.color] as [number, number, number]));
    const human = gi.teams.get('human')!;
    const alien = gi.teams.get('alien')!;
    human.enemys.push(alien);
    alien.enemys.push(human);
    // objects (factory) then rotation path
    for (const o of def.objects) {
      gi.map.buildObject(
        { team: o.team, type: o.type, model: o.model, position: o.position, name: o.name, life: o.life, amount: o.amount },
        gi,
      );
    }
    gi.map.setRotationPath();
    // camera
    if (def.camara.name === 'LookAtObject') {
      const obj = gi.objects.get(def.camara.value) as SpaceObject | undefined;
      if (obj) gi.selectedObject = obj;
    } else {
      const v = def.camara.value.split('|').map(Number);
      gi.cameraTarget = vec3.fromValues(v[0] || 0, v[1] || 0, v[2] || 0);
    }
    renderer.camera.far = rc.options.distance;
    // actions
    for (const a of def.actions) applyAction(gi, a.name, a.from, a.to ?? null);
    // goals (XM_Goals mapping verbatim)
    for (const g of def.goals) {
      const reward = (
        g.reward === 'Gold' || g.reward === 'Silver' || g.reward === 'Bronze' ||
        g.reward === 'Victory' || g.reward === 'Defeat' ? g.reward : 'None'
      ) as RewardType;
      const r = new Reward(reward, g.message ?? null);
      for (const goal of g.goals) {
        if (goal.name === 'NoPath') r.addCondition(new CondNoPath());
        else if (goal.name === 'LessTime') r.addCondition(new CondLessTime(parseTimeSpan(goal.value ?? '00:00:00')));
        else if (goal.name === 'MoreTime') r.addCondition(new CondMoreTime(parseTimeSpan(goal.value ?? '00:00:00')));
        else if (goal.name === 'Destroyed') {
          r.addCondition(new CondDestroyed((gi.objects.get(goal.value ?? '') as SpaceObject | undefined) ?? null));
        } else if (goal.name === 'MorePoints') {
          const t = gi.teams.get(goal.value ?? '');
          if (t) r.addCondition(new CondMorePoints(t));
        }
      }
      gi.goals.push(r);
    }
    // best ghost (importGhost file from previous victories)
    if (gi.ghostFile) {
      const best = await loadGhostFile(gi.ghostFile);
      if (best) gi.bestGhostRecords = best;
    }
    // initial camera
    gi.snapCamera(16);
    return gi;
  }

  setNotification(voiceField: string): void {
    const text = this.rc.playVoice(voiceField);
    this.notificationTime = 3000;
    this.notificationText = text;
  }

  // ------------------------------------------------------------ update
  update(dtMs: number): void {
    this.dtMs = dtMs;
    const rc = this.rc;
    if (this.gameType === 'BACK') {
      this.map.update(this, dtMs);
      this.renderer.camera.lookAtPositionAuto(this.cameraTarget, dtMs);
      return;
    }
    if (this.finished) return;
    this.control.update(this.canvasW, this.canvasH);
    this.updateObjectUI();
    // team clocks + ship ticks (copy; skip Flags)
    for (const t of this.teams.values()) {
      if (t.base) {
        const found: import('../engine/octree').OctItem[] = [];
        this.map.octree.sphereSelectInteractive(
          t.base.sx, t.base.sy, t.base.sz, t.base.sradius, found,
        );
        if (found.length === 1 || this.gameType !== 'TT') {
          t.timeMs += dtMs;
        }
      }
      const list = [...t.objects];
      for (const ob of list) {
        if (!(ob instanceof Flag)) ob.automaticAction(this, dtMs);
      }
    }
    this.map.update(this, dtMs);
    // camera follow
    if (this.selectedObject) {
      const o = this.selectedObject;
      this.renderer.camera.lookAtObject(
        o.pos, o.dir, o.side, o.rot,
        { stickX: this.control.analogStick.value.x, stickY: this.control.analogStick.value.y },
        rc.options.axisX, rc.options.axisY, rc.options.distance,
      );
    }
    // notification timeout
    this.notificationTime -= dtMs;
    if (this.notificationTime < 0) {
      this.notificationTime = 0;
      this.notificationText = '';
    }
    // flags tick after ships
    for (const t of this.teams.values()) {
      if (t.flag) t.flag.automaticAction(this, dtMs);
    }
    // goals
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

  /** UpdateObjectUI verbatim: ghost record + Team.Manage + nitro + UI sync. */
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
      const best = this.addScore();
      if (best && this.ghostFile) saveGhostFile(this.ghostFile, this.ghostRecords);
    }
  }

  getGameScore(): GameScore {
    const gs = new GameScore();
    for (const t of this.teams.values()) {
      if (t.objects.length > 0 && this.selectedObject) {
        gs.scores.push({
          name: t.name,
          points: t.points,
          timeMs: t.timeMs,
          control: t === this.selectedObject.team,
        });
      }
    }
    return gs;
  }

  /** AddScore verbatim: persist top 10, true if new best. */
  addScore(): boolean {
    const gs = this.getGameScore();
    return addScore(gs, this.gameType === 'TT' ? 'TT' : 'CTF', this.savefile);
  }

  // -------------------------------------------------------------- draw
  draw(): void {
    const r = this.renderer;
    const d: DrawCtx = {
      draw: r.draw, view: r.camera.view, proj: r.camera.proj, camPos: r.camera.position, rc: this.rc,
    };
    if (this.gameType === 'BACK') {
      this.drawSky();
      this.map.draw(d);
      return;
    }
    // MAP DRAW WITHOUT SKY (map pass), then ghost, then sky behind (same
    // visual result as the render-target composite)
    this.drawSky();
    this.map.draw(d);
    this.drawGhost(d);
    void d;
  }

  private drawSky(): void {
    if (!this.skyGpu) return;
    const r = this.renderer;
    const draw = r.draw;
    draw.setNoDepth();
    draw.setCull('none');
    const m = mat4.create();
    mat4.fromTranslation(m, r.camera.position);
    draw.drawUnlit(this.skyGpu, this.skyTex, m, r.camera.view, r.camera.proj, [0.55, 0.6, 0.75], 1);
    r.trackDraws(this.skyGpu.meshes.length);
    draw.setCull('back');
    draw.setDepth();
  }

  private drawGhost(d: DrawCtx): void {
    const sel = this.selectedObject;
    if (!sel || this.bestGhostRecords.length === 0) return;
    while (
      this.bestGhostRecords.length > 1 &&
      this.bestGhostRecords[0].timeMs < sel.team.timeMs
    ) {
      this.bestGhostRecords.shift();
    }
    const gr = this.bestGhostRecords[0];
    const m = mat4.create();
    const s = vec3.fromValues(sel.scale, sel.scale, sel.scale);
    mat4.fromRotationTranslationScale(m, gr.rot, gr.pos, s);
    d.draw.drawModel(sel.model.gpu, sel.model.tex, m, d.view, d.proj, d.camPos, {
      alpha: 0.5, emissive: [0, 0, 0], light: true,
    });
    d.rc.renderer.trackDraws(sel.model.gpu.meshes.length);
  }

  // -------------------------------------------------------- HUD math
  snapCamera(dtMs: number): void {
    if (this.gameType === 'BACK' || !this.selectedObject) {
      this.renderer.camera.lookAtPositionAuto(this.cameraTarget, 100000);
      void dtMs;
      return;
    }
    const o = this.selectedObject;
    this.renderer.camera.lookAtObject(
      o.pos, o.dir, o.side, o.rot,
      { stickX: 0, stickY: 0 },
      this.rc.options.axisX, this.rc.options.axisY, this.rc.options.distance,
    );
  }

  /** Viewport.Project port. */
  project(px: number, py: number, pz: number): { x: number; y: number; behind: boolean } {
    const cam = this.renderer.camera;
    const m = mat4.create();
    mat4.multiply(m, cam.proj, cam.view);
    const a = m as unknown as Float32Array;
    const cx = a[0] * px + a[4] * py + a[8] * pz + a[12];
    const cy = a[1] * px + a[5] * py + a[9] * pz + a[13];
    const cw = a[3] * px + a[7] * py + a[11] * pz + a[15];
    const nx = cx / cw;
    const ny = cy / cw;
    return {
      x: (nx * 0.5 + 0.5) * this.canvasW,
      y: (1 - (ny * 0.5 + 0.5)) * this.canvasH,
      behind: cw < 0,
    };
  }

  frustumContains(px: number, py: number, pz: number): boolean {
    // MyFrustumContains verbatim: Near/Bottom/Top/Left/Right only (far excluded)
    const f = this.renderer.frustum;
    for (const i of [0, 1, 2, 3, 5]) {
      if (f[i * 4] * px + f[i * 4 + 1] * py + f[i * 4 + 2] * pz + f[i * 4 + 3] >= 0) return false;
    }
    return true;
  }

  /** DrawPointer port: returns DOM-ready markers for the HUD overlay. */
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
            x: p.x, y: p.y, size: 48, iconUrl: null, over: true,
            color: obj.team.color, label: Math.floor(obj.lifePercentage() * 100) + '%',
          });
          return;
        }
        if (obj instanceof Ark) return;
      }
      // icon marker (near-plane reflect when behind, like DrawPointer)
      let tx = obj.pos[0], ty = obj.pos[1], tz = obj.pos[2];
      const toObj = vec3.fromValues(tx - cam.position[0], ty - cam.position[1], tz - cam.position[2]);
      const fwd = cam.direction;
      if (vec3.dot(toObj, fwd) < 0) {
        // reflect across the near plane (plane index 5 in our layout)
        const n = vec3.fromValues(f[20], f[21], f[22]);
        const d = vec3.dot(toObj, n);
        tx -= 2 * d * n[0];
        ty -= 2 * d * n[1];
        tz -= 2 * d * n[2];
      }
      const p = this.project(tx, ty, tz);
      let sx = p.x, sy = p.y;
      const icon = obj.model.icon;
      const iw = icon ? icon.width : 32;
      const ih = icon ? icon.height : 32;
      if (!this.frustumContains(obj.pos[0], obj.pos[1], obj.pos[2])) {
        const cl = this.myClamp(sx, sy, iw / 2, ih / 2);
        sx = cl.x;
        sy = cl.y;
      }
      let c: [number, number, number] = [...obj.team.color] as [number, number, number];
      if (!(obj instanceof Base) && !(obj instanceof Flag) && !(obj instanceof Ark)) {
        c = [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5];
      }
      // ellipse rule
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
        x: sizeOverX + vx, y: sizeOverY + vy, size: Math.max(iw, ih),
        iconUrl: icon ? icon.url : null, over: false, color: c, label: null,
      });
    };
    // near enemies (256 radius, non-Base)
    {
      const found: import('../engine/octree').OctItem[] = [];
      this.map.octree.sphereSelectInteractive(sel.sx, sel.sy, sel.sz, 256, found);
      for (const o of found) {
        if (o instanceof SpaceObject && sel.team.enemys.includes(o.team) && !(o instanceof Base)) {
          pushPointer(o);
        }
      }
    }
    // allies (all objects except selected)
    for (const t of sel.team.allies) {
      for (const ob of t.objects) {
        if (ob !== sel) pushPointer(ob);
      }
    }
    // next ark gate
    if (this.map.path.length > 0) pushPointer(this.map.path[0]);
    // enemy bases + carried enemy flags
    for (const t of sel.team.enemys) {
      if (t.base) pushPointer(t.base);
      if (t.flag && t.flag.getOwner() !== sel) pushPointer(t.flag);
    }
    return out;
  }

  /** MyClamp verbatim: clamp a point to a rect along the center ray. */
  private myClamp(px: number, py: number, hx: number, hy: number): { x: number; y: number } {
    const minx = hx, miny = hy;
    const maxx = this.canvasW - hx, maxy = this.canvasH - hy;
    const dimx = maxx - minx, dimy = maxy - miny;
    const midx = (minx + maxx) / 2, midy = (miny + maxy) / 2;
    let vx = px - midx, vy = py - midy;
    const l = Math.hypot(vx, vy) || 1;
    vx /= l;
    vy /= l;
    // vy_vec = (vec / |vec.Y|) * dimY/2 ; vx_vec = (vec / |vec.X|) * dimX/2
    const vyx = (vx / Math.abs(vy)) * (dimy / 2);
    const vyy = (vy / Math.abs(vy)) * (dimy / 2);
    const vxx = (vx / Math.abs(vx)) * (dimx / 2);
    const vyx2 = (vy / Math.abs(vx)) * (dimx / 2);
    const useX = Math.abs(vyx2) < dimy / 2;
    return { x: midx + (useX ? vxx : vyx), y: midy + (useX ? vyx2 : vyy) };
  }

  /** Aim marker: project(selected.pos + dir * distance). */
  aimPos(): { x: number; y: number } {
    const sel = this.selectedObject;
    if (!sel) return { x: this.canvasW / 2, y: this.canvasH / 2 };
    const d = this.rc.options.distance;
    const p = this.project(
      sel.pos[0] + sel.dir[0] * d, sel.pos[1] + sel.dir[1] * d, sel.pos[2] + sel.dir[2] * d,
    );
    return { x: p.x, y: p.y };
  }

  scoreText(): string {
    return this.getGameScore().toVisual(this.gameType);
  }
}

export type { ScoreEntry };
