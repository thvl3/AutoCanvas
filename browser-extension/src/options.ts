import { installOptions } from "./options-ui.js";
void installOptions().catch(() => {
  const status = document.getElementById("status");
  if (status)
    status.textContent = "Options could not load. Reload this extension page.";
});
