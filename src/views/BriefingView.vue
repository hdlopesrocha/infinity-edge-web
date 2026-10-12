<!-- MenuXML briefing: high scores (LoadScores) left, description.text right,
     _buttonRU "start" launches the level. -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import MenuShell from '../components/MenuShell.vue';
import { LEVELS, trackLabel } from '../game/levels';
import { loadScores } from '../game/store';
import { GhostRecorder } from '../game/ghost';
import { audio } from '../game/audio';

const route = useRoute();
const router = useRouter();
const key = computed(() => String(route.params.level ?? ''));
const level = computed(() => LEVELS[key.value]);
const scores = computed(() => (level.value ? loadScores(level.value.save) : []));
const ghostSamples = ref(-1);

onMounted(async () => {
  if (!key.value) return;
  if (!GhostRecorder.has(key.value)) {
    ghostSamples.value = 0;
    return;
  }
  const g = await GhostRecorder.load(key.value);
  ghostSamples.value = g ? g.samples.length : 0;
});

function start(): void {
  audio.unlock();
  void audio.play('button');
  void router.push('/game/' + key.value);
}
</script>

<template>
  <MenuShell v-if="level" primary="start" :on-primary="start">
    <template #left>
      <div class="menu-title">{{ level.type }} — {{ level.type === 'TT' ? trackLabel(level.key) : level.title }}</div>
      <div class="menu-text">High Scores</div>
      <div class="menu-text small">
        <div v-if="!scores.length">No scores yet — fly!</div>
        <div v-for="(s, i) in scores" :key="i">{{ i + 1 }}. {{ s.user }} — {{ s.time }}</div>
        <div v-if="ghostSamples > 0">Ghost: {{ ghostSamples }} samples loaded.</div>
        <div v-else-if="ghostSamples === 0">Ghost: none recorded yet.</div>
      </div>
    </template>
    <template #right>
      <div class="menu-text">{{ level.text }}</div>
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
