// Jev: the strong, expensive second stage. Same prompt and reply format as the openrouter
// decider, pointed at TypeSafe's Jev router on OpenRouter by default.
//
//   JEV_API_KEY        falls back to OPENROUTER_API_KEY
//   JEV_MODEL          default typesafe/jev-router
//   OPENROUTER_BASE_URL, CLOUDFRIEND_DECIDER_INSTRUCTIONS, CLOUDFRIEND_EVENT_CHARS as for openrouter
import { defineDecider } from "../../types.ts";
import { apiKey, complete, type ChatDefaults } from "./openrouter.ts";

export const JEV: ChatDefaults = { keyVar: "JEV_API_KEY", modelVar: "JEV_MODEL", model: "typesafe/jev-router", title: "cloudfriend" };

export default defineDecider({
  enabled: (env) => Boolean(apiKey(env, JEV)),
  async decide(events, { env, signal, openFlags }) {
    const { flags, judgments, record } = await complete(events, env, signal, JEV, openFlags);
    return { flags, judgments, record };
  },
});
