import { BridgeConnection } from "./connection.js";
import { getExtensionApi } from "./platform.js";

export function installBackground(
  api = getExtensionApi(),
  connection = new BridgeConnection(api),
): void {
  const start = () => {
    void connection.start().catch(() => {
      connection.stop();
    });
  };
  const reconnect = () => {
    connection.stop();
    start();
  };
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.pairing) reconnect();
  });
  api.runtime.onStartup.addListener(start);
  api.runtime.onInstalled.addListener(start);
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "canvas-bridge-reconnect") start();
  });
  api.action.onClicked.addListener(() => {
    void api.runtime.openOptionsPage();
  });
  api.runtime.onMessage.addListener((message: unknown, sender, reply) => {
    if (
      sender.id !== api.runtime.id ||
      sender.url !== api.runtime.getURL("options.html")
    )
      return false;
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "reconnect"
    ) {
      reconnect();
      reply({ state: "connecting" });
    }
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "status"
    )
      reply(connection.status());
    return false;
  });
  void api.alarms.create("canvas-bridge-reconnect", { periodInMinutes: 1 });
  start();
}
