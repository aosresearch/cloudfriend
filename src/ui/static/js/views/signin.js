import { api, BASE } from "../api.js";
import { h, replace } from "../dom.js";
import { field, notice, errorText } from "../components.js";
import { signedIn, state } from "../app.js";

export async function render(ctx) {
  ctx.setTitle("Sign in");
  const cfg = state.authConfig ?? { password: true, oidc: false };
  const email = h("input", { type: "email", name: "email", autocomplete: "username", required: true, spellcheck: "false" });
  const password = h("input", { type: "password", name: "password", autocomplete: "current-password", required: true });
  const out = h("div");
  const submit = h("button", { type: "submit", class: "btn primary wide" }, "Sign in");
  const form = h("form", { class: "form", novalidate: true }, field("Email", email), field("Password", password), out, submit);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    replace(out);
    if (!email.value.trim() || !password.value) {
      replace(out, notice("error", "Enter your email and password."));
      (email.value.trim() ? password : email).focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = "Signing in…";
    try {
      await api("login", { method: "POST", body: { email: email.value.trim(), password: password.value } });
      await signedIn();
    } catch (err) {
      replace(out, notice("error", err?.status === 401 ? "That email and password don't match an account." : errorText(err)));
      password.select();
      password.focus();
    } finally {
      submit.disabled = false;
      submit.textContent = "Sign in";
    }
  });

  const sso = cfg.oidc
    ? h("div", { class: "sso" }, h("a", { class: "btn wide", href: new URL("auth/oidc/login", BASE).href }, cfg.oidcLabel || "Sign in with SSO"), cfg.password !== false ? h("p", { class: "divider" }, h("span", null, "or")) : null)
    : null;

  replace(
    ctx.main,
    h(
      "div",
      { class: "card signin" },
      h("h1", null, "Sign in to cloudfriend"),
      sso,
      cfg.password !== false ? form : null,
      cfg.password !== false ? h("p", { class: "hint" }, "The first admin account is set when the server is installed. Ask your administrator if you don't have one.") : null,
    ),
  );
  (cfg.password !== false ? email : ctx.main.querySelector(".sso a"))?.focus();
}
