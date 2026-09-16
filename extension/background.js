/* Turns the toolbar button and Alt+Shift+E into a message the content script
   acts on. Nothing else lives here. */
const toggle = (tabId) => chrome.tabs.sendMessage(tabId, { source: "enout-bg", type: "toggle" }).catch(() => {
  /* No content script on this tab — it isn't a Kylas page. */
});

chrome.action.onClicked.addListener((tab) => tab.id && toggle(tab.id));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-console" && tab && tab.id) toggle(tab.id);
});
