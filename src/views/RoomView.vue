<!-- Waiting-room view: the match does not start when the room is created.
     Host and guests sit here (WebGL only, like the lobby), chat, toggle the
     microphone and pick teams; the host's PLAY starts the match for everyone. -->
<script lang="ts">
import { defineComponent, onBeforeUnmount, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import type { Renderer } from '../engine/renderer';
import { RoomUi } from '../game/mp/roomui';
import { mp } from '../game/mp/manager';
import { VoiceChat } from '../game/mp/voice';
import { audio } from '../game/audio';

export default defineComponent({
  name: 'RoomView',
  setup() {
    const router = useRouter();
    let ui: RoomUi | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let caretTimer = 0;
    let caret = true;
    let started = false;
    let leaving = false;
    const voice = new VoiceChat();

    function renderer(): Renderer | null {
      return (window as unknown as { __ieRenderer?: Renderer }).__ieRenderer ?? null;
    }

    function toggleMic(): void {
      audio.unlock();
      void (async () => {
        if (voice.enabled) {
          voice.disable();
          mp.setMic(false);
          ui?.bump();
          return;
        }
        const ok = await voice.enable();
        mp.setMic(ok);
        ui?.bump();
      })();
    }

    function onFullscreenChange(): void {
      ui?.bump();
    }

    function refresh(): void {
      ui?.setSnapshot(mp.roomSnapshot());
      ui?.bump();
      // The host closed the room (or dropped us): back to the lobby.
      if (!started && !leaving && !mp.inRoom) {
        leaving = true;
        void router.replace('/multiplayer');
      }
    }

    function back(): void {
      if (leaving) return;
      leaving = true;
      audio.unlock();
      void audio.sfx('button');
      // Going back does NOT delete the hosted room: the host keeps it (and its
      // roster/chat) alive and can re-open it from the lobby. Closing is the
      // lobby's room-row DELETE (or leaving the hosted match). Guests just
      // leave the room.
      if (!mp.hosting) mp.leaveGuestRoom();
      void router.push('/multiplayer');
    }

    function play(): void {
      if (!mp.hosting) return;
      audio.unlock();
      void audio.sfx('button');
      // The bet is not escrowed: it is settled after the match (each losing
      // client pays the winners in sats over Lightning). Every pilot must
      // accept the stake before the host may start.
      void (async () => {
        const level = await mp.startMatch();
        if (!level) {
          refresh();
          return;
        }
        started = true;
        void router.push('/game/' + level);
      })();
    }

    // ------------------------------------------------------------ input
    function canvasRect(): { x: number; y: number; w: number; h: number } | null {
      if (!canvas) return null;
      const r = canvas.getBoundingClientRect();
      return { x: r.left, y: r.top, w: Math.max(1, r.width), h: Math.max(1, r.height) };
    }
    function pointer(kind: 'move' | 'down' | 'up', e: PointerEvent): void {
      const rect = canvasRect();
      if (!rect || !ui) return;
      if (kind === 'down') audio.unlock();
      ui.pointer(kind, e.clientX - rect.x, e.clientY - rect.y, rect.w, rect.h);
    }
    const onMove = (e: PointerEvent): void => pointer('move', e);
    const onDown = (e: PointerEvent): void => pointer('down', e);
    const onUp = (e: PointerEvent): void => pointer('up', e);
    function onWheel(e: WheelEvent): void {
      const rect = canvasRect();
      if (!ui || !rect) return;
      if (ui.wheel(e.deltaY, e.clientX - rect.x, e.clientY - rect.y, rect.w, rect.h)) e.preventDefault();
    }
    function onKey(e: KeyboardEvent): void {
      if (!ui) return;
      if (ui.key(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    onMounted(() => {
      if (!mp.inRoom) {
        void router.replace('/multiplayer');
        return;
      }
      const r = renderer();
      canvas = r?.canvas ?? null;
      ui = new RoomUi({
        play,
        back,
        setTeam: (index, team) => {
          mp.setPlayerTeam(index, team);
          refresh();
        },
        cycleBet: () => {
          mp.cycleBet();
          refresh();
        },
        toggleBetAccept: () => {
          mp.toggleBetAccept();
          refresh();
        },
        sendChat: (text) => mp.sendChat(text),
        toggleMic,
        micOn: () => voice.enabled,
        micLevel: () => voice.level(),
      });
      if (r) r.uiOverlay = ui;
      voice.onFrame = (pcm) => mp.sendVoice(pcm);
      mp.onVoice = (speaker, pcm) => voice.play(speaker, pcm);
      mp.onRoom = () => refresh();
      mp.onStart = (level) => {
        started = true;
        void router.push('/game/' + level);
      };
      refresh();
      // Caret blink + live mic meter (the meter needs a few repaints/s).
      caretTimer = window.setInterval(() => {
        caret = !caret;
        ui?.setCaret(caret && document.hasFocus());
        if (voice.enabled) ui?.bump();
      }, 180);
      canvas?.addEventListener('pointermove', onMove);
      canvas?.addEventListener('pointerdown', onDown);
      window.addEventListener('pointerup', onUp);
      canvas?.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('keydown', onKey, true);
      document.addEventListener('fullscreenchange', onFullscreenChange);
    });

    onBeforeUnmount(() => {
      window.clearInterval(caretTimer);
      canvas?.removeEventListener('pointermove', onMove);
      canvas?.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      canvas?.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      // Leaving the room screen must NOT tear down a hosted room: the host
      // keeps hostingRoom, its roster, chat and peers, and re-opens it later
      // (the lobby's room-row DELETE is the explicit teardown). Guests leave once.
      if (!leaving && !started && mp.inRoom && !mp.hosting) mp.leaveGuestRoom();
      voice.dispose();
      mp.onVoice = null;
      mp.onRoom = null;
      mp.onStart = null;
      if (renderer()) renderer()!.uiOverlay = null;
      ui = null;
    });

    return () => null;
  },
});
</script>
