import { describe, expect, it } from "vitest";
import { lowestBatteryDevice, onlineDevices, parseList } from "../src/model.js";

function deviceLine(name: string, kind: string, battery: string, marker = "●", slot = 1): string {
  return `  └─ slot ${slot} ${marker} ${name} (${kind}, wpid=0000, battery=${battery})`;
}

const multipleDevicesOutput = [
  "(inventory read from the running agent)",
  "Logitech Wireless Mouse MX Master (—, vid=0000 pid=0001)",
  "  └─ slot 255 ● Wireless Mouse MX Master (mouse, wpid=?, battery=90% full (discharging))",
  "          model_ids=[0001,0002,0000] ext=00 serial=— unit_id=deadbeef transports=equad+btle",
  "",
  "Logi Bolt Receiver (DEADBEEFDEADBEEF, vid=0000 pid=0002)",
  "  └─ slot 1 ● MX Master 3S  (mouse, wpid=0003, battery=80% full (discharging))",
  "          model_ids=[0003,0000,0000] ext=04 serial=TESTSERIAL01 unit_id=cafebabe transports=btle",
].join("\n");

describe("OpenLogi list parser", () => {
  it("parses multiple parents, sorts devices, and selects the lowest battery", () => {
    const parsed = parseList(multipleDevicesOutput);
    expect(parsed.ok).toBe(true);
    expect(parsed.devices).toHaveLength(2);

    const connected = onlineDevices(parsed.devices);
    expect(connected.map((device) => device.name)).toEqual(["MX Master 3S", "Wireless Mouse MX Master"]);
    expect(connected[0]).toMatchObject({ connectionKind: "bolt", connectionLabel: "Logi Bolt receiver" });
    expect(connected[1]).toMatchObject({ connectionKind: "bluetooth", connectionLabel: "Bluetooth (direct)" });
    expect(lowestBatteryDevice(connected)).toMatchObject({ name: "MX Master 3S", percentage: 80 });
  });

  it("identifies receiver kinds from inventory parent names", () => {
    const output = [
      "Logi Bolt Receiver (DEADBEEFDEADBEEF, vid=0000 pid=0010)",
      deviceLine("Bolt Mouse", "mouse", "80% full (discharging)"),
      "Unifying Receiver (DEADBEEFDEADBEEF, vid=0000 pid=0011)",
      deviceLine("Unifying Mouse", "mouse", "70% full (discharging)"),
      "Lightspeed Receiver (DEADBEEFDEADBEEF, vid=0000 pid=0012)",
      deviceLine("Lightspeed Mouse", "mouse", "60% full (discharging)"),
      "Future Receiver (DEADBEEFDEADBEEF, vid=0000 pid=0013)",
      deviceLine("Generic Mouse", "mouse", "50% full (discharging)"),
    ].join("\n");

    expect(onlineDevices(parseList(output).devices).map((device) => device.connectionKind)).toEqual([
      "bolt",
      "receiver",
      "lightspeed",
      "unifying",
    ]);
  });

  it.each([
    ["Future Receiver", "c548", "bolt"],
    ["Future Receiver", "c53f", "lightspeed"],
    ["Future Receiver", "c547", "lightspeed"],
    ["Future Receiver", "c52b", "unifying"],
    ["Future Receiver", "c532", "unifying"],
    ["Future Receiver", "c539", "unifying"],
  ])("identifies %s PID %s as %s", (name, productId, expectedKind) => {
    const output = [
      `${name} (DEADBEEFDEADBEEF, vid=046d pid=${productId})`,
      deviceLine("Test Mouse", "mouse", "50% good (discharging)"),
    ].join("\n");
    expect(parseList(output).devices[0].connectionKind).toBe(expectedKind);
  });

  it("uses the current model PID for a direct wired connection", () => {
    const output = [
      "Wired Test Mouse (—, vid=0000 pid=0020)",
      deviceLine("Wired Test Mouse", "mouse", "100% full (charging)", "●", 255),
      "          model_ids=[0020,0000,0000] ext=00 serial=— unit_id=deadbeef transports=usb",
    ].join("\n");
    expect(parseList(output).devices[0]).toMatchObject({
      connectionKind: "usb",
      connectionLabel: "Wired USB",
      charging: true,
    });
  });

  it("does not mistake discharging for charging", () => {
    expect(parseList(deviceLine("Mouse", "mouse", "80% full (discharging)")).devices[0].charging).toBe(false);
  });

  it("identifies direct classic Bluetooth", () => {
    const output = [
      "Bluetooth Test Mouse (—, vid=0000 pid=0021)",
      deviceLine("Bluetooth Test Mouse", "mouse", "65% good (discharging)", "●", 255),
      "          model_ids=[0021,0000,0000] ext=00 serial=— unit_id=deadbeef transports=bt",
    ].join("\n");
    expect(parseList(output).devices[0].connectionKind).toBe("bluetooth");
  });

  it("does not guess a direct connection from model capabilities", () => {
    const output = [
      "Direct Test Mouse (—, vid=0000 pid=0022)",
      deviceLine("Direct Test Mouse", "mouse", "65% good (discharging)", "●", 255),
      "          model_ids=[0023,0000,0000] ext=00 serial=— unit_id=deadbeef transports=btle",
    ].join("\n");
    expect(parseList(output).devices[0]).toMatchObject({
      connectionKind: "direct",
      connectionLabel: "Connection unknown",
    });
  });

  it("parses supported and future device kinds without filtering them", () => {
    const kinds = ["mouse", "trackball", "keyboard", "numpad", "touchpad", "headset", "gamepad", "joystick", "tablet"];
    for (const kind of kinds) {
      expect(parseList(deviceLine(`Test ${kind}`, kind, "72% good (discharging)")).devices[0].kind).toBe(kind);
    }
  });

  it("excludes offline devices", () => {
    const output = [
      deviceLine("Sleeping Mouse", "mouse", "60% good (discharging)", "○"),
      deviceLine("Awake Keyboard", "keyboard", "70% good (discharging)"),
    ].join("\n");
    expect(onlineDevices(parseList(output).devices).map((device) => device.name)).toEqual(["Awake Keyboard"]);
  });

  it("keeps unavailable batteries in the connected list but not the minimum", () => {
    const output = [
      deviceLine("No Battery", "mouse", "—"),
      deviceLine("Known Battery", "mouse", "40% low (discharging)"),
    ].join("\n");
    const connected = onlineDevices(parseList(output).devices);
    expect(connected).toHaveLength(2);
    expect(connected.find((device) => device.name === "No Battery")).toMatchObject({
      batteryAvailable: false,
      percentage: null,
    });
    expect(lowestBatteryDevice(connected)?.name).toBe("Known Battery");
  });

  it("uses the alphabetically first name to break equal-percentage ties", () => {
    const output = [
      deviceLine("Zulu Mouse", "mouse", "50% good (discharging)"),
      deviceLine("Alpha Keyboard", "keyboard", "50% good (discharging)"),
    ].join("\n");
    expect(lowestBatteryDevice(onlineDevices(parseList(output).devices))?.name).toBe("Alpha Keyboard");
  });

  it("recognises no-hardware output", () => {
    const parsed = parseList("No Logitech HID++ devices or webcams found.\n\nNotes:\n - Nothing connected");
    expect(parsed).toMatchObject({ ok: true, noHardware: true, devices: [] });
  });

  it("ignores camera-only output", () => {
    const parsed = parseList("Cameras (1 Logitech UVC)\n └─ ● Brio (camera, vid=0000 pid=0004, id=1)");
    expect(parsed).toMatchObject({ ok: true, noHardware: false, devices: [] });
  });

  it("supports CRLF output", () => {
    const parsed = parseList(deviceLine("MX Keys", "keyboard", "72% good (discharging)").replace(/\n/g, "\r\n"));
    expect(parsed.devices[0]).toMatchObject({ name: "MX Keys", percentage: 72 });
  });

  it("fails closed for a malformed device row", () => {
    expect(parseList("  └─ slot 1 ● Changed output format")).toMatchObject({
      ok: false,
      devices: [],
      error: "Unsupported openlogi list device row",
    });
  });

  it("fails closed for an out-of-range percentage", () => {
    expect(parseList(deviceLine("Impossible Mouse", "mouse", "101% full (charging)")).ok).toBe(false);
  });
});
