import { defineConfig } from "vitepress";

export default defineConfig({
  title: "cloudfriend",
  description: "Live event triage in one container: events in, a model flags what matters, actions fire on the flags.",
  // Served at the root of docs.cloudfriend.dev. Links drop `.html`; the CDN maps `/page` to `page.html`.
  cleanUrls: true,
  themeConfig: {
    nav: [{ text: "cloudfriend.dev", link: "https://cloudfriend.dev" }],
    socialLinks: [{ icon: "github", link: "https://github.com/aosresearch/cloudfriend" }],
    sidebar: [
      { text: "Setup", link: "/" },
      {
        text: "Architecture",
        link: "/architecture",
        items: [
          { text: "Intake", link: "/architecture/intake" },
          { text: "Process", link: "/architecture/process" },
          { text: "Delivery", link: "/architecture/delivery" },
        ],
      },
    ],
    outline: [2, 3],
    search: { provider: "local" },
  },
  markdown: {
    config(md) {
      // ```mermaid fences render as diagrams in the browser; the copied page keeps the source.
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, idx, ...rest) => {
        const token = tokens[idx]!;
        if (token.info.trim() === "mermaid") return `<Mermaid code="${encodeURIComponent(token.content)}" />`;
        return fence(tokens, idx, ...rest);
      };
    },
  },
});
