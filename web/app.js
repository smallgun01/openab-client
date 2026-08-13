import { AcpConnection } from "../src/acp-connection/connection.mjs";
import { connectionView } from "./connection-view.mjs";

const connection = new AcpConnection();
const form = document.querySelector("#connection-form");
const endpointInput = document.querySelector("#endpoint");
const authKeyInput = document.querySelector("#auth-key");
const insecureLocalhostInput = document.querySelector("#allow-insecure-localhost");
const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const createSessionButton = document.querySelector("#create-session");
const connectionState = document.querySelector("#connection-state");
const connectionDetail = document.querySelector("#connection-detail");
const sessionState = document.querySelector("#session-state");
const errorState = document.querySelector("#connection-error");

function render(state) {
  const view = connectionView(state);

  connectionState.textContent = view.statusText;
  connectionState.dataset.tone = view.tone;
  connectionDetail.textContent = view.detailText;
  sessionState.textContent = view.sessionText;

  errorState.textContent = view.errorText;
  errorState.hidden = !view.errorText;

  endpointInput.disabled = view.formLocked;
  authKeyInput.disabled = view.formLocked;
  insecureLocalhostInput.disabled = view.formLocked;
  connectButton.disabled = view.formLocked || !form.checkValidity();
  disconnectButton.disabled = !view.canDisconnect;
  createSessionButton.disabled = !view.canCreateSession;
}

function renderCurrentState() {
  render(connection.state);
}

form.addEventListener("input", renderCurrentState);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  const authKey = authKeyInput.value;
  authKeyInput.value = "";
  renderCurrentState();

  void connection.connect({
    endpoint: endpointInput.value,
    authKey,
    allowInsecureLocalhost: insecureLocalhostInput.checked,
  }).catch(() => {
    // The state machine owns the user-visible failure classification.
  });
});

disconnectButton.addEventListener("click", () => connection.disconnect());

createSessionButton.addEventListener("click", () => {
  void connection.createSession().catch(() => {
    // The state machine owns the user-visible session error classification.
  });
});

connection.subscribe(render);
