import { deviceTitle, deviceTooltip } from "./device-presentation.js";
import type { Result } from "./runner.js";

// SwiftBar treats pipes/newlines as structure, and several text parsers are opt-in.
// Use a visually similar safe pipe; never interpolate CLI text into attributes.
export function plain(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\|/g, "¦").replace(/[\u202a-\u202e\u2066-\u2069]/g, "").replace(/^--+/, "–");
}
const TEXT = "ansi=false emojize=false symbolize=false md=false";
function tooltip(text: string): string {
  // Attributes are quoted; eliminate quote/backslash syntax from untrusted text.
  return `tooltip="${plain(text).replace(/["\\]/g, "’")}"`;
}
function icon(kind: string): string {
  switch (kind) {
    case "mouse": case "trackball": return "computermouse";
    case "keyboard": case "numpad": return "keyboard";
    case "touchpad": return "rectangle.and.hand.point.up.left";
    case "headset": return "headphones";
    case "gamepad": case "joystick": return "gamecontroller";
    default: return "battery.100";
  }
}

export function render(result: Result): string {
  if (!result.ok) return [
    `? | sfimage=exclamationmark.triangle ${TEXT} ${tooltip(result.error)}`,
    "---", `OpenLogi unavailable | ${TEXT}`, `${plain(result.error)} | ${TEXT}`,
    "---", "Refresh | refresh=true", "",
  ].join("\n");
  if (!result.lowestDevice) return "";
  const lowest = result.lowestDevice;
  return [
    `${lowest.percentage}% | sfimage=${lowest.charging ? "battery.100.bolt" : icon(lowest.kind)} ${TEXT} ${tooltip(deviceTitle(lowest))}`,
    "---",
    `${result.devices.length} connected ${result.devices.length === 1 ? "device" : "devices"} | ${TEXT}`,
    ...result.devices.map(d => `${plain(deviceTitle(d))} | sfimage=${icon(d.kind)} ${TEXT} ${tooltip(deviceTooltip(d))}`),
    "---", "Refresh | refresh=true", "",
  ].join("\n");
}
