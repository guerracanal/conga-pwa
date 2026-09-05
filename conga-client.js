// Cliente Conga 4690 (Cecotec/3irobotix) para navegador — conecta directo a la
// nube por WebSocket, sin backend. Puerto de conga_cecotec.py (Python), usado
// en panelcasa. Mismo protocolo que la app oficial de Conga.

const CONGA_CLIENT_VERSION = "2026-09-05-a";
const WS_URL = "wss://tcp-cecotec.3irobotix.net:9090";

const FACTORY_ID = 1003;
const PROJECT_TYPE = "android-es.cecotec.s4690v1";
const VERSION_NAME = "2.1.3";
const VERSION_CODE = 20103;
const PACKAGE_TYPE = "android";

const SERVICE_LOGIN = "sweeper-app-user/auth/login";
const SERVICE_USER_GET_BIND_ROBOT = "sweeper-robot-center/app/get_user_bind";
const SERVICE_TRANSMIT = "sweeper-transmit/transmit/to_bind";
const SERVICE_HEARTBEAT = "heart-beat";

const METHOD_GET_STATUS = "get_status";
const METHOD_SET_MODE = "set_mode";
const METHOD_SET_PREFERENCE = "set_preference";
const METHOD_SET_ROOM_CLEAN_PLAN = "setRoomCleanPlan";
const METHOD_GET_CONSUMABLES = "get_consumables";
const METHOD_SET_DIRECT = "set_direct";

// Vida útil supuesta en horas, deducida de los valores vistos en la app
// oficial el 03/09/2026 (filtro/cepillos a 320h = 0%, mopa a 97h = 3% sobre
// un umbral de 100h). Sin confirmar con un dato oficial.
const CONSUMABLE_LIFETIME_HOURS = { filter: 320, side_brush: 320, main_brush: 320, dishcloth: 100 };

const MODE_AUTO = 0;
const MODE_BACK_CHARGE = 3;
const MODE_EXPLORE = 7;

const VALUE_STOP = 0;
const VALUE_START = 1;
const VALUE_PAUSE = 2;

const PREFERENCE_POWER = 1;
const PREFERENCE_WATER = 2;

// IDs confirmados en vivo el 02/09/2026 (ver panelcasa/conga_cecotec.py).
const ROOMS = { "Cocina": 10, "Salón": 11, "Dormitorio": 12, "Pasillo": 13, "Estudio": 14 };

const KNOWN_FAULTS = { 2102: "backcharge", 2103: "charge", 2104: "backcharge", 2105: "fullcharge" };

// Tabla de códigos de fallo real (protocolo 3irobotix/Cecotec Conga), sacada
// del proyecto de ingeniería inversa congatudo/agnoc (packages/core/src/
// mappers/device-error.mapper.ts, 03/09/2026). Los 21xx/22xx son en su
// mayoría informativos (robot bien), los 5xx sí son fallos reales.
const INFO_FAULTS = new Set([0, 2101, 2102, 2103, 2104, 2105, 2106, 2107, 2108, 2109, 2110, 2200, 2203]);
const FAULT_DESCRIPTIONS = {
  2003: "Batería baja — plan de limpieza programado desactivado",
  2100: "Fallo al volver a la base",
  2102: "Volviendo a la base (orden general del sistema)",
  2103: "Cargando",
  2104: "El usuario ha pedido volver a la base",
  2105: "Carga completa",
  2107: "Limpieza programada (cita) en curso",
  2108: "Relocalizándose en el mapa",
  2109: "Repitiendo limpieza (modo doble pasada)",
  2110: "Autocomprobación al arrancar (transitorio, normal)",
  500: "El láser (LIDAR) no responde",
  501: "Rueda levantada del suelo",
  502: "Batería demasiado baja para empezar a limpiar",
  503: "Depósito/cubo de polvo no puesto",
  504: "Error en el sensor de campo magnético (pared virtual magnética)",
  505: "No pudo salir de la base al arrancar",
  506: "Error siguiendo la señal infrarroja de la base",
  507: "No pudo relocalizarse en el mapa",
  508: "No pudo arrancar por estar en una pendiente",
  509: "Error en el sensor anticaídas",
  510: "Error en el sensor del parachoques",
  511: "No consiguió volver a la base",
  512: "Hay que colocar el robot en la base a mano",
  513: "Atascado — no consiguió liberarse solo de un obstáculo",
  514: "Atascado — no consiguió liberarse solo de un obstáculo",
  515: "Error en los contactos de carga de la base",
  516: "Temperatura de la batería fuera de rango",
  517: "Actualizando firmware",
  518: "Esperando a terminar de cargar",
  519: "Cepillo central atascado o bloqueado",
  520: "Cepillo lateral atascado o bloqueado",
  521: "Depósito de agua no puesto",
  522: "Mopa/paño no puesto",
  523: "Cubo de polvo de la base (vaciado automático) lleno",
  525: "Depósito de agua vacío",
  526: "Mopa/paño sucio",
  527: "Cubo de polvo lleno",
};

