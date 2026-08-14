import { AcpConnection } from "../src/acp-connection/connection.mjs";
import { TurnStatus } from "../src/acp-connection/types.mjs";
import { chatView } from "./chat-view.mjs";
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
const chatForm = document.querySelector("#chat-form");
const promptInput = document.querySelector("#prompt");
const sendButton = document.querySelector("#send");
const stopButton = document.querySelector("#stop");
const chatState = document.querySelector("#chat-state");
const chatError = document.querySelector("#chat-error");
const transcript = document.querySelector("#transcript");
let currentAssistantMessage = null;

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
  renderChat();
}

function renderChat() {
  const view = chatView(connection.state, connection.turnState);
  chatState.textContent = view.statusText;
  chatState.dataset.tone = view.tone;
  chatError.textContent = view.errorText;
  chatError.hidden = !view.errorText;
  promptInput.disabled = view.inputLocked;
  sendButton.disabled = !view.canSend || !chatForm.checkValidity();
  stopButton.disabled = !view.canStop;

  if (currentAssistantMessage && connection.turnState.status !== TurnStatus.IDLE) {
    currentAssistantMessage.content.textContent = connection.turnState.text;
    currentAssistantMessage.status.textContent = view.errorText || view.statusText;
    currentAssistantMessage.element.dataset.tone = view.tone;
  }
}

function appendMessage(role, text) {
  const element = document.createElement("article");
  element.className = "message";
  element.dataset.role = role;

  const label = document.createElement("p");
  label.className = "message-role";
  label.textContent = role === "user" ? "You" : "Agent";

  const content = document.createElement("p");
  content.className = "message-content";
  content.textContent = text;

  const status = document.createElement("p");
  status.className = "message-status";
  status.textContent = role === "agent" ? "Waiting for response…" : "Sent";

  element.append(label, content, status);
  transcript.append(element);
  transcript.hidden = false;
  element.scrollIntoView({ block: "nearest" });
  return { element, content, status };
}

function renderCurrentState() {
  render(connection.state);
}

form.addEventListener("input", renderCurrentState);
chatForm.addEventListener("input", renderChat);

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

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!chatForm.reportValidity()) return;

  const prompt = promptInput.value;
  appendMessage("user", prompt);
  currentAssistantMessage = appendMessage("agent", "");
  promptInput.value = "";

  void connection.sendPrompt(prompt).then((result) => {
    if (!currentAssistantMessage) return;
    currentAssistantMessage.content.textContent = result.text;
  }).catch(() => {
    // The turn state machine and chatView own fixed, safe user-visible errors.
  }).finally(() => {
    currentAssistantMessage = null;
    renderChat();
  });
});

stopButton.addEventListener("click", () => {
  try {
    connection.cancelPrompt();
  } catch {
    // The active prompt promise settles with the fixed, safe turn error.
  }
});

connection.subscribe(render);
connection.subscribeTurn(renderChat);
