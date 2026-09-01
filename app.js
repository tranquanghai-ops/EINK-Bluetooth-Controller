"use strict";

const PROTOCOL = { NRF52: "nrf52", DA14585: "da14585" };
const UUID = {
  NRF_SERVICE: "62750001-d828-918d-fb46-b6c11c675aec",
  NRF_CHARACTERISTIC: "62750002-d828-918d-fb46-b6c11c675aec",
  NRF_VERSION_CHARACTERISTIC: "62750003-d828-918d-fb46-b6c11c675aec",
  DA_SERIAL_SERVICE: "00001f10-0000-1000-8000-00805f9b34fb",
  DA_SERIAL_CHARACTERISTIC: "00001f1f-0000-1000-8000-00805f9b34fb",
  DA_LEGACY_SERVICE: "13187b10-eba9-a3ba-044e-83d3217d9a38",
  DA_LEGACY_CHARACTERISTIC: "4b646063-6264-f3a7-8941-e65356ea82fe",
  DA_DFU_SERVICE: "0000221f-0000-1000-8000-00805f9b34fb",
  DA_DFU_CHARACTERISTIC: "0000331f-0000-1000-8000-00805f9b34fb"
};
const NRF_CMD = { INIT: 0x01, CLEAR: 0x02, REFRESH: 0x05, SLEEP: 0x06, SET_TIME: 0x20, WEEK_START: 0x21, WRITE_IMAGE: 0x30 };
const OPTIONAL_SERVICES = [UUID.NRF_SERVICE, UUID.DA_SERIAL_SERVICE, UUID.DA_LEGACY_SERVICE, UUID.DA_DFU_SERVICE];

const state = {
  device: null, server: null, protocol: null, epd: null, serial: null,
  model: null, mode: null, mtu: null, chunkSize: 128, logs: [],
  image: null, rotation: 0, fit: "contain", imageReady: false, sending: false,
  firmwareVersion: null, serviceUuids: [], characteristicUuids: [], dfu: null,
  dfuPending: null, firmwareReadVerified: false, backupRunning: false,
  designTemplate: "clock", designSymbol: ""
};

const $ = (id) => document.getElementById(id);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toHex = (number, bytes = 1) => Number(number).toString(16).padStart(bytes * 2, "0");
const hexBytes = (hex) => new Uint8Array((hex.match(/.{1,2}/g) || []).map((part) => parseInt(part, 16)));
const bytesHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

function addLog(message, type = "info") {
  const item = { time: new Date(), message: String(message), type };
  state.logs.push(item);
  if (state.logs.length > 300) state.logs.shift();
  renderLogs();
}

function renderLogs() {
  $("log-count").textContent = state.logs.length;
  const consoleBox = $("log-console");
  consoleBox.replaceChildren(...state.logs.map((item) => {
    const line = document.createElement("div");
    line.className = `log-line ${item.type}`;
    const time = document.createElement("time");
    time.textContent = item.time.toLocaleTimeString("vi-VN", { hour12: false });
    const text = document.createElement("span");
    text.textContent = item.message;
    line.append(time, text);
    return line;
  }));
  consoleBox.scrollTop = consoleBox.scrollHeight;
  const recent = state.logs.slice(-3).reverse();
  $("recent-log-list").replaceChildren(...recent.map((item) => {
    const li = document.createElement("li"); li.textContent = item.message; return li;
  }));
  $("recent-log").hidden = state.logs.length === 0;
}

function toast(message, error = false) {
  const element = document.createElement("div");
  element.className = `toast${error ? " error" : ""}`;
  element.textContent = message;
  $("toast-region").append(element);
  setTimeout(() => element.remove(), 3600);
}

function showTab(panelId) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === panelId));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === panelId));
}

function modeName(mode) {
  return ({ 0: "Ảnh", 1: "Lịch", 2: "Đồng hồ 1", 3: "Đồng hồ 2" })[mode] || "Chưa rõ";
}

function updateDeviceUI() {
  const connected = Boolean(state.server?.connected && state.protocol);
  $("welcome-panel").hidden = connected;
  $("workspace").hidden = !connected;
  $("device-badges").hidden = !connected;
  $("connect-button").hidden = connected;
  $("reconnect-button").hidden = connected || !state.device;
  $("disconnect-button").hidden = !connected;
  document.querySelector(".connection-card").classList.toggle("connected", connected);

  if (!connected) {
    $("connection-title").textContent = state.device ? "Đã ngắt kết nối" : "Chưa kết nối";
    $("connection-description").textContent = state.device ? "Bấm Kết nối lại để tiếp tục với thiết bị vừa chọn." : "Bật Bluetooth trên màn hình, sau đó chọn đúng thiết bị trong danh sách.";
    $("connection-icon").textContent = "⌁";
    return;
  }

  const isNrf = state.protocol === PROTOCOL.NRF52;
  $("connection-icon").textContent = "✓";
  $("connection-title").textContent = state.device?.name || "Màn hình E-Ink";
  $("connection-description").textContent = isNrf ? "Đã nhận dạng nRF52; chỉ chức năng tương thích đang hiển thị." : "Đã nhận dạng DA14585 với serial service và e-paper service.";
  $("protocol-badge").textContent = isNrf ? "nRF52" : "DA14585 cũ";
  $("model-badge").textContent = isNrf ? `Model ${state.model ?? "đang đọc"} · 250×128` : "2.13\" · 250×128";
  $("mode-badge").textContent = isNrf ? modeName(state.mode) : "Giao thức Legacy";
  $("mtu-badge").hidden = !isNrf || !state.mtu;
  if (state.mtu) $("mtu-badge").textContent = `MTU ${state.mtu}`;
  $("nrf-mode-controls").hidden = !isNrf;
  $("da-mode-controls").hidden = isNrf;
  $("week-start-row").hidden = !isNrf;
  document.querySelectorAll(".da-only").forEach((element) => { element.hidden = isNrf; });
  $("image-device-label").textContent = isNrf ? `nRF52 model ${state.model ?? 2}` : "DA14585 Legacy";
  document.querySelectorAll("[data-nrf-mode]").forEach((button) => button.classList.toggle("active", Number(button.dataset.nrfMode) === state.mode));
  updateDiagnosticsUI();
}

