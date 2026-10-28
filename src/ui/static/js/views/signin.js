import { api, BASE } from "../api.js";
import { h, replace } from "../dom.js";
import { field, notice, errorText } from "../components.js";
import { signedIn, state } from "../app.js";

// Why an SSO sign-in came back without a session (the server redirects to /?auth_error=<code>).
const SSO_ERRORS = {
  sso_unverified: "Your identity provider didn't confirm your email address, so cloudfriend can't sign you in with it. Verify your email with the provider, or ask your administrator.",
  sso_denied: "Single sign-on was cancelled or refused, or your email domain isn't allowed here.",
  sso_failed: "Single sign-on didn't complete. Try again; if it keeps failing, ask your administrator to check the server's logs.",
};

/** Read and clear ?auth_error, so the message shows once and doesn't stick to the URL. */
function takeSsoError() {
  const params = new URLSearchParams(location.search);
  const code = params.get("auth_error");
  if (!code) return null;
  params.delete("auth_error");
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  return SSO_ERRORS[code] ?? SSO_ERRORS.sso_failed;
}

export async function render(ctx) {
  ctx.setTitle("Sign in");
  const ssoError = takeSsoError();
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
      ssoError ? notice("error", ssoError) : null,
      sso,
      cfg.password !== false ? form : null,
      cfg.password !== false ? h("p", { class: "hint" }, "The first admin account is set when the server is installed. Ask your administrator if you don't have one.") : null,
    ),
  );
  (cfg.password !== false ? email : ctx.main.querySelector(".sso a"))?.focus();
}
