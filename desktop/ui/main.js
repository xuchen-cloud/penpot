import { runtimeAction } from "./status.js";

const statusElement = document.querySelector("#status");
const detailsElement = document.querySelector("#details");
const indicatorElement = document.querySelector("#indicator");
const initializeForm = document.querySelector("#initialize");
const adminEmailInput = document.querySelector("#admin-email");
const initializeButton = initializeForm.querySelector("button");

async function invoke(command, args) {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke) {
    throw new Error("The desktop runtime is unavailable. Start this page through Tauri.");
  }
  return tauri.core.invoke(command, args);
}

function renderStatus(status) {
  statusElement.textContent = status.title;
  detailsElement.textContent = status.detail;
  indicatorElement.dataset.phase = status.phase;
  initializeForm.hidden = status.phase !== "not_initialized";
}

function openPenpot(status) {
  renderStatus(status);
  const action = runtimeAction(status);
  if (action?.publicUrl) {
    window.location.replace(action.publicUrl);
  }
}

async function refresh() {
  try {
    const status = await invoke("get_runtime_status");
    renderStatus(status);
    const action = runtimeAction(status);
    if (action?.command) {
      renderStatus({
        phase: "starting",
        title: "Starting Penpot",
        detail: "Preparing the private database and local services…",
      });
      openPenpot(await invoke(action.command));
    }
  } catch (error) {
    statusElement.textContent = "Desktop runtime unavailable";
    detailsElement.textContent = String(error);
    indicatorElement.dataset.phase = "error";
  }
}

initializeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  initializeButton.disabled = true;
  try {
    openPenpot(
      await invoke("initialize_instance", {
        adminEmail: adminEmailInput.value,
      }),
    );
  } catch (error) {
    statusElement.textContent = "Initialization failed";
    detailsElement.textContent = String(error);
    indicatorElement.dataset.phase = "error";
  } finally {
    initializeButton.disabled = false;
  }
});

refresh();