function shortUuid(uuid) {
  const match = String(uuid).toLowerCase().match(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/);
  return match ? `0x${match[1].toUpperCase()}` : String(uuid);
}

function updateDiagnosticsUI() {
  const isNrf = state.protocol === PROTOCOL.NRF52;
  $("diag-protocol").textContent = state.protocol ? (isNrf ? "nRF52 / EPD-nRF5" : "Legacy serial + E-paper") : "Chưa xác định";
  $("diag-firmware").textContent = state.firmwareVersion || (isNrf ? "Firmware không cung cấp version" : "Không có characteristic version");
  $("diag-services").textContent = state.serviceUuids.length ? state.serviceUuids.map(shortUuid).join(" · ") : "Chưa quét";
  $("diag-image").textContent = state.protocol ? (isNrf ? `0x30 · chunk ${state.chunkSize} byte` : "Legacy 0x03 · gói 244 byte · lớp BW") : "Chưa xác định";
  $("firmware-card").hidden = !state.dfu;
  $("firmware-status").textContent = state.dfu
    ? (state.firmwareReadVerified ? "Đã xác minh đọc Flash. Có thể tạo bản sao .bin." : "Đã thấy dịch vụ Telink OTA. Hãy kiểm tra đọc trước.")
    : "Thiết bị không công bố dịch vụ đọc Flash 0x221F/0x331F.";
  $("firmware-backup-button").disabled = !state.firmwareReadVerified || state.backupRunning;
}

async function inspectGattCapabilities() {
  state.serviceUuids = []; state.characteristicUuids = []; state.dfu = null;
  state.firmwareReadVerified = false;
  try {
    const services = await state.server.getPrimaryServices();
    for (const service of services) {
      state.serviceUuids.push(service.uuid);
      addLog(`GATT service: ${service.uuid}`);
      try {
        const characteristics = await service.getCharacteristics();
        for (const characteristic of characteristics) {
          state.characteristicUuids.push(characteristic.uuid);
          addLog(`  characteristic: ${characteristic.uuid}`);
        }
      } catch (error) {
        addLog(`Không đọc được danh sách characteristic của ${shortUuid(service.uuid)}: ${error.message}`);
      }
    }
  } catch (error) {
    addLog(`Không thể liệt kê toàn bộ GATT: ${error.message}`);
  }
  try {
    const service = await state.server.getPrimaryService(UUID.DA_DFU_SERVICE);
    state.dfu = await service.getCharacteristic(UUID.DA_DFU_CHARACTERISTIC);
    await state.dfu.startNotifications();
    state.dfu.addEventListener("characteristicvaluechanged", handleDfuNotification);
    addLog("Đã phát hiện kênh Telink đọc Flash 0x221F/0x331F.", "success");
  } catch (error) {
    state.dfu = null;
    addLog("Không có kênh đọc Flash tương thích; chức năng sao lưu được ẩn.");
  }
  updateDiagnosticsUI();
}

async function readNrfVersion(service) {
  try {
    const characteristic = await service.getCharacteristic(UUID.NRF_VERSION_CHARACTERISTIC);
    const value = await characteristic.readValue();
    const data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const printable = new TextDecoder().decode(data).replace(/\0/g, "").trim();
    state.firmwareVersion = printable && /^[\x20-\x7e]+$/.test(printable) ? printable : bytesHex(data);
    addLog(`nRF52 firmware: ${state.firmwareVersion}`, "success");
  } catch (error) {
    state.firmwareVersion = null;
    addLog("nRF52 không cung cấp characteristic version.");
  }
}

function handleDfuNotification(event) {
  const view = event.target.value;
  const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
  addLog(`Flash response: ${data.length} byte · ${bytesHex(data.slice(0, 12))}${data.length > 12 ? "…" : ""}`);
  if (state.dfuPending) {
    const pending = state.dfuPending; state.dfuPending = null;
    clearTimeout(pending.timer); pending.resolve(data);
  }
}

async function requestFlashBlock(address, timeout = 2500) {
  if (!state.dfu) throw new Error("Không có kênh đọc Flash tương thích.");
  if (state.dfuPending) throw new Error("Đang chờ phản hồi đọc Flash trước đó.");
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { state.dfuPending = null; reject(new Error("Thiết bị không phản hồi lệnh đọc Flash.")); }, timeout);
    state.dfuPending = { resolve, reject, timer };
  });
  const command = new Uint8Array([0x04, address >>> 24, address >>> 16, address >>> 8, address]);
  try {
    if (state.dfu.writeValueWithoutResponse) await state.dfu.writeValueWithoutResponse(command);
    else await state.dfu.writeValue(command);
  } catch (error) {
    if (state.dfuPending) { clearTimeout(state.dfuPending.timer); state.dfuPending = null; }
    throw error;
  }
  return response;
}

async function testFirmwareRead() {
  $("firmware-test-button").disabled = true;
  try {
    addLog("Kiểm tra chỉ đọc Flash tại 0x00020000…", "command");
    const data = await requestFlashBlock(0x20000);
    if (!data.length) throw new Error("Phản hồi rỗng.");
    state.firmwareReadVerified = true;
    addLog(`Đọc Flash thành công: ${data.length} byte. Không có dữ liệu nào được ghi.`, "success");
    toast("Đã xác minh khả năng đọc firmware.");
  } catch (error) {
    state.firmwareReadVerified = false; commandError(error);
  } finally {
    $("firmware-test-button").disabled = false; updateDiagnosticsUI();
  }
}

