<!-- Multiplayer lobby: the whole view is painted into the WebGL frame
     (renderer.uiOverlay -> src/game/mp/lobbyui.ts), so this component renders
     no HTML at all - it only wires pointer/wheel input and navigation. -->
<script lang="ts">
import { defineComponent, onBeforeUnmount, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import type { Renderer } from '../engine/renderer';
import { LobbyUi } from '../game/mp/lobbyui';
import { mp, mpTraceMark } from '../game/mp/manager';
import { store } from '../game/store';
import { goBack } from '../game/nav';
import { audio } from '../game/audio';
import type { RoomInfo } from '../game/nostr/event';

export default defineComponent({
  name: 'MultiplayerView',
  // Renders nothing: the lobby lives in the WebGL frame, not the DOM.
  setup() {
const router = useRouter();
let lobby: LobbyUi | null = null;
let canvas: HTMLCanvasElement | null = null;

function renderer(): Renderer | null {
  return (window as unknown as { __ieRenderer?: Renderer }).__ieRenderer ?? null;
}

function onLobbyChange(): void {
  lobby?.bump();
}

/** Publish the room, then drop straight into the match as the host. */
function startHost(level: string, type: string, title: string, maxPlayers: number): void {
  audio.unlock();
  void audio.sfx('button');
  if (!lobby) return;
  lobby.joining = 'creating the room';
  lobby.bump();
  void (async () => {
    try {
      await mp.createRoom({ game: level, type, title, maxPlayers });
      store.levelText = '';
      await router.push('/game/' + level);
    } catch {
      /* the status line shows the reason */
    } finally {
      if (lobby) {
        lobby.joining = null;
        lobby.bump();
      }
    }
  })();
}

/** Connect to a listed room's host and join their match. */
function join(room: RoomInfo): void {
  audio.unlock();
  void audio.sfx('button');
  if (!lobby) return;
  lobby.joining = room.host;
  lobby.bump();
  mpTraceMark('view.join', room.id);
  void (async () => {
    try {
      await mp.joinRoom(room);
      mpTraceMark('view.joined', room.id);
      store.levelText = '';
      await router.push('/game/' + room.game);
      mpTraceMark('view.pushed', location.hash);
    } catch {
      /* the status line shows the reason */
    } finally {
      if (lobby) {
        lobby.joining = null;
        lobby.bump();
      }
    }
  })();
}

function deleteRoom(room: RoomInfo): void {
  audio.unlock();
  void audio.sfx('button');
  void mp.deleteRoom(room).then(() => lobby?.bump());
}

function back(): void {
  audio.unlock();
  void audio.sfx('button');
  mp.cancelJoin();
  goBack(router, '/menu');
}

// ------------------------------------------------------------ input plumbing
function canvasRect(): { x: number; y: number; w: number; h: number } | null {
  const c = canvas;
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.left, y: r.top, w: Math.max(1, r.width), h: Math.max(1, r.height) };
}

function onPointer(kind: 'move' | 'down' | 'up') {
  return (e: PointerEvent): void => {
    const rect = canvasRect();
    if (!rect || !lobby) return;
    if (kind === 'down') audio.unlock();
    lobby.pointer(kind, e.clientX - rect.x, e.clientY - rect.y, rect.w, rect.h);
  };
}

function onWheel(e: WheelEvent): void {
  const rect = canvasRect();
  if (!rect || !lobby) return;
  if (lobby.wheel(e.deltaY, e.clientX - rect.x, e.clientY - rect.y, rect.w, rect.h)) e.preventDefault();
}

function onKey(e: KeyboardEvent): void {
  if (e.code === 'Escape') back();
}

const onMove = onPointer('move');
const onDown = onPointer('down');
const onUp = onPointer('up');

onMounted(() => {
  const r = renderer();
  canvas = r?.canvas ?? null;
  lobby = new LobbyUi({ startHost, join, deleteRoom, back }, mp);
  if (r) r.uiOverlay = lobby;
  mp.onChange = onLobbyChange;
  mp.onGuests = onLobbyChange;
  void mp.connect();
  canvas?.addEventListener('pointermove', onMove);
  canvas?.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  canvas?.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  if (renderer()) renderer()!.uiOverlay = null;
  mp.onChange = null;
  mp.onGuests = null;
  canvas?.removeEventListener('pointermove', onMove);
  canvas?.removeEventListener('pointerdown', onDown);
  window.removeEventListener('pointerup', onUp);
  canvas?.removeEventListener('wheel', onWheel);
  window.removeEventListener('keydown', onKey);
  lobby = null;
});

    return () => null;
  },
});
</script>