class CongaError extends Error {}
class CongaAuthError extends CongaError {}

class Conga {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.ws = null;
    this.loggedIn = false;
    this.pending = new Map(); // traceId -> {resolve, reject}
    this.robotId = null;
    this.sn = null;
    this.shadow = {};
    this.rooms = ROOMS;
    this.consumables = {};
    this.consumablesAt = 0;
    this.onLog = () => {};
  }

  _log(msg) {
    try { this.onLog(msg); } catch {}
  }

  _ensureSocket() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    const t0 = Date.now();
    this._log(`Abriendo conexión a ${WS_URL}…`);
    return new Promise((resolve, reject) => {
      this.loggedIn = false;
      const ws = new WebSocket(WS_URL);
      let settled = false;
      ws.onopen = () => {
        this._log(`Socket abierto (${Date.now() - t0} ms)`);
        if (!settled) { settled = true; this.ws = ws; resolve(); }
      };
      ws.onerror = (ev) => {
        this._log(`Error de socket a los ${Date.now() - t0} ms`);
        if (!settled) { settled = true; reject(new CongaError("No se pudo conectar a la nube de Conga")); }
      };
      ws.onmessage = (ev) => this._onMessage(ev);
      ws.onclose = (ev) => {
        this._log(`Socket cerrado (code=${ev.code}, clean=${ev.wasClean}) a los ${Date.now() - t0} ms`);
        this.loggedIn = false;
        // Cualquier petición todavía pendiente en este socket ya no va a responder.
        this.pending.forEach((p) => p.reject(new CongaError("Conexión con la nube de Conga cerrada")));
        this.pending.clear();
      };
    });
  }

  _onMessage(ev) {
    this._log(`RAW recibido (${ev.data?.length ?? "?"} bytes): ${String(ev.data).slice(0, 400)}`);
    let msg;
    try { msg = JSON.parse(ev.data); } catch { this._log(`No se pudo parsear como JSON`); return; }
    if (msg.service === SERVICE_HEARTBEAT) return;
    let pending = this.pending.get(msg.traceId);
    let matchedTraceId = msg.traceId;
    if (!pending) {
      const code = parseInt(msg.code, 10);
      const keys = [...this.pending.keys()];
      // Salvavidas: si el servidor manda un error sin poder identificar a qué
      // petición corresponde (p.ej. traceId mal formado) y solo hay una
      // petición esperando, se la damos por respondida en vez de dejarla morir
      // de timeout sin motivo aparente.
      if (code !== 0 && code !== -1 && keys.length === 1) {
        matchedTraceId = keys[0];
        pending = this.pending.get(matchedTraceId);
        this._log(`Error sin traceId reconocible, asignado a la única petición pendiente (${matchedTraceId})`);
      } else {
        // Puede ser una push asíncrona sin traceId propio (p.ej. la respuesta
        // real de get_consumables llega así, aparte del ack del transmit).
        if (msg.tag === "sweeper-transmit/to_bind") {
          const content = this._maybeJson(msg.content);
          if (content && typeof content === "object" && content.control === METHOD_GET_CONSUMABLES) {
            this.consumables = content;
            this.consumablesAt = Date.now();
          }
        }
        this._log(`Sin petición pendiente para traceId=${JSON.stringify(msg.traceId)} (pendientes activos: ${JSON.stringify(keys)})`);
        return;
      }
    }
    this.pending.delete(matchedTraceId);
    const code = parseInt(msg.code, 10);
    if (!(code === 0 || code === -1)) {
      const message = msg.msg || ev.data;
      if (msg.service === SERVICE_LOGIN) pending.reject(new CongaAuthError(message));
      else pending.reject(new CongaError(message));
      return;
    }
    pending.resolve(msg);
  }

  _basePayload() {
    return {
      factoryId: FACTORY_ID,
      projectType: PROJECT_TYPE,
      versionName: VERSION_NAME,
      versionCode: VERSION_CODE,
      packageVersions: [{ packageType: PACKAGE_TYPE, version: VERSION_CODE }],
    };
  }

  async _request(method, service, content) {
    await this._ensureSocket();
    // El servidor solo acepta traceId puramente numérico (igual que el cliente
    // Python original, str(int(time.time()*1000))) — con letras/guiones responde
    // con un error de "formato de datos no reconocido" y traceId:"0".
    const traceId = String(Date.now());
    const packet = { traceId, method, service, content };
    const t0 = Date.now();
    this._log(`Enviando ${service} (readyState=${this.ws.readyState})…`);
    const promise = new Promise((resolve, reject) => {
      this.pending.set(traceId, {
        resolve: (v) => { this._log(`Respuesta de ${service} recibida (${Date.now() - t0} ms)`); resolve(v); },
        reject: (e) => { this._log(`${service} falló a los ${Date.now() - t0} ms: ${e.message || e}`); reject(e); },
      });
      setTimeout(() => {
        if (this.pending.has(traceId)) {
          this.pending.delete(traceId);
          this._log(`Timeout de ${service} a los ${Date.now() - t0} ms (readyState=${this.ws ? this.ws.readyState : "sin socket"})`);
          reject(new CongaError(`Tiempo agotado esperando respuesta de ${service}`));
        }
      }, 20000);
    });
    try {
      this.ws.send(JSON.stringify(packet));
    } catch (e) {
      this._log(`ws.send() lanzó excepción: ${e.message || e}`);
      throw new CongaError(`No se pudo enviar la petición: ${e.message || e}`);
    }
    return promise;
  }

  async _ensureLoggedIn() {
    await this._ensureSocket();
    if (this.loggedIn) return;
    const payload = { ...this._basePayload(), username: this.username, password: this.password, lang: "en" };
    const response = await this._request("POST", SERVICE_LOGIN, JSON.stringify(payload));
    const result = response.result || {};
    if (!result.data || !result.data.AUTH) throw new CongaAuthError("La nube no devolvió un token de sesión válido");
    this.loggedIn = true;
  }

  async _transmit(content) {
    await this._ensureLoggedIn();
    if (!this.robotId) await this.listVacuums();
    return this._request("POST", SERVICE_TRANSMIT, JSON.stringify(content));
  }

  async listVacuums() {
    await this._ensureLoggedIn();
    const response = await this._request("GET", SERVICE_USER_GET_BIND_ROBOT, "");
    let result = response.result || [];
    if (result && result.result) result = result.result;
    const devices = (result || []).map((item) => ({
      robotId: parseInt(item.robotId || item.id || item.did, 10),
      sn: String(item.sn || item.mac || item.robotId),
      name: item.nickname || item.note_name || item.sn,
    }));
    if (devices.length) {
      this.robotId = devices[0].robotId;
      this.sn = devices[0].sn;
    }
    return devices;
  }

  _deviceCtrlData(control, first, second) {
    const data = {
      control, result: -1, type: -1, value: -1, ctrltype: -1, is_open: -1,
      begin_time: 1, end_time: 1, voiceMode: -1, volume: -1, isSave: -1,
    };
    if (control === METHOD_SET_MODE) { data.type = first; data.value = second; }
    else if (control === METHOD_SET_PREFERENCE) { data.ctrltype = first; data.value = second; }
    return data;
  }

  async updateStatus() {
    const response = await this._transmit({
      clientType: "ROBOT",
      targets: [this.robotId],
      data: this._deviceCtrlData(METHOD_GET_STATUS, -1, -1),
    });
    const status = this._extractStatus(response);
    this.shadow = this._normalizeStatus(status || {});
    return this.shadow;
  }

  _extractStatus(response) {
    let result = response.result;
    if (typeof result === "string") result = this._maybeJson(result);
    if (result && typeof result === "object") {
      let content = result.content;
      if (typeof content === "string") content = this._maybeJson(content);
      if (content && typeof content === "object") result = content;
      if (result.data && typeof result.data === "object") return result.data;
    }
    return {};
  }

  _maybeJson(v) { try { return JSON.parse(v); } catch { return v; } }

  _normalizeStatus(s) {
    const battery = this._normBattery(s.battary ?? s.battery);
    const workMode = parseInt(s.workMode ?? -1, 10);
    const chargeStatus = parseInt(s.chargeStatus ?? 0, 10);
    const fault = parseInt(s.faultCode ?? s.fault ?? 0, 10);
    const roomIdToName = Object.fromEntries(Object.entries(this.rooms).map(([k, v]) => [v, k]));
    return {
      battery,
      mode: this._statusName(workMode, chargeStatus, fault),
      faultCode: fault,
      faultDescription: fault ? (FAULT_DESCRIPTIONS[fault] || `Código ${fault} sin identificar todavía`) : null,
      faultIsWarning: !!fault && !INFO_FAULTS.has(fault),
      fanSpeed: parseInt(s.cleanPerference ?? 0, 10),
      waterLevel: parseInt(s.waterlevel ?? 0, 10),
      cleanTime: parseInt(s.cleanTime ?? 0, 10),
      cleanArea: this._normArea(s.cleanSize),
      currentMapName: s.current_map_name || "",
      houseName: s.house_name || "",
      cleaningRoom: roomIdToName[parseInt(s.cleaning_roomId ?? 0, 10)] || null,
      dustBoxType: parseInt(s.dustBox_type ?? 0, 10),
      cleanMode: parseInt(s.type ?? -1, 10),
      repeatClean: !!parseInt(s.repeatClean ?? 0, 10),
    };
  }

  _normBattery(v) { let b = parseInt(v ?? 0, 10); if (b > 100) b -= 100; return Math.max(0, Math.min(b, 100)); }
  _normArea(v) { return Math.round((parseInt(v ?? 0, 10) / 100) * 100) / 100; }

  _statusName(workMode, chargeStatus, fault) {
    if (KNOWN_FAULTS[fault]) return KNOWN_FAULTS[fault];
    if (fault) return "error";
    if (chargeStatus === 1) return "backcharge";
    if (chargeStatus === 2 || chargeStatus === 3) return "charge";
    if (workMode === VALUE_START) return "sweep";
    if (workMode === VALUE_PAUSE) return "pause";
    if (workMode === VALUE_STOP || workMode === -1) return "idle";
    return "unknown";
  }

  async _setMode(modeType, value) {
    await this._transmit({ clientType: "ROBOT", targets: [this.robotId], data: this._deviceCtrlData(METHOD_SET_MODE, modeType, value) });
  }
  async start(fanSpeed = 1) { await this.setFanSpeed(fanSpeed); await this._setMode(MODE_AUTO, VALUE_START); }
  async pause() { await this._setMode(MODE_AUTO, VALUE_PAUSE); }
  async stop() { await this._setMode(MODE_AUTO, VALUE_STOP); }
  async home() { await this._setMode(MODE_BACK_CHARGE, VALUE_START); }
  async rescan() { await this._setMode(MODE_EXPLORE, VALUE_START); }

  async setFanSpeed(level) {
    await this._transmit({ clientType: "ROBOT", targets: [this.robotId], data: this._deviceCtrlData(METHOD_SET_PREFERENCE, PREFERENCE_POWER, level) });
  }
  async setWaterLevel(level) {
    await this._transmit({ clientType: "ROBOT", targets: [this.robotId], data: this._deviceCtrlData(METHOD_SET_PREFERENCE, PREFERENCE_WATER, level) });
  }

  // Comando capturado con mitmproxy (03/09/2026) viendo el tráfico real de la
  // app oficial al pulsar "limpiar esta habitación": setRoomCleanPlan con un
  // "order" efímero (orderid/mapid/day_time/weekday a 0, enable:0), no el
  // setRoomClean+roomsID de antes, que nunca respetaba la habitación pedida.
  async startRoom(roomName, { fanSpeed = 1, waterLevel = 1, twiceClean = false, cleanMode = 0 } = {}) {
    const id = this.rooms[roomName];
    if (!id) throw new CongaError("Habitación desconocida: " + roomName);
    await this._transmit({
      clientType: "ROBOT", targets: [this.robotId],
      data: {
        control: METHOD_SET_ROOM_CLEAN_PLAN,
        order: {
          enable: 0, repeat: 0, orderid: 0, weekday: 0, day_time: 0, mapid: 0,
          roomPer: [{
            room_id: id, room_name: roomName, cleanmode: cleanMode, sweep_mode: 0,
            windpower: fanSpeed, waterlevel: waterLevel, twiceclean: twiceClean ? 1 : 0,
            carpet: 0, room_material: 0, room_type: 0,
            isDone: false, isExist: false, isExpland: false,
          }],
          virwallList: [], arealist: [],
        },
      },
    });
  }

  // Horas de uso de filtro/cepillos/mopa y % de vida útil restante (deducido,
  // ver CONSUMABLE_LIFETIME_HOURS). La respuesta llega como push aparte del
  // ack, así que se espera un momento a que this.consumables se actualice
  // (lo hace _onMessage en segundo plano) antes de calcular el resultado.
  async getConsumables() {
    const before = this.consumablesAt;
    await this._transmit({
      clientType: "ROBOT", targets: [this.robotId],
      data: this._deviceCtrlData(METHOD_GET_CONSUMABLES, -1, -1),
    });
    const deadline = Date.now() + 3000;
    while (this.consumablesAt <= before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const result = {};
    for (const [key, lifetime] of Object.entries(CONSUMABLE_LIFETIME_HOURS)) {
      const used = parseInt(this.consumables[key] ?? 0, 10);
      const remaining = Math.max(0, lifetime - used);
      result[key] = {
        hoursUsed: used,
        hoursRemaining: remaining,
        percentRemaining: lifetime ? Math.round((remaining / lifetime) * 100) : 0,
      };
    }
    return result;
  }

  // Control manual tipo joystick (set_direct, capturado con mitmproxy el
  // 03/09/2026). Significado exacto de `direction` sin confirmar del todo —
  // ver CONGA_PROTOCOL.md.
  async manualMove(direction, angle = 0.0) {
    await this._transmit({
      clientType: "ROBOT", targets: [this.robotId],
      data: { control: METHOD_SET_DIRECT, direction, angle },
    });
  }
}