async function backupFirmware() {
  if (!state.firmwareReadVerified || state.backupRunning) return;
  state.backupRunning = true; updateDiagnosticsUI();
  const start = 0x20000, end = 0x40000, chunks = [];
  let address = start;
  try {
    addLog("Bắt đầu sao lưu vùng firmware 0x20000–0x3FFFF (chỉ đọc).", "command");
    while (address < end) {
      const data = await requestFlashBlock(address, 4000);
      if (!data.length) throw new Error(`Phản hồi rỗng tại 0x${address.toString(16)}.`);
      const usable = data.slice(0, Math.min(data.length, end - address));
      chunks.push(usable); address += usable.length;
      const percent = Math.floor(((address - start) / (end - start)) * 100);
      $("firmware-status").textContent = `Đang sao lưu: ${percent}% · 0x${address.toString(16).toUpperCase()}`;
      if ((chunks.length % 64) === 0) await delay(20);
    }
    const blob = new Blob(chunks, { type: "application/octet-stream" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${(state.device?.name || "eink").replace(/[^a-z0-9_-]+/gi, "_")}_0x20000_0x3ffff.bin`;
    link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    addLog(`Đã sao lưu ${blob.size} byte firmware.`, "success"); toast("Đã tải bản sao firmware .bin.");
  } catch (error) {
    commandError(error);
  } finally {
    state.backupRunning = false; updateDiagnosticsUI();
  }
}

function exportDiagnostics() {
  const payload = {
    exportedAt: new Date().toISOString(), device: state.device?.name || null,
    protocol: state.protocol, model: state.model, mode: state.mode, mtu: state.mtu,
    firmwareVersion: state.firmwareVersion, services: state.serviceUuids,
    characteristics: state.characteristicUuids,
    telinkFlashReadService: Boolean(state.dfu), firmwareReadVerified: state.firmwareReadVerified,
    logs: state.logs.map((item) => ({ time: item.time.toISOString(), type: item.type, message: item.message }))
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob);
  link.download = `eink-diagnostic-${Date.now()}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function writeEpd(bytes, withResponse = true) {
  if (!state.epd) throw new Error("Chưa có kênh giao tiếp E-Ink.");
  if (withResponse && state.epd.writeValueWithResponse) await state.epd.writeValueWithResponse(bytes);
  else await state.epd.writeValue(bytes);
}

async function writeSerialHex(command, refreshAfter = false) {
  if (!state.serial) throw new Error("Thiết bị không có serial service.");
  addLog(`Gửi lệnh: ${command.toUpperCase()}`, "command");
  await state.serial.writeValueWithResponse(hexBytes(command));
  if (refreshAfter) { await delay(300); await state.serial.writeValueWithResponse(hexBytes("e2")); }
}

async function connectSelectedDevice(reuse = false) {
  try {
    if (!reuse) {
      addLog("Đang mở danh sách thiết bị Bluetooth…");
      state.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: OPTIONAL_SERVICES });
      state.device.addEventListener("gattserverdisconnected", handleDisconnect);
    }
    $("connect-button").disabled = true;
    $("reconnect-button").disabled = true;
    addLog(`Đang kết nối: ${state.device.name || "Thiết bị không tên"}`);
    state.server = await state.device.gatt.connect();
    addLog("Đã tìm thấy GATT server", "success");
    await inspectGattCapabilities();
    await detectProtocol();
    updateDeviceUI();
    toast(`Đã kết nối ${state.protocol === PROTOCOL.NRF52 ? "nRF52" : "DA14585"}`);
  } catch (error) {
    addLog(`Kết nối thất bại: ${error.message}`, "error");
    toast(error.name === "NotFoundError" ? "Đã hủy chọn thiết bị." : `Không thể kết nối: ${error.message}`, true);
    if (!state.server?.connected) resetConnection(false);
  } finally {
    $("connect-button").disabled = false;
    $("reconnect-button").disabled = false;
  }
}

async function detectProtocol() {
  state.protocol = null; state.epd = null; state.serial = null; state.model = null; state.mode = null; state.mtu = null; state.chunkSize = 128; state.firmwareVersion = null;
  try {
    const service = await state.server.getPrimaryService(UUID.NRF_SERVICE);
    state.epd = await service.getCharacteristic(UUID.NRF_CHARACTERISTIC);
    await state.epd.startNotifications();
    state.epd.addEventListener("characteristicvaluechanged", handleNrfNotification);
    state.protocol = PROTOCOL.NRF52;
    await readNrfVersion(service);
    addLog("Đã nhận dạng giao thức: nRF52", "success");
    await writeEpd(new Uint8Array([NRF_CMD.INIT]));
    addLog("nRF52 connected; display initialized.", "success");
    return;
  } catch (nrfError) {
    addLog("Không tìm thấy nRF52 service; đang kiểm tra DA14585…");
  }

  const serialService = await state.server.getPrimaryService(UUID.DA_SERIAL_SERVICE);
  state.serial = await serialService.getCharacteristic(UUID.DA_SERIAL_CHARACTERISTIC);
  addLog("rxtxService Serial service found", "success");
  addLog("rxtxCharacteristic Serial service connected", "success");
  state.protocol = PROTOCOL.DA14585;
  try {
    const legacy = await state.server.getPrimaryService(UUID.DA_LEGACY_SERVICE);
    state.epd = await legacy.getCharacteristic(UUID.DA_LEGACY_CHARACTERISTIC);
    await state.epd.startNotifications();
    state.epd.addEventListener("characteristicvaluechanged", handleDaNotification);
    addLog("epdService Available service found", "success");
    addLog("epdCharacteristic Service connected", "success");
  } catch (error) {
    state.epd = state.serial;
    addLog("Không có e-paper service riêng; dùng serial service thay thế.");
  }
  addLog("Đã nhận dạng giao thức: DA14585", "success");
}

function handleNrfNotification(event) {
  const view = event.target.value;
  const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const message = new TextDecoder().decode(data).trim();
  if (message.startsWith("mtu=")) {
    const mtu = parseInt(message.slice(4), 10);
    if (Number.isFinite(mtu)) { state.mtu = mtu; state.chunkSize = Math.max(18, Math.min(242, mtu - 2)); }
    addLog(`nRF52 ${message}, image chunk: ${state.chunkSize} bytes`, "success");
  } else if (data.length >= 8 && data.length <= 16 && [1,2,3,4,5,7].includes(data[7])) {
    state.model = data[7];
    if (data.length > 11) state.mode = data[11];
    addLog(`nRF52 model ${state.model}, current mode: ${state.mode}`, "success");
  } else {
    addLog(`nRF52 response: ${message || bytesHex(data)}`);
  }
  updateDeviceUI();
}

function handleDaNotification(event) {
  const data = new Uint8Array(event.target.value.buffer);
  addLog(`Phản hồi DA14585: ${bytesHex(data)}`);
}

function handleDisconnect() {
  addLog("Thiết bị đã ngắt kết nối.", "error");
  resetConnection(true);
  toast("Mất kết nối với màn hình.", true);
}

function resetConnection(keepDevice = true) {
  state.server = null; state.protocol = null; state.epd = null; state.serial = null; state.dfu = null;
  state.model = null; state.mode = null; state.mtu = null; state.firmwareVersion = null;
  state.serviceUuids = []; state.characteristicUuids = []; state.firmwareReadVerified = false;
  if (!keepDevice) state.device = null;
  updateDeviceUI();
}

async function disconnectDevice() {
  if (state.device?.gatt?.connected) state.device.gatt.disconnect();
  else resetConnection(true);
}

async function syncTime() {
  try {
    if (state.protocol === PROTOCOL.NRF52) {
      const weekStart = Number($("week-start").value);
      await writeEpd(new Uint8Array([NRF_CMD.WEEK_START, weekStart]));
      const timestamp = Math.floor(Date.now() / 1000);
      const timezone = Math.round(-new Date().getTimezoneOffset() / 60);
      const mode = state.mode ?? 1;
      await writeEpd(new Uint8Array([NRF_CMD.SET_TIME, timestamp >>> 24, timestamp >>> 16, timestamp >>> 8, timestamp, timezone & 0xff, mode]));
    } else {
      const now = new Date();
      const localEpoch = Math.floor(Date.now() / 1000) - now.getTimezoneOffset() * 60 + 3600;
      const week = now.getDay() || 7;
      const command = `dd${toHex(localEpoch,4)}${toHex(now.getFullYear(),2)}${toHex(now.getMonth()+1)}${toHex(now.getDate())}${toHex(week)}`;
      await writeSerialHex(command);
      await writeSerialHex("e2");
    }
    addLog(`Đã đồng bộ ngày giờ: ${new Date().toLocaleString("vi-VN")}`, "success");
    toast("Đã đồng bộ ngày giờ.");
  } catch (error) { commandError(error); }
}

async function setNrfMode(mode) {
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const timezone = Math.round(-new Date().getTimezoneOffset() / 60);
    await writeEpd(new Uint8Array([NRF_CMD.WEEK_START, Number($("week-start").value)]));
    await writeEpd(new Uint8Array([NRF_CMD.SET_TIME, timestamp >>> 24, timestamp >>> 16, timestamp >>> 8, timestamp, timezone & 0xff, mode]));
    state.mode = mode; updateDeviceUI();
    addLog(`Đã chuyển sang ${modeName(mode)}`, "success"); toast(`Đã chọn ${modeName(mode)}.`);
  } catch (error) { commandError(error); }
}

async function refreshScreen() {
  try {
    if (state.protocol === PROTOCOL.NRF52) await writeEpd(new Uint8Array([NRF_CMD.REFRESH]));
    else await writeSerialHex("e2");
    addLog("Đã gửi lệnh làm mới màn hình.", "success"); toast("Đang làm mới màn hình.");
  } catch (error) { commandError(error); }
}

function commandError(error) { addLog(`Lỗi gửi lệnh: ${error.message}`, "error"); toast(`Không thể gửi lệnh: ${error.message}`, true); }

function validateCalibration() {
  const value = $("calibration-value").value.trim().toUpperCase();
  const number = /^[0-9A-F]{2}$/.test(value) ? parseInt(value, 16) : NaN;
  const valid = Number.isFinite(number) && number >= 0x01 && number <= 0xF0;
  $("calibrate-button").disabled = !valid;
  $("calibration-help").classList.toggle("invalid", value.length > 0 && !valid);
  $("calibration-help").textContent = valid ? (number <= 0x0F ? "Đang hiệu chỉnh màu đỏ. Số càng cao càng đậm." : "Đang hiệu chỉnh màu đen và tắt lớp đỏ.") : "Giá trị hợp lệ: màu đỏ 01–0F · màu đen 10–F0.";
  return valid ? value : null;
}

async function calibrateDa() {
  const value = validateCalibration(); if (!value) return;
  try { await writeSerialHex(`e6${value}`); addLog(`Đã gửi hiệu chỉnh E6${value}`, "success"); toast(`Đã gửi mức hiệu chỉnh ${value}.`); }
  catch (error) { commandError(error); }
}

async function setSleep(enabled) {
  const hour = Math.max(0, Math.min(23, Number($("sleep-hour").value) || 0));
  const minute = Math.max(0, Math.min(59, Number($("sleep-minute").value) || 0));
  try { await writeSerialHex(`fb${enabled ? "01" : "00"}${toHex(hour)}${toHex(minute)}`); toast(enabled ? "Đã bật thời gian nghỉ." : "Đã tắt thời gian nghỉ."); }
  catch (error) { commandError(error); }
}

const canvas = $("preview-canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const sourceCanvas = document.createElement("canvas"); sourceCanvas.width = 250; sourceCanvas.height = 128;
const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });

