"use strict";

const PROTOCOL = { NRF52: "nrf52", DA14585: "da14585" };
const UUID = {
  NRF_SERVICE: "62750001-d828-918d-fb46-b6c11c675aec",
  NRF_CHARACTERISTIC: "62750002-d828-918d-fb46-b6c11c675aec",
  DA_SERIAL_SERVICE: "00001f10-0000-1000-8000-00805f9b34fb",
  DA_SERIAL_CHARACTERISTIC: "00001f1f-0000-1000-8000-00805f9b34fb",
  DA_LEGACY_SERVICE: "13187b10-eba9-a3ba-044e-83d3217d9a38",
  DA_LEGACY_CHARACTERISTIC: "4b646063-6264-f3a7-8941-e65356ea82fe",
  DA_DFU_SERVICE: "0000221f-0000-1000-8000-00805f9b34fb"
};
const NRF_CMD = { INIT: 0x01, REFRESH: 0x05, SET_TIME: 0x20, WEEK_START: 0x21, WRITE_IMAGE: 0x30 };
const OPTIONAL_SERVICES = [UUID.NRF_SERVICE, UUID.DA_SERIAL_SERVICE, UUID.DA_LEGACY_SERVICE, UUID.DA_DFU_SERVICE];

const state = {
  device: null, server: null, protocol: null, epd: null, serial: null,
  model: null, mode: null, mtu: null, chunkSize: 128, logs: [],
  image: null, rotation: 0, fit: "contain", imageReady: false, sending: false
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
  state.protocol = null; state.epd = null; state.serial = null; state.model = null; state.mode = null; state.mtu = null; state.chunkSize = 128;
  try {
    const service = await state.server.getPrimaryService(UUID.NRF_SERVICE);
    state.epd = await service.getCharacteristic(UUID.NRF_CHARACTERISTIC);
    await state.epd.startNotifications();
    state.epd.addEventListener("characteristicvaluechanged", handleNrfNotification);
    state.protocol = PROTOCOL.NRF52;
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
  state.server = null; state.protocol = null; state.epd = null; state.serial = null;
  state.model = null; state.mode = null; state.mtu = null;
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
function canvasBytesColumnMajor() {
  const data=ctx.getImageData(0,0,250,128).data,result=[];let bits=[];
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
  const planes=[{name:"đen",data:canvasBytesRowMajor("black"),flag:0x0f,start:0,end:48},{name:"đỏ",data:canvasBytesRowMajor("red"),flag:0x00,start:48,end:95}];
  for(const plane of planes){const total=Math.ceil(plane.data.length/state.chunkSize);let part=0;for(let offset=0;offset<plane.data.length;offset+=state.chunkSize){const chunk=plane.data.slice(offset,offset+state.chunkSize);const begin=offset===0?0x00:0xf0;await writeEpd(new Uint8Array([NRF_CMD.WRITE_IMAGE,begin|plane.flag,...chunk]));part++;uploadProgress(plane.start+(part/total)*(plane.end-plane.start),`Đang gửi lớp ${plane.name}: ${part}/${total}`);await delay(8);}}
  uploadProgress(97,"Đang làm mới màn hình…");await writeEpd(new Uint8Array([NRF_CMD.REFRESH]));state.mode=0;updateDeviceUI();
}
async function uploadDaImage() {
  const data=canvasBytesColumnMajor(),hex=bytesHex(data),step=480,total=Math.ceil(hex.length/step);let part=0;
  for(let offset=0;offset<hex.length;offset+=step){const packet=`03ff${toHex(offset/2,2)}${hex.slice(offset,offset+step)}`;await writeEpd(hexBytes(packet));part++;uploadProgress((part/total)*94,`Đang gửi khối ${part}/${total}`);}
  await delay(300);await writeEpd(hexBytes("01"));
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
  $("advanced-toggle").addEventListener("click",()=>{const open=$("advanced-content").hidden;$("advanced-content").hidden=!open;$("advanced-toggle").setAttribute("aria-expanded",String(open));});
  $("calibration-value").addEventListener("input",validateCalibration);$("calibrate-button").addEventListener("click",calibrateDa);
  $("sleep-on-button").addEventListener("click",()=>setSleep(true));$("sleep-off-button").addEventListener("click",()=>setSleep(false));
  $("image-file").addEventListener("change",(event)=>loadImageFile(event.target.files[0]));
  const zone=$("drop-zone");["dragenter","dragover"].forEach((name)=>zone.addEventListener(name,(event)=>{event.preventDefault();zone.classList.add("dragover");}));["dragleave","drop"].forEach((name)=>zone.addEventListener(name,(event)=>{event.preventDefault();zone.classList.remove("dragover");}));zone.addEventListener("drop",(event)=>loadImageFile(event.dataTransfer.files[0]));
  document.querySelectorAll("[data-fit]").forEach((button)=>button.addEventListener("click",()=>{state.fit=button.dataset.fit;document.querySelectorAll("[data-fit]").forEach((b)=>b.classList.toggle("active",b===button));drawImage();}));
  $("rotate-image-button").addEventListener("click",()=>{state.rotation=(state.rotation+90)%360;drawImage();});
  ["brightness","contrast"].forEach((id)=>$(id).addEventListener("input",()=>{$(`${id}-output`).textContent=$(id).value;processPreview();}));
  $("dither-mode").addEventListener("change",processPreview);$("upload-button").addEventListener("click",uploadImage);
}

function initialize() {
  bindEvents(); clearPreview(); updateDeviceUI();
  const supported="bluetooth" in navigator;
  $("browser-warning").hidden=supported;$("connect-button").disabled=!supported;
  addLog("Ứng dụng đã sẵn sàng.","success");
}

initialize();
