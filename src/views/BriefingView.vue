<!-- MenuXML briefing: high scores left, description right, start button. -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import MenuShell from '../components/MenuShell.vue';
import { loadLevel, trackLabel } from '../game/levels';
import type { LevelDef } from '../game/levels';
import { loadScores } from '../game/store';
import { hasGhostFile } from '../game/ghost';
import { audio } from '../game/audio';

const route = useRoute();
const router = useRouter();
const key = String(route.params.level ?? '');
const level = ref<LevelDef | null>(null);
const scores = ref<string[]>([]);
const ghostNote = ref('');

onMounted(async () => {
  try {
    const def = await loadLevel(key);
    level.value = def;
    const type = def.description.type === 'TT' ? 'TT' : 'CTF';
    scores.value = loadScores(type, def.description.save).map((g) => g.toVisual(type));
    if (def.importGhost && hasGhostFile(def.importGhost)) {
      ghostNote.value = 'Ghost: active rival recording.';
    }
  } catch {
    level.value = null;
  }
});

function start(): void {
  audio.unlock();
  void audio.sfx('button');
  void router.push('/game/' + key);
}
</script>

<template>
  <MenuShell v-if="level" primary="start" :on-primary="start">
    <template #left>
      <div class="menu-title">{{ level.description.type }} — {{ level.description.type === 'TT' ? trackLabel(level.key) : level.description.name }}</div>
      <div class="menu-text">High Scores</div>
      <div class="menu-text small">
        <div v-if="!scores.length">No scores yet — fly!</div>
        <div v-for="(s, i) in scores" :key="i">{{ i + 1 }}. {{ s }}</div>
        <div v-if="ghostNote">{{ ghostNote }}</div>
      </div>
    </template>
    <template #right>
      <div class="menu-text">{{ level.description.text }}</div>
      <div class="menu-text small">
        <div v-for="(g, i) in level.goals" :key="i">
          {{ g.reward }}<span v-if="g.message">: {{ g.message }}</span>
          <span v-for="goal in g.goals" :key="goal.name"> · {{ goal.name }}<span v-if="goal.value"> {{ goal.value }}</span></span>
        </div>
      </div>
    </template>
  </MenuShell>
  <MenuShell v-else primary="menu" primary-to="/menu">
    <template #left><div class="menu-title">Unknown level</div></template>
    <template #right><div class="menu-text">This briefing does not exist.</div></template>
  </MenuShell>
</template>