function clearPreview() {
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#d9d8d3"; ctx.font = "bold 15px system-ui"; ctx.textAlign = "center"; ctx.fillText("Chưa chọn ảnh", 125, 60);
  ctx.font = "11px system-ui"; ctx.fillText("250 × 128", 125, 78);
}

function loadImageFile(file) {
  if (!file || !file.type.startsWith("image/")) { toast("Vui lòng chọn đúng tệp hình ảnh.", true); return; }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => { URL.revokeObjectURL(url); state.image = image; state.rotation = 0; state.imageReady = true; drawImage(); $("upload-button").disabled = false; $("upload-status").textContent = `Đã xử lý ${file.name}`; addLog(`Đã mở ảnh: ${file.name}`); };
  image.onerror = () => { URL.revokeObjectURL(url); toast("Không đọc được ảnh này.", true); };
  image.src = url;
}

function drawImage() {
  if (!state.image) return;
  const w = sourceCanvas.width, h = sourceCanvas.height;
  sourceCtx.save(); sourceCtx.fillStyle = "white"; sourceCtx.fillRect(0,0,w,h); sourceCtx.translate(w/2,h/2); sourceCtx.rotate(state.rotation * Math.PI/180);
  const rotated = state.rotation % 180 !== 0;
  const iw = rotated ? state.image.height : state.image.width;
  const ih = rotated ? state.image.width : state.image.height;
  const scale = state.fit === "cover" ? Math.max(w/iw,h/ih) : Math.min(w/iw,h/ih);
  sourceCtx.drawImage(state.image,-state.image.width*scale/2,-state.image.height*scale/2,state.image.width*scale,state.image.height*scale);
  sourceCtx.restore();
  processPreview();
}

