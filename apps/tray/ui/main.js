// No bundler here on purpose: this window is a status readout, not an app.
// `withGlobalTauri` exposes the invoke bridge directly.
const { invoke } = window.__TAURI__.core;

const $ = (id) => document.getElementById(id);
const result = $("result");

function say(message, isError = false) {
  result.textContent = message;
  result.classList.toggle("error", isError);
}

async function refresh() {
  const status = await invoke("get_status");
  $("version").textContent = `v${status.version}`;
  $("server").textContent = status.server ?? "not configured";
  $("autostart").checked = status.autostart;
}

$("check").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  say("Checking…");
  try {
    say(await invoke("check_for_updates"));
  } catch (err) {
    say(String(err), true);
  } finally {
    button.disabled = false;
  }
});

$("autostart").addEventListener("change", async (event) => {
  const enabled = event.currentTarget.checked;
  try {
    await invoke("set_autostart", { enabled });
  } catch (err) {
    event.currentTarget.checked = !enabled;
    say(String(err), true);
  }
});

refresh().catch((err) => say(String(err), true));
