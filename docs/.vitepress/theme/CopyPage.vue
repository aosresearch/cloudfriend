<script setup lang="ts">
import { computed, ref } from "vue";
import { useData } from "vitepress";

// The Markdown source of every page, so "Copy page" pastes clean Markdown rather than rendered text.
const sources = import.meta.glob<string>(["../../*.md", "../../architecture/*.md"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const { page } = useData();
const markdown = computed(() =>
  (sources[`../../${page.value.relativePath}`] ?? "").replace(/^---\n[\s\S]*?\n---\n+/, ""),
);

const state = ref<"idle" | "copied" | "failed">("idle");
const label = computed(() => ({ idle: "Copy page", copied: "Copied", failed: "Copy failed" })[state.value]);
let reset: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  try {
    await navigator.clipboard.writeText(markdown.value);
    state.value = "copied";
  } catch {
    state.value = "failed";
  }
  clearTimeout(reset);
  reset = setTimeout(() => (state.value = "idle"), 2000);
}
</script>

<template>
  <div v-if="markdown" class="copy-page">
    <button type="button" :class="state" title="Copy this page as Markdown" @click="copy">
      <svg v-if="state === 'copied'" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
      <svg v-else viewBox="0 0 24 24" aria-hidden="true">
        <rect x="9" y="9" width="12" height="12" rx="2" />
        <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
      </svg>
      <span aria-live="polite">{{ label }}</span>
    </button>
  </div>
</template>
