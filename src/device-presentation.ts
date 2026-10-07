import type { ConnectionKind, OpenLogiDevice } from "./model.js";

export function compactConnectionLabel(kind: ConnectionKind): string {
  switch (kind) {
    case "bolt":
      return "Logi Bolt";
    case "unifying":
      return "Unifying";
    case "lightspeed":
      return "Lightspeed";
    case "bluetooth":
      return "Bluetooth";
    case "usb":
      return "USB";
    case "receiver":
      return "Logitech receiver";
    default:
      return "Unknown connection";
  }
}

export function batteryLabel(device: OpenLogiDevice): string {
  if (!device.batteryAvailable || device.percentage === null) return "Battery unavailable";
  return `${device.percentage}%${device.charging ? " (charging)" : ""}`;
}

export function deviceTitle(device: OpenLogiDevice): string {
  return `${device.name} (${compactConnectionLabel(device.connectionKind)}) — ${batteryLabel(device)}`;
}

export function deviceTooltip(device: OpenLogiDevice): string {
  return `${deviceTitle(device)} · ${device.connectionLabel}`;
}
