// No bundler here on purpose: this window is a status readout and a one-time
// enrollment form, not an app. `withGlobalTauri` exposes the invoke bridge.
const { invoke } = window.__TAURI__.core;

const $ = (id) => document.getElementById(id);
const result = $("result");

function say(message, isError = false) {
  result.textContent = message;
  result.classList.toggle("error", isError);
}

async function refresh() {
  const status = await invoke("get_status");

  $("enroll-view").hidden = status.enrolled;
  $("status-view").hidden = !status.enrolled;

  $("version").textContent = `v${status.version}`;
  $("server").textContent = status.serverName
    ? `${status.serverName} — ${status.serverUrl}`
    : (status.serverUrl ?? "not configured");
  $("device").textContent = status.deviceId ?? "—";
  $("autostart").checked = status.autostart;
}

$("enroll-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const button = $("enroll-button");
  button.disabled = true;
  say("Joining…");

  try {
    const enrolled = await invoke("enroll", {
      serverUrl: $("server-url").value,
      passphrase: $("passphrase").value,
    });

    // Clear it immediately — the passphrase has done its only job, and leaving
    // it sitting in a form field serves nobody.
    $("passphrase").value = "";

    say(`Joined ${enrolled.serverName} as ${enrolled.displayName}.`);
    if (enrolled.probableReenrollmentOf) {
      say(
        `Joined ${enrolled.serverName} as ${enrolled.displayName}. ` +
          `This looks like a re-install of a device already on the server — ` +
          `merge or remove the old record there.`,
      );
    }
    await refresh();
  } catch (err) {
    say(String(err), true);
  } finally {
    button.disabled = false;
  }
});

$("unenroll").addEventListener("click", async () => {
  try {
    await invoke("unenroll");
    say("Left the fleet. The device record on the server still exists — remove it there.");
    await refresh();
  } catch (err) {
    say(String(err), true);
  }
});

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
