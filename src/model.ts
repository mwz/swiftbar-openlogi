export const NO_HARDWARE_MESSAGE = "No Logitech HID++ devices or webcams found.";

// Match the Omarchy model's bounds (UTF-16 code units, not UTF-8 bytes).
export const LIMITS = { output: 65536, lines: 1024, line: 2048, devices: 24, name: 256, field: 64, battery: 256 };

function invalid(error = "Unsupported openlogi list device row"): ParseListResult {
  return { ok: false, noHardware: false, devices: [], error };
}

export type ConnectionKind = "bolt" | "unifying" | "lightspeed" | "receiver" | "bluetooth" | "usb" | "direct";

export interface OpenLogiDevice {
  slot: number;
  online: boolean;
  name: string;
  kind: string;
  batteryAvailable: boolean;
  percentage: number | null;
  charging: boolean;
  order: number;
  connectionKind: ConnectionKind;
  connectionLabel: string;
}

export interface ParseListResult {
  ok: boolean;
  noHardware: boolean;
  devices: OpenLogiDevice[];
  error?: string;
}

interface InventoryParent {
  name: string;
  productId: number;
}

interface ModelDetails {
  modelIds: number[];
  transports: string[];
}

type ParsedDeviceLine = Omit<OpenLogiDevice, "connectionKind" | "connectionLabel">;

type DeviceLineResult = ParsedDeviceLine | { malformed: true; line: string } | null;

export function connectionLabel(kind: ConnectionKind): string {
  switch (kind) {
    case "bolt":
      return "Logi Bolt receiver";
    case "unifying":
      return "Logitech Unifying receiver";
    case "lightspeed":
      return "Logitech Lightspeed receiver";
    case "bluetooth":
      return "Bluetooth (direct)";
    case "usb":
      return "Wired USB";
    case "receiver":
      return "Logitech receiver";
    default:
      return "Connection unknown";
  }
}

function compareDevices(a: OpenLogiDevice, b: OpenLogiDevice): number {
  const aName = a.name.trim();
  const bName = b.name.trim();
  const folded = aName.toLocaleLowerCase().localeCompare(bName.toLocaleLowerCase());
  if (folded !== 0) return folded;

  const exact = aName.localeCompare(bName);
  if (exact !== 0) return exact;

  return a.order - b.order;
}

export function sortedDevices(devices: OpenLogiDevice[]): OpenLogiDevice[] {
  return devices.slice().sort(compareDevices);
}

export function onlineDevices(devices: OpenLogiDevice[]): OpenLogiDevice[] {
  return sortedDevices(devices.filter((device) => device.online));
}

export function lowestBatteryDevice(devices: OpenLogiDevice[]): OpenLogiDevice | null {
  let result: OpenLogiDevice | null = null;

  for (const device of devices) {
    if (!device.online || !device.batteryAvailable || device.percentage === null) continue;
    if (
      result === null ||
      result.percentage === null ||
      device.percentage < result.percentage ||
      (device.percentage === result.percentage && compareDevices(device, result) < 0)
    ) {
      result = device;
    }
  }

  return result;
}

function parseDeviceLine(line: string, order: number): DeviceLineResult {
  const row = line.match(/^\s*[├└]─\s+slot\s+(\d{1,3})\s+([●○])\s+(.+)$/);
  if (!row) return /^\s*[├└]─\s+slot\b/.test(line) ? { malformed: true, line } : null;
  if (Number(row[1]) > 255) return { malformed: true, line };

  const detail = row[3].match(/^(.*?)\s+\(([^,()]+),\s*wpid=([^,]*),\s*battery=(.*)\)\s*$/);
  if (!detail) return { malformed: true, line };
  if (detail[1].trim().length > LIMITS.name || detail[2].trim().length > LIMITS.field ||
      detail[3].length > LIMITS.field || detail[4].length > LIMITS.battery) return { malformed: true, line };

  const batteryText = detail[4].trim();
  const percentageMatch = batteryText.match(/^(\d{1,3})%(?:\s|$)/);
  const percentage = percentageMatch ? Number(percentageMatch[1]) : null;
  if (percentage !== null && percentage > 100) return { malformed: true, line };

  return {
    slot: Number(row[1]),
    online: row[2] === "●",
    name: detail[1].trim(),
    kind: detail[2].trim().toLowerCase(),
    batteryAvailable: percentage !== null,
    percentage,
    charging: /\(\s*charging\s*\)/i.test(batteryText),
    order,
  };
}