function processPreview() {
  if (!state.image) return;
  const imageData = sourceCtx.getImageData(0,0,250,128); const data = imageData.data;
  const brightness = Number($("brightness").value) * 2.55;
  const contrast = Number($("contrast").value) / 100;
  for (let i=0;i<data.length;i+=4) {
    data[i] = Math.max(0,Math.min(255,(data[i]-128)*contrast+128+brightness));
    data[i+1] = Math.max(0,Math.min(255,(data[i+1]-128)*contrast+128+brightness));
    data[i+2] = Math.max(0,Math.min(255,(data[i+2]-128)*contrast+128+brightness));
  }
  const mode = $("dither-mode").value;
  if (mode === "floyd") floydDither(imageData); else nearestDither(imageData, mode === "bw");
  ctx.putImageData(imageData,0,0);
}

const palette = [[0,0,0],[255,255,255],[230,0,0]];
function nearestColor(r,g,b,bw=false) {
  const colors = bw ? palette.slice(0,2) : palette; let best=colors[0], bestDistance=Infinity;
  for (const color of colors) { const distance=(r-color[0])**2+(g-color[1])**2+(b-color[2])**2; if(distance<bestDistance){bestDistance=distance;best=color;} }
  return best;
}
function nearestDither(imageData,bw=false) { const data=imageData.data; for(let i=0;i<data.length;i+=4){ const c=nearestColor(data[i],data[i+1],data[i+2],bw); data[i]=c[0];data[i+1]=c[1];data[i+2]=c[2]; } }
function floydDither(imageData) {
  const data=imageData.data,w=imageData.width,h=imageData.height;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) { const i=(y*w+x)*4, old=[data[i],data[i+1],data[i+2]], c=nearestColor(...old); data[i]=c[0];data[i+1]=c[1];data[i+2]=c[2]; const err=old.map((v,n)=>v-c[n]); spread(x+1,y,7/16);spread(x-1,y+1,3/16);spread(x,y+1,5/16);spread(x+1,y+1,1/16); function spread(nx,ny,f){if(nx<0||nx>=w||ny<0||ny>=h)return;const j=(ny*w+nx)*4;for(let n=0;n<3;n++)data[j+n]=Math.max(0,Math.min(255,data[j+n]+err[n]*f));} }
}

function canvasBytesRowMajor(type="black") {
  const data=ctx.getImageData(0,0,250,128).data, result=[]; let bits=[];
  for(let y=0;y<128;y++) for(let x=0;x<250;x++) { const i=(y*250+x)*4; const red=data[i]>180&&data[i+1]<80; const black=data[i]<80&&data[i+1]<80&&data[i+2]<80; bits.push(type==="red" ? (red?0:1) : (black?0:1)); if(bits.length===8){result.push(parseInt(bits.join(""),2));bits=[];} }
  if(bits.length){while(bits.length<8)bits.push(1);result.push(parseInt(bits.join(""),2));} return new Uint8Array(result);
}
function canvasBytesColumnMajor(type="black") {
  const data=ctx.getImageData(0,0,250,128).data,result=[];let bits=[];
  for(let x=249;x>=0;x--) for(let y=0;y<128;y++){const i=(y*250+x)*4;const red=data[i]>180&&data[i+1]<80;const black=data[i]<80&&data[i+1]<80&&data[i+2]<80;bits.push(type==="red"?(red?0:1):(black?0:1));if(bits.length===8){result.push(parseInt(bits.join(""),2));bits=[];}}
  return new Uint8Array(result);
}
function canvasBytesLegacy() {
  const data=ctx.getImageData(0,0,250,128).data,result=[];let bits=[];
  // Mã hóa đúng như công cụ gốc cho màn 250×128: trắng=1, đen hoặc đỏ=0.
  for(let x=249;x>=0;x--) for(let y=0;y<128;y++){const i=(y*250+x)*4;const white=data[i]>0&&data[i+1]>0&&data[i+2]>0;bits.push(white?1:0);if(bits.length===8){result.push(parseInt(bits.join(""),2));bits=[];}}
  return new Uint8Array(result);
}

function uploadProgress(value,text){$("upload-progress").value=value;$("upload-status").textContent=text;}
async function uploadImage() {
  if (!state.imageReady || state.sending) return;
  state.sending=true; $("upload-button").disabled=true;
  try {
    if(state.protocol===PROTOCOL.NRF52) await uploadNrfImage(); else await uploadDaImage();
    uploadProgress(100,"Đã truyền ảnh thành công."); addLog("Đã truyền ảnh lên màn hình.","success"); toast("Đã truyền ảnh thành công.");
  } catch(error){uploadProgress(0,`Lỗi: ${error.message}`);commandError(error);} finally {state.sending=false;$("upload-button").disabled=false;}
}
async function uploadNrfImage() {
  await writeEpd(new Uint8Array([NRF_CMD.INIT])); await delay(100);
  // Model 2 stores bytes column-first, from the rightmost column to the left.
  const planes=[{name:"đen",data:canvasBytesColumnMajor("black"),flag:0x0f,start:0,end:48},{name:"đỏ",data:canvasBytesColumnMajor("red"),flag:0x00,start:48,end:95}];
  for(const plane of planes){const total=Math.ceil(plane.data.length/state.chunkSize);let part=0;for(let offset=0;offset<plane.data.length;offset+=state.chunkSize){const chunk=plane.data.slice(offset,offset+state.chunkSize);const begin=offset===0?0x00:0xf0;await writeEpd(new Uint8Array([NRF_CMD.WRITE_IMAGE,begin|plane.flag,...chunk]));part++;uploadProgress(plane.start+(part/total)*(plane.end-plane.start),`Đang gửi lớp ${plane.name}: ${part}/${total}`);await delay(8);}}
  uploadProgress(97,"Đang làm mới màn hình…");await writeEpd(new Uint8Array([NRF_CMD.REFRESH]));state.mode=0;updateDeviceUI();
}
async function uploadDaImage() {
  const data=canvasBytesLegacy(),hex=bytesHex(data),step=480,total=Math.ceil(hex.length/step);let part=0;
  addLog(`Legacy image: ${data.length} byte · ${total} khối · header 03FF`);
  for(let offset=0;offset<hex.length;offset+=step){
    const packet=`03ff${toHex(offset/2,2)}${hex.slice(offset,offset+step)}`;
    await writeEpd(hexBytes(packet)); part++;
    uploadProgress((part/total)*94,`Đang gửi khối ${part}/${total} · offset ${offset/2}`);
    await delay(12);
  }
  await delay(300); await writeEpd(hexBytes("01"));
}


