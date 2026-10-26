<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useData } from "vitepress";

const props = defineProps<{ code: string }>();
const { isDark } = useData();
const svg = ref("");

async function render() {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: isDark.value ? "dark" : "neutral",
    // SVG text instead of HTML labels, so VitePress's typography can't change label sizes after layout.
    htmlLabels: false,
  });
  const id = "mermaid-" + Math.random().toString(36).slice(2);
  svg.value = (await mermaid.render(id, decodeURIComponent(props.code))).svg;
}

onMounted(render);
watch(isDark, render);
</script>

<template>
  <div class="mermaid-diagram" v-html="svg" />
</template>