function parseInventoryHeader(line: string): InventoryParent | null {
  const header = line.match(/^(.+?)\s+\([^,]*,\s*vid=([0-9a-f]{4})\s+pid=([0-9a-f]{4})\)\s*$/i);
  if (!header) return null;

  return {
    name: header[1].trim(),
    productId: Number.parseInt(header[3], 16),
  };
}

function connectionFromParent(parent: InventoryParent | null, slot: number): ConnectionKind {
  if (!parent) return slot === 255 ? "direct" : "receiver";

  const name = parent.name.toLowerCase();
  if (name.includes("bolt receiver") || parent.productId === 0xc548) return "bolt";
  if (name.includes("lightspeed receiver") || parent.productId === 0xc53f || parent.productId === 0xc547) {
    return "lightspeed";
  }
  if (
    name.includes("unifying receiver") ||
    parent.productId === 0xc52b ||
    parent.productId === 0xc532 ||
    parent.productId === 0xc539
  ) {
    return "unifying";
  }

  return slot === 255 ? "direct" : "receiver";
}

function parseModelLine(line: string): ModelDetails | null {
  const model = line.match(/\bmodel_ids=\[([0-9a-f,\s]+)\].*\btransports=([^\s]+)\s*$/i);
  if (!model) return null;

  return {
    modelIds: model[1].split(",").map((value) => Number.parseInt(value.trim(), 16)),
    transports: model[2].toLowerCase().split("+"),
  };
}

function directConnectionFromModel(parentProductId: number, model: ModelDetails): ConnectionKind {
  if (!Number.isFinite(parentProductId)) return "direct";

  // HID++ packs model IDs in transport-bit order rather than printed-field order:
  // classic Bluetooth, BTLE, eQuad, then USB.
  const transportOrder = ["bt", "btle", "equad", "usb"];
  const enabled = transportOrder.filter((transport) => model.transports.includes(transport));

  for (let index = 0; index < enabled.length && index < model.modelIds.length; index += 1) {
    if (model.modelIds[index] !== parentProductId) continue;
    if (enabled[index] === "bt" || enabled[index] === "btle") return "bluetooth";
    if (enabled[index] === "usb") return "usb";
    return "direct";
  }

  return "direct";
}

export function parseList(output: string): ParseListResult {
  const text = String(output ?? "");
  if (text.length > LIMITS.output) return invalid("OpenLogi output exceeded the parser limits");
  const lines = text.split(/\r?\n/);
  if (lines.length > LIMITS.lines || lines.some(line => line.length > LIMITS.line)) {
    return invalid("OpenLogi output exceeded the parser limits");
  }
  const devices: OpenLogiDevice[] = [];
  const malformed: string[] = [];
  let order = 0;
  let currentParent: InventoryParent | null = null;
  let lastDevice: OpenLogiDevice | null = null;

  for (const line of lines) {
    const header = parseInventoryHeader(line);
    if (header) {
      if (header.name.length > LIMITS.name) return invalid("OpenLogi parent name exceeded the parser limit");
      currentParent = header;
      lastDevice = null;
      continue;
    }

    const parsed = parseDeviceLine(line, order);
    if (parsed) {
      order += 1;
      if ("malformed" in parsed) {
        malformed.push(parsed.line);
        lastDevice = null;
      } else {
        if (devices.length >= LIMITS.devices) return invalid("OpenLogi returned more than 24 devices");
        const connectionKind = connectionFromParent(currentParent, parsed.slot);
        lastDevice = {
          ...parsed,
          connectionKind,
          connectionLabel: connectionLabel(connectionKind),
        };
        devices.push(lastDevice);
      }
      continue;
    }

    const model = parseModelLine(line);
    if (model && lastDevice?.slot === 255) {
      const parentProductId = currentParent?.productId ?? Number.NaN;
      lastDevice.connectionKind = directConnectionFromModel(parentProductId, model);
      lastDevice.connectionLabel = connectionLabel(lastDevice.connectionKind);
    }
  }

  if (malformed.length > 0) {
    return {
      ok: false,
      noHardware: false,
      devices: [],
      error: "Unsupported openlogi list device row",
    };
  }

  return {
    ok: true,
    noHardware: text.includes(NO_HARDWARE_MESSAGE),
    devices,
  };
}