const DESIGN_TEMPLATE_NAMES = { clock: "Đồng hồ", calendar: "Lịch tháng", lunar: "Âm lịch", navigation: "Chỉ đường" };

function designColor() {
  return document.querySelector('input[name="design-color"]:checked')?.value || "#111111";
}

function designText(ctx2d, text, x, y, maxWidth, size, options = {}) {
  const family = options.family || $("design-font").value || "system-ui";
  ctx2d.save();
  ctx2d.fillStyle = options.color || "#111";
  ctx2d.textAlign = options.align || "left";
  ctx2d.textBaseline = options.baseline || "alphabetic";
  ctx2d.font = `${options.weight || 700} ${size}px ${family}`;
  let value = String(text || "");
  if (ctx2d.measureText(value).width > maxWidth) {
    while (value.length > 1 && ctx2d.measureText(value + "…").width > maxWidth) value = value.slice(0, -1);
    value += "…";
  }
  ctx2d.fillText(value, x, y);
  ctx2d.restore();
}

function jdFromDate(day, month, year) {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  let jd = day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  if (jd < 2299161) jd = day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - 32083;
  return jd;
}

function newMoon(k) {
  const T = k / 1236.85, T2 = T * T, T3 = T2 * T, dr = Math.PI / 180;
  let jd = 2415020.75933 + 29.53058868 * k + 0.0001178 * T2 - 0.000000155 * T3;
  jd += 0.00033 * Math.sin((166.56 + 132.87 * T - 0.009173 * T2) * dr);
  const M = 359.2242 + 29.10535608 * k - 0.0000333 * T2 - 0.00000347 * T3;
  const Mpr = 306.0253 + 385.81691806 * k + 0.0107306 * T2 + 0.00001236 * T3;
  const F = 21.2964 + 390.67050646 * k - 0.0016528 * T2 - 0.00000239 * T3;
  let c1 = (0.1734 - 0.000393 * T) * Math.sin(M * dr) + 0.0021 * Math.sin(2 * M * dr);
  c1 -= 0.4068 * Math.sin(Mpr * dr) + 0.0161 * Math.sin(2 * Mpr * dr);
  c1 -= 0.0004 * Math.sin(3 * Mpr * dr);
  c1 += 0.0104 * Math.sin(2 * F * dr) - 0.0051 * Math.sin((M + Mpr) * dr);
  c1 -= 0.0074 * Math.sin((M - Mpr) * dr) + 0.0004 * Math.sin((2 * F + M) * dr);
  c1 -= 0.0004 * Math.sin((2 * F - M) * dr) + 0.0006 * Math.sin((2 * F + Mpr) * dr);
  c1 += 0.0010 * Math.sin((2 * F - Mpr) * dr) + 0.0005 * Math.sin((2 * Mpr + M) * dr);
  const delta = T < -11 ? 0.001 + 0.000839 * T + 0.0002261 * T2 - 0.00000845 * T3 - 0.000000081 * T * T3 : -0.000278 + 0.000265 * T + 0.000262 * T2;
  return jd + c1 - delta;
}

function sunLongitude(jdn) {
  const T = (jdn - 2451545.0) / 36525, T2 = T * T, dr = Math.PI / 180;
  const M = 357.52910 + 35999.05030 * T - 0.0001559 * T2 - 0.00000048 * T * T2;
  const L0 = 280.46645 + 36000.76983 * T + 0.0003032 * T2;
  let dl = (1.914600 - 0.004817 * T - 0.000014 * T2) * Math.sin(dr * M);
  dl += (0.019993 - 0.000101 * T) * Math.sin(2 * dr * M) + 0.000290 * Math.sin(3 * dr * M);
  return (L0 + dl) * dr - Math.PI * 2 * Math.floor((L0 + dl) / 360);
}

function newMoonDay(k, timeZone = 7) {
  return Math.floor(newMoon(k) + 0.5 + timeZone / 24);
}

function sunLongitudeSector(dayNumber, timeZone = 7) {
  return Math.floor(sunLongitude(dayNumber - 0.5 - timeZone / 24) / Math.PI * 6);
}

function lunarMonth11(year, timeZone = 7) {
  const off = jdFromDate(31, 12, year) - 2415021;
  const k = Math.floor(off / 29.530588853);
  let nm = newMoonDay(k, timeZone);
  if (sunLongitudeSector(nm, timeZone) >= 9) nm = newMoonDay(k - 1, timeZone);
  return nm;
}

function leapMonthOffset(a11, timeZone = 7) {
  const k = Math.floor(0.5 + (a11 - 2415021.076998695) / 29.530588853);
  let last = 0, i = 1, arc = sunLongitudeSector(newMoonDay(k + i, timeZone), timeZone);
  do { last = arc; i += 1; arc = sunLongitudeSector(newMoonDay(k + i, timeZone), timeZone); } while (arc !== last && i < 14);
  return i - 1;
}

