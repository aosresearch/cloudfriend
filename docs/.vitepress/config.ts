import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Sieve",
  description: "Live event triage in one container: events in, a model flags what matters, actions fire on the flags.",
  // Served from cloudfriend.dev/docs/. Set DOCS_BASE=/ to host at a domain root.
  base: process.env.DOCS_BASE ?? "/docs/",
  // Pages are emitted as `page.html` and linked that way, so a plain S3/CloudFront origin serves
  // them without rewrite rules.
  cleanUrls: false,
  themeConfig: {
    nav: [{ text: "cloudfriend.dev", link: "https://cloudfriend.dev" }],
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
