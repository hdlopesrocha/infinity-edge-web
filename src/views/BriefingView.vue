<!-- Briefing = level Menu.xml: scoreBoard left (10 rows), textBox right,
     RU "start" -> Level.xml. Level text comes from the Level description. -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import MenuShell from '../components/MenuShell.vue';
import { loadLevel } from '../game/levels';
import { loadScores } from '../game/store';
import { audio } from '../game/audio';

const route = useRoute();
const router = useRouter();
const key = String(route.params.level ?? '');
const text = ref('');
const scores = ref<string[]>([]);
const loaded = ref(false);

onMounted(async () => {
  try {
    const def = await loadLevel(key);
    text.value = def.menuText ?? def.description.text;
    const type = def.description.type === 'TT' ? 'TT' : 'CTF';
    const sb = def.scoreBoard ?? { type, save: def.description.save };
    const list = loadScores(type, sb.save);
    const rows: string[] = [];
    list.forEach((g) => rows.push(g.toVisual(type)));
    while (rows.length < 10) rows.push('');
    scores.value = rows;
    loaded.value = true;
  } catch {
    loaded.value = false;
  }
});

function start(): void {
  audio.unlock();
  void audio.sfx('button');
  void router.push('/game/' + key);
}

const hasLevel = computed(() => loaded.value);
</script>

<template>
  <MenuShell v-if="hasLevel" primary="start" :on-primary="start">
    <template #left>
      <div class="f-small c-white" style="text-align: left; width: 100%;">High Scores<br /></div>
      <div class="f-small c-white" style="text-align: left; width: 100%;">
        <div v-for="(s, i) in scores" :key="i">{{ (i + 1) + ' - ' + s }}</div>
      </div>
    </template>
    <template #right>
      <div class="f-middle c-white">{{ text }}</div>
    </template>
  </MenuShell>
  <MenuShell v-else wide>
    <template #left></template>
  </MenuShell>
</template>