function solarToLunar(date) {
  const dayNumber = jdFromDate(date.getDate(), date.getMonth() + 1, date.getFullYear());
  const k = Math.floor((dayNumber - 2415021.076998695) / 29.530588853);
  let monthStart = newMoonDay(k + 1);
  if (monthStart > dayNumber) monthStart = newMoonDay(k);
  let a11 = lunarMonth11(date.getFullYear()), b11 = a11;
  let lunarYear;
  if (a11 >= monthStart) { lunarYear = date.getFullYear(); a11 = lunarMonth11(date.getFullYear() - 1); }
  else { lunarYear = date.getFullYear() + 1; b11 = lunarMonth11(date.getFullYear() + 1); }
  const lunarDay = dayNumber - monthStart + 1;
  const diff = Math.floor((monthStart - a11) / 29);
  let lunarLeap = false, lunarMonth = diff + 11;
  if (b11 - a11 > 365) {
    const leapDiff = leapMonthOffset(a11);
    if (diff >= leapDiff) { lunarMonth = diff + 10; if (diff === leapDiff) lunarLeap = true; }
  }
  if (lunarMonth > 12) lunarMonth -= 12;
  if (lunarMonth >= 11 && diff < 4) lunarYear -= 1;
  return { day: lunarDay, month: lunarMonth, year: lunarYear, leap: lunarLeap };
}

function renderDesigner() {
  const designCanvas = $("design-canvas");
  if (!designCanvas) return;
  const dc = designCanvas.getContext("2d");
  const now = new Date();
  const accent = designColor();
  const title = $("design-title").value.trim();
  const subtitle = $("design-subtitle").value.trim();
  const fontSize = Math.max(12, Math.min(48, Number($("design-size").value) || 28));
  dc.fillStyle = "#fff"; dc.fillRect(0, 0, 250, 128);
  dc.strokeStyle = "#111"; dc.lineWidth = 2; dc.strokeRect(1, 1, 248, 126);
  dc.fillStyle = accent;

  if (state.designTemplate === "clock") {
    dc.fillRect(0, 0, 250, 21);
    designText(dc, title || "E‑Ink Clock", 8, 15, 190, 10, { color: "#fff", weight: 800 });
    designText(dc, now.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }), 10, 78, 155, Math.max(32, fontSize), { family: "monospace", weight: 800 });
    dc.strokeStyle = accent; dc.lineWidth = 2; dc.beginPath(); dc.arc(205, 61, 28, 0, Math.PI * 2); dc.stroke();
    const angle = (now.getMinutes() / 60) * Math.PI * 2 - Math.PI / 2;
    dc.beginPath(); dc.moveTo(205, 61); dc.lineTo(205 + Math.cos(angle) * 20, 61 + Math.sin(angle) * 20); dc.stroke();
    designText(dc, now.toLocaleDateString("vi-VN", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }), 10, 101, 225, 12, { color: accent });
    designText(dc, subtitle, 10, 119, 225, 9, { weight: 500 });
  } else if (state.designTemplate === "calendar") {
    const year = now.getFullYear(), month = now.getMonth();
    dc.fillStyle = accent; dc.fillRect(0, 0, 250, 24);
    designText(dc, title || `THÁNG ${month + 1} · ${year}`, 125, 17, 230, 12, { color: "#fff", align: "center", weight: 800 });
    const labels = ["T2","T3","T4","T5","T6","T7","CN"];
    labels.forEach((label, i) => designText(dc, label, 18 + i * 35, 38, 30, 9, { align: "center", color: i > 4 ? accent : "#111" }));
    const first = (new Date(year, month, 1).getDay() + 6) % 7;
    const count = new Date(year, month + 1, 0).getDate();
    for (let day = 1; day <= count; day++) {
      const cell = first + day - 1, col = cell % 7, row = Math.floor(cell / 7);
      const x = 18 + col * 35, y = 54 + row * 14;
      if (day === now.getDate()) { dc.fillStyle = accent; dc.fillRect(x - 11, y - 10, 22, 13); }
      designText(dc, day, x, y, 24, 10, { align: "center", color: day === now.getDate() ? "#fff" : (col > 4 ? accent : "#111") });
    }
    designText(dc, subtitle, 125, 121, 230, 8, { align: "center", weight: 500 });
  } else if (state.designTemplate === "lunar") {
    const lunar = solarToLunar(now);
    dc.fillStyle = accent; dc.fillRect(0, 0, 74, 128);
    designText(dc, now.getDate(), 37, 68, 65, 46, { color: "#fff", align: "center", family: "Georgia,serif" });
    designText(dc, `THÁNG ${now.getMonth() + 1}`, 37, 91, 65, 11, { color: "#fff", align: "center" });
    designText(dc, now.getFullYear(), 37, 109, 65, 10, { color: "#fff", align: "center" });
    designText(dc, title || "ÂM LỊCH VIỆT NAM", 84, 23, 155, 12, { color: accent });
    designText(dc, `Ngày ${lunar.day}`, 84, 60, 155, Math.max(25, fontSize), { color: "#111" });
    designText(dc, `Tháng ${lunar.month}${lunar.leap ? " nhuận" : ""} · ${lunar.year}`, 84, 82, 155, 12, { color: accent });
    designText(dc, subtitle, 84, 109, 155, 9, { weight: 500 });
  } else {
    dc.fillStyle = accent; dc.fillRect(0, 0, 76, 128);
    designText(dc, $("design-direction").value, 38, 78, 68, 55, { color: "#fff", align: "center", family: "system-ui" });
    designText(dc, $("design-distance").value || "200 m", 87, 47, 150, Math.max(24, fontSize), { color: "#111" });
    designText(dc, $("design-road").value || "Đường phía trước", 87, 74, 150, 14, { color: accent });
    designText(dc, title, 87, 98, 150, 10);
    designText(dc, subtitle, 87, 116, 150, 8, { weight: 500 });
  }

  if (state.designSymbol) designText(dc, state.designSymbol, 237, 119, 25, 18, { color: accent, align: "right" });
  $("design-template-label").textContent = DESIGN_TEMPLATE_NAMES[state.designTemplate];
  $("navigation-fields").hidden = state.designTemplate !== "navigation";
}

function resetDesigner() {
  state.designTemplate = "clock"; state.designSymbol = "";
  $("design-title").value = "E‑Ink Clock";
  $("design-subtitle").value = "Cập nhật ngay trên trình duyệt";
  $("design-font").value = "system-ui"; $("design-size").value = "28";
  document.querySelector('input[name="design-color"][value="#111111"]').checked = true;
  document.querySelectorAll("[data-design-template]").forEach((button) => button.classList.toggle("active", button.dataset.designTemplate === "clock"));
  renderDesigner();
}

function useDesignerImage() {
  renderDesigner();
  const image = new Image();
  image.onload = () => {
    state.image = image; state.rotation = 0; state.fit = "contain"; state.imageReady = true;
    document.querySelectorAll("[data-fit]").forEach((button) => button.classList.toggle("active", button.dataset.fit === "contain"));
    drawImage();
    $("upload-button").disabled = false;
    $("upload-status").textContent = `Thiết kế ${DESIGN_TEMPLATE_NAMES[state.designTemplate]} đã sẵn sàng`;
    showTab("image-panel");
    addLog(`Đã tạo ảnh từ mẫu ${DESIGN_TEMPLATE_NAMES[state.designTemplate]}.`, "success");
    toast("Thiết kế đã chuyển sang bước truyền ảnh.");
  };
  image.src = $("design-canvas").toDataURL("image/png");
}

function bindEvents() {
  $("connect-button").addEventListener("click",()=>connectSelectedDevice(false));
  $("reconnect-button").addEventListener("click",()=>connectSelectedDevice(true));
  $("disconnect-button").addEventListener("click",disconnectDevice);
  $("sync-time-button").addEventListener("click",syncTime);
  $("refresh-button").addEventListener("click",refreshScreen);
  $("toggle-color-button").addEventListener("click",()=>writeSerialHex("e4",true).catch(commandError));
  $("invert-button").addEventListener("click",()=>writeSerialHex("e3").catch(commandError));
  $("rotate-device-button").addEventListener("click",()=>writeSerialHex("e5").catch(commandError));
  document.querySelectorAll("[data-nrf-mode]").forEach((button)=>button.addEventListener("click",()=>setNrfMode(Number(button.dataset.nrfMode))));
  document.querySelectorAll("[data-da-command]").forEach((button)=>button.addEventListener("click",()=>writeSerialHex(button.dataset.daCommand,true).catch(commandError)));
  document.querySelectorAll("[data-da-direct]").forEach((button)=>button.addEventListener("click",()=>writeSerialHex(button.dataset.daDirect).catch(commandError)));
  document.querySelectorAll(".open-image").forEach((button)=>button.addEventListener("click",()=>showTab("image-panel")));
  document.querySelectorAll(".tab").forEach((tab)=>tab.addEventListener("click",()=>showTab(tab.dataset.tab)));
  $("open-log-button").addEventListener("click",()=>showTab("log-panel"));
  $("clear-log-button").addEventListener("click",()=>{state.logs=[];renderLogs();});
  $("export-log-button").addEventListener("click",exportDiagnostics);
  $("firmware-test-button").addEventListener("click",testFirmwareRead);
  $("firmware-backup-button").addEventListener("click",backupFirmware);
  $("advanced-toggle").addEventListener("click",()=>{const open=$("advanced-content").hidden;$("advanced-content").hidden=!open;$("advanced-toggle").setAttribute("aria-expanded",String(open));});
  $("calibration-value").addEventListener("input",validateCalibration);$("calibrate-button").addEventListener("click",calibrateDa);
  $("sleep-on-button").addEventListener("click",()=>setSleep(true));$("sleep-off-button").addEventListener("click",()=>setSleep(false));
  $("image-file").addEventListener("change",(event)=>loadImageFile(event.target.files[0]));
  const zone=$("drop-zone");["dragenter","dragover"].forEach((name)=>zone.addEventListener(name,(event)=>{event.preventDefault();zone.classList.add("dragover");}));["dragleave","drop"].forEach((name)=>zone.addEventListener(name,(event)=>{event.preventDefault();zone.classList.remove("dragover");}));zone.addEventListener("drop",(event)=>loadImageFile(event.dataTransfer.files[0]));
  document.querySelectorAll("[data-fit]").forEach((button)=>button.addEventListener("click",()=>{state.fit=button.dataset.fit;document.querySelectorAll("[data-fit]").forEach((b)=>b.classList.toggle("active",b===button));drawImage();}));
  $("rotate-image-button").addEventListener("click",()=>{state.rotation=(state.rotation+90)%360;drawImage();});
  ["brightness","contrast"].forEach((id)=>$(id).addEventListener("input",()=>{$(`${id}-output`).textContent=$(id).value;processPreview();}));
  $("dither-mode").addEventListener("change",processPreview);$("upload-button").addEventListener("click",uploadImage);
  document.querySelectorAll("[data-design-template]").forEach((button)=>button.addEventListener("click",()=>{
    state.designTemplate=button.dataset.designTemplate;
    document.querySelectorAll("[data-design-template]").forEach((item)=>item.classList.toggle("active",item===button));
    renderDesigner();
  }));
  ["design-title","design-subtitle","design-font","design-size","design-direction","design-distance","design-road"].forEach((id)=>{
    $(id).addEventListener("input",renderDesigner); $(id).addEventListener("change",renderDesigner);
  });
  document.querySelectorAll('input[name="design-color"]').forEach((input)=>input.addEventListener("change",renderDesigner));
  document.querySelectorAll("[data-design-symbol]").forEach((button)=>button.addEventListener("click",()=>{state.designSymbol=button.dataset.designSymbol;renderDesigner();}));
  $("design-use-button").addEventListener("click",useDesignerImage);
  $("design-reset-button").addEventListener("click",resetDesigner);
}

function initialize() {
  bindEvents(); clearPreview(); renderDesigner(); updateDeviceUI();
  setInterval(()=>{ if(state.designTemplate==="clock"||state.designTemplate==="lunar") renderDesigner(); },30000);
  const supported="bluetooth" in navigator;
  $("browser-warning").hidden=supported;$("connect-button").disabled=!supported;
  addLog("Ứng dụng đã sẵn sàng.","success");
}

initialize();
