import dotenv from "dotenv";
import express from "express";
import cron from "node-cron";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

/**
 * =========================
 * Configuración general
 * =========================
 */

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ADMIN_IDS,
  TELEGRAM_ALLOWED_IDS,
  VRM_TOKEN,
  VRM_USER_ID,
  CRON_TIME = "0 8 * * *",
  TIMEZONE = "Atlantic/Canary",
  OFFLINE_THRESHOLD_MINUTES = "60",
  PORT = 3000
} = process.env;

const VRM_BASE_URL = "https://vrmapi.victronenergy.com/v2";
const TELEGRAM_MAX_LENGTH = 3900;

const offlineThresholdMinutes = Number(OFFLINE_THRESHOLD_MINUTES);

// Configuración de usuarios autorizados
const ADMIN_IDS = TELEGRAM_ADMIN_IDS
  ? TELEGRAM_ADMIN_IDS.split(',').map(id => String(id.trim()))
  : [];

const ALLOWED_IDS = TELEGRAM_ALLOWED_IDS
  ? TELEGRAM_ALLOWED_IDS.split(',').map(id => String(id.trim()))
  : [];

const authorizedChatIds = [...ADMIN_IDS, ...ALLOWED_IDS];

if (authorizedChatIds.length === 0) {
  throw new Error("Debe configurar TELEGRAM_ADMIN_IDS o TELEGRAM_ALLOWED_IDS");
}

if (ADMIN_IDS.length === 0) {
  console.warn("[WARN] No hay administradores configurados. Algunas funciones restringidas no estarán disponibles.");
}

console.log(`[BOT] Administradores: ${ADMIN_IDS.length}`);
console.log(`[BOT] Usuarios autorizados: ${authorizedChatIds.length}`);

// Validaciones obligatorias
if (!TELEGRAM_BOT_TOKEN) throw new Error("Falta TELEGRAM_BOT_TOKEN");
if (!VRM_TOKEN) throw new Error("Falta VRM_TOKEN");
if (!VRM_USER_ID) throw new Error("Falta VRM_USER_ID");
if (!Number.isFinite(offlineThresholdMinutes)) {
  throw new Error("OFFLINE_THRESHOLD_MINUTES debe ser un número");
}

/**
 * =========================
 * Express health check
 * =========================
 */

const app = express();

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "victron-vrm-telegram-bot",
    time: new Date().toISOString(),
    stats: {
      admins: ADMIN_IDS.length,
      users: authorizedChatIds.length
    }
  });
});

app.listen(PORT, () => {
  console.log(`[HTTP] Health check activo en puerto ${PORT}`);
});

/**
 * =========================
 * Telegram Bot
 * =========================
 */

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: true
});

console.log("[BOT] Bot de Telegram iniciado en modo polling");

/**
 * Configurar comandos del bot (menú /)
 */
async function setupBotCommands() {
  try {
    await bot.setMyCommands([
      { command: "start", description: "🟢 Iniciar bot y mostrar menú principal" },
      { command: "test", description: "📴 Verificar instalaciones offline" },
      { command: "soc", description: "🔋 Consultar estado de carga de baterías (SoC)" },
      { command: "listar", description: "📡 Listar todas las instalaciones VRM" },
      { command: "estado", description: "ℹ️ Mostrar estado del bot y configuración" },
      { command: "usuarios", description: "👥 Listar usuarios autorizados (solo admin)" },
      { command: "broadcast", description: "📢 Enviar mensaje a todos (solo admin)" }
    ]);
    console.log("[BOT] Comandos del bot configurados correctamente");
  } catch (error) {
    console.error("[BOT] Error configurando comandos:", error.message);
  }
}
setupBotCommands();

/**
 * Comprueba si el mensaje viene de un chat autorizado.
 */
function isAuthorizedChat(msg) {
  return authorizedChatIds.includes(String(msg.chat.id));
}

/**
 * Comprueba si el usuario es administrador.
 */
function isAdmin(msg) {
  return ADMIN_IDS.includes(String(msg.chat.id));
}

/**
 * Envía un mensaje a todos los usuarios autorizados.
 */
async function sendToAllAuthorized(text, options = {}) {
  const results = [];
  for (const chatId of authorizedChatIds) {
    try {
      await bot.sendMessage(chatId, text, options);
      results.push({ chatId, success: true });
      // Pequeña pausa para evitar rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`[BOT] Error enviando a ${chatId}:`, error.message);
      results.push({ chatId, success: false, error: error.message });
    }
  }
  return results;
}

/**
 * Envía mensajes largos dividiéndolos en varios mensajes.
 */
async function sendLongMessage(chatId, text) {
  if (!text) return;

  const chunks = [];
  let remaining = text;

  while (remaining.length > TELEGRAM_MAX_LENGTH) {
    let splitIndex = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);

    if (splitIndex === -1 || splitIndex < 1000) {
      splitIndex = TELEGRAM_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk, {
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  }
}

/**
 * =========================
 * Cliente API Victron VRM
 * =========================
 */

async function vrmFetch(path) {
  const url = `${VRM_BASE_URL}${path}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-authorization": `Token ${VRM_TOKEN}`,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `VRM API error ${response.status} ${response.statusText}: ${errorText.slice(0, 300)}`
      );
    }

    return await response.json();
  } catch (error) {
    console.error(`[VRM] Error consultando ${path}:`, error.message);
    throw error;
  }
}

/**
 * Obtiene todas las instalaciones del usuario.
 */
async function getInstallations() {
  console.log("[VRM] Consultando instalaciones...");

  const data = await vrmFetch(
    `/users/${encodeURIComponent(VRM_USER_ID)}/installations?extended=1`
  );

  const installations = Array.isArray(data?.records)
    ? data.records
    : Array.isArray(data?.installations)
      ? data.installations
      : Array.isArray(data)
        ? data
        : [];

  console.log(`[VRM] Instalaciones encontradas: ${installations.length}`);
  
  // Enriquecer cada instalación con su estado online
  const installationsWithStatus = [];
  for (const installation of installations) {
    const idSite = getInstallationId(installation);
    if (idSite) {
      const statusInfo = await getInstallationStatus(installation, idSite);
      installationsWithStatus.push({
        ...installation,
        _statusInfo: statusInfo
      });
    } else {
      installationsWithStatus.push(installation);
    }
  }
  
  return installationsWithStatus;
}

/**
 * Obtiene las alarmas de una instalación.
 */
async function getInstallationAlarms(idSite) {
  console.log(`[VRM] Consultando alarmas de instalación ${idSite}...`);

  return await vrmFetch(
    `/installations/${encodeURIComponent(idSite)}/alarms`
  );
}

/**
 * Normaliza lastConnection.
 */
function normalizeTimestamp(lastConnection) {
  if (
    lastConnection === null ||
    lastConnection === undefined ||
    lastConnection === ""
  ) {
    return null;
  }

  const value = Number(lastConnection);

  if (!Number.isFinite(value)) {
    return null;
  }

  const timestampMs = value > 1_000_000_000_000
    ? value
    : value * 1000;

  const date = new Date(timestampMs);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

/**
 * Formatea una duración en texto legible.
 */
function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return "desconocido";
  }

  const totalMinutes = Math.floor(milliseconds / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts = [];

  if (days > 0) parts.push(`${days} día${days !== 1 ? "s" : ""}`);
  if (hours > 0) parts.push(`${hours} hora${hours !== 1 ? "s" : ""}`);
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes} minuto${minutes !== 1 ? "s" : ""}`);
  }

  return parts.join(", ");
}

/**
 * Extrae un nombre razonable de instalación.
 */
function getInstallationName(installation) {
  return (
    installation?.name ||
    installation?.siteName ||
    installation?.description ||
    "Instalación sin nombre"
  );
}

/**
 * Extrae idSite de forma tolerante.
 */
function getInstallationId(installation) {
  return (
    installation?.idSite ||
    installation?.idsite ||
    installation?.siteId ||
    installation?.id
  );
}

/**
 * Determina si una instalación está online basado en sus dispositivos
 */
async function getInstallationStatus(installation, idSite) {
  const possibleStatus = 
    installation?.status ||
    installation?.state ||
    installation?.connectionState ||
    installation?.isOnline;
  
  if (possibleStatus === true) return { isOnline: true, status: "Online", lastConnection: null };
  if (possibleStatus === false) return { isOnline: false, status: "Offline", lastConnection: null };
  if (typeof possibleStatus === "string" && possibleStatus.toLowerCase() === "online") {
    return { isOnline: true, status: "Online", lastConnection: null };
  }
  
  try {
    const alarms = await getInstallationAlarms(idSite);
    
    const devices = Array.isArray(alarms?.devices)
      ? alarms.devices
      : Array.isArray(alarms?.records?.devices)
        ? alarms.records.devices
        : [];
    
    if (devices.length === 0) {
      return { isOnline: false, status: "Sin dispositivos", lastConnection: null };
    }
    
    let latestConnection = null;
    let onlineDevices = 0;
    
    for (const device of devices) {
      const lastConnectionDate = normalizeTimestamp(device?.lastConnection);
      
      if (lastConnectionDate) {
        if (!latestConnection || lastConnectionDate > latestConnection) {
          latestConnection = lastConnectionDate;
        }
        
        const now = new Date();
        const diffMinutes = (now.getTime() - lastConnectionDate.getTime()) / 60000;
        if (diffMinutes < 15) {
          onlineDevices++;
        }
      }
    }
    
    if (!latestConnection) {
      return { isOnline: false, status: "Sin conexión registrada", lastConnection: null };
    }
    
    const now = new Date();
    const diffMinutes = (now.getTime() - latestConnection.getTime()) / 60000;
    const isOnline = diffMinutes < offlineThresholdMinutes;
    
    let statusText = "";
    if (isOnline) {
      if (onlineDevices > 0) {
        statusText = `Online (${onlineDevices} disp. activos)`;
      } else {
        statusText = "Online";
      }
    } else {
      const hoursOffline = Math.floor(diffMinutes / 60);
      const minutesOffline = Math.floor(diffMinutes % 60);
      if (hoursOffline > 0) {
        statusText = `Offline (${hoursOffline}h ${minutesOffline}m)`;
      } else {
        statusText = `Offline (${minutesOffline}m)`;
      }
    }
    
    return {
      isOnline,
      status: statusText,
      lastConnection: latestConnection
    };
    
  } catch (error) {
    console.error(`[ERROR] Error obteniendo estado para ${idSite}:`, error.message);
    return { isOnline: false, status: "Error consultando estado", lastConnection: null };
  }
}

/**
 * Revisa todas las instalaciones para detectar offline.
 */
async function checkOfflineInstallations() {
  const now = new Date();
  const thresholdMs = offlineThresholdMinutes * 60 * 1000;

  const installations = await getInstallations();
  const offlineInstallations = [];
  const warnings = [];

  for (const installation of installations) {
    const idSite = getInstallationId(installation);
    const installationName = getInstallationName(installation);

    if (!idSite) {
      warnings.push(`Instalación sin idSite: ${installationName}`);
      console.warn(`[WARN] Instalación sin idSite: ${installationName}`);
      continue;
    }

    try {
      const alarms = await getInstallationAlarms(idSite);

      const devices = Array.isArray(alarms?.devices)
        ? alarms.devices
        : Array.isArray(alarms?.records?.devices)
          ? alarms.records.devices
          : [];

      if (!devices.length) {
        warnings.push(`Sin devices en alarmas para ${installationName} (${idSite})`);
        console.warn(`[WARN] Sin devices para ${installationName} (${idSite})`);
        continue;
      }

      let latestConnection = null;
      let latestDeviceName = null;
      let validConnections = 0;

      for (const device of devices) {
        const lastConnectionDate = normalizeTimestamp(device?.lastConnection);

        if (!lastConnectionDate) {
          console.warn(
            `[WARN] Dispositivo sin lastConnection válido en ${installationName} (${idSite})`
          );
          continue;
        }

        validConnections++;

        if (!latestConnection || lastConnectionDate > latestConnection) {
          latestConnection = lastConnectionDate;
          latestDeviceName =
            device?.name ||
            device?.customName ||
            device?.productName ||
            device?.deviceName ||
            device?.idDevice ||
            "Dispositivo no identificado";
        }
      }

      if (!latestConnection) {
        warnings.push(
          `No hay lastConnection válido para ningún dispositivo en ${installationName} (${idSite})`
        );
        continue;
      }

      const diffMs = now.getTime() - latestConnection.getTime();

      if (diffMs > thresholdMs) {
        offlineInstallations.push({
          installationName,
          idSite,
          deviceName: latestDeviceName,
          lastConnection: latestConnection,
          elapsed: formatDuration(diffMs),
          diffMs,
          validConnections,
          totalDevices: devices.length
        });
      }
    } catch (error) {
      warnings.push(
        `Error consultando instalación ${installationName} (${idSite}): ${error.message}`
      );
      console.error(
        `[ERROR] Fallo en instalación ${installationName} (${idSite}):`,
        error.message
      );
    }
  }

  return {
    checkedAt: now,
    totalInstallations: installations.length,
    offlineDevices: offlineInstallations,
    warnings
  };
}

/**
 * Evita problemas básicos con HTML en Telegram.
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Formatea una incidencia offline.
 */
function formatOfflineDevice(item) {
  return [
    "🚨 <b>Instalación offline</b>",
    `• Nombre: <b>${escapeHtml(item.installationName)}</b>`,
    `• ID instalación: <code>${escapeHtml(String(item.idSite))}</code>`,
    `• Último dispositivo activo: ${escapeHtml(String(item.deviceName))}`,
    `• Última conexión: ${item.lastConnection.toLocaleString("es-ES", {
      timeZone: TIMEZONE
    })}`,
    `• Tiempo transcurrido: <b>${escapeHtml(item.elapsed)}</b>`,
    `• Dispositivos revisados: ${item.validConnections}/${item.totalDevices}`
  ].join("\n");
}

/**
 * =========================
 * FUNCIONES DE BATERÍA (SoC)
 * =========================
 */

async function getBatteryStatus(idSite) {
  console.log(`[VRM] Consultando SoC para instalación ${idSite}...`);
  
  try {
    const data = await vrmFetch(
      `/installations/${encodeURIComponent(idSite)}/stats?bs=1`
    );
    
    if (!data?.success || !data?.records?.bs) {
      console.warn(`[VRM] Respuesta inválida para ${idSite}`);
      return {
        soc: null,
        lastUpdated: null,
        deviceName: "N/A",
        error: "Respuesta API inválida"
      };
    }
    
    const bsRecords = data.records.bs;
    
    if (!Array.isArray(bsRecords) || bsRecords.length === 0) {
      console.warn(`[VRM] No hay registros bs para ${idSite}`);
      return {
        soc: null,
        lastUpdated: null,
        deviceName: "N/A",
        error: "Sin datos de batería"
      };
    }
    
    const lastRecord = bsRecords[bsRecords.length - 1];
    const timestamp = lastRecord[0];
    const socValue = lastRecord[1];
    
    if (!timestamp || socValue === undefined || socValue === null) {
      return {
        soc: null,
        lastUpdated: null,
        deviceName: "N/A",
        error: "Datos incompletos"
      };
    }
    
    const lastUpdated = new Date(timestamp);
    const soc = Math.round(socValue);
    
    console.log(`[VRM] SoC para ${idSite}: ${soc}% (actualizado: ${lastUpdated.toISOString()})`);
    
    return {
      soc: soc,
      lastUpdated: lastUpdated,
      deviceName: "Batería VRM",
      rawValue: socValue
    };
    
  } catch (error) {
    console.error(`[VRM] Error obteniendo SoC para ${idSite}:`, error.message);
    return {
      soc: null,
      lastUpdated: null,
      deviceName: "N/A",
      error: error.message
    };
  }
}

async function getAllInstallationsWithBatteryStatus() {
  const installations = await getInstallations();
  const results = [];
  
  for (const installation of installations) {
    const idSite = getInstallationId(installation);
    const installationName = getInstallationName(installation);
    const statusInfo = installation._statusInfo || { status: "Desconocido" };
    
    if (!idSite) {
      results.push({
        idSite: null,
        name: installationName,
        status: statusInfo.status,
        battery: null,
        error: "Sin ID de instalación"
      });
      continue;
    }
    
    try {
      const batteryStatus = await getBatteryStatus(idSite);
      
      results.push({
        idSite,
        name: installationName,
        status: statusInfo.status,
        isOnline: statusInfo.isOnline,
        battery: batteryStatus.soc,
        lastUpdated: batteryStatus.lastUpdated,
        deviceName: batteryStatus.deviceName,
        error: batteryStatus.error || null
      });
      
      await new Promise(resolve => setTimeout(resolve, 200));
      
    } catch (error) {
      results.push({
        idSite,
        name: installationName,
        status: statusInfo.status,
        battery: null,
        error: error.message
      });
    }
  }
  
  return results;
}

function getBatteryEmoji(soc) {
  if (soc === null) return "❓";
  if (soc >= 80) return "🟢";
  if (soc >= 50) return "🟡";
  if (soc >= 20) return "🟠";
  return "🔴";
}

function formatBatteryBar(soc, width = 10) {
  if (soc === null) return "░░░░░░░░░░";
  const filled = Math.round((soc / 100) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function formatBatteryReport(installations) {
  const lines = [
    "🔋 <b>ESTADO DE BATERÍAS VRM</b>",
    "",
    `📊 <i>Reporte generado: ${new Date().toLocaleString("es-ES", {
      timeZone: TIMEZONE
    })}</i>`,
    ""
  ];
  
  let validReadings = 0;
  let totalSoc = 0;
  let warnings = 0;
  
  for (const inst of installations) {
    const emoji = getBatteryEmoji(inst.battery);
    const statusEmoji = inst.isOnline ? "🟢" : "🔴";
    
    lines.push(`${emoji} <b>${escapeHtml(inst.name)}</b>`);
    lines.push(`└ 📍 ID: <code>${escapeHtml(String(inst.idSite))}</code>`);
    lines.push(`└ 📡 Estado: ${statusEmoji} ${escapeHtml(String(inst.status))}`);
    
    if (inst.battery !== null && !isNaN(inst.battery)) {
      const batteryBar = formatBatteryBar(inst.battery);
      lines.push(`└ 🔋 SoC: <b>${inst.battery}%</b> ${batteryBar}`);
      
      if (inst.lastUpdated) {
        const timeAgo = Math.floor((Date.now() - new Date(inst.lastUpdated).getTime()) / 60000);
        const timeAgoText = timeAgo < 1 ? "hace menos de 1 minuto" : 
                           timeAgo === 1 ? "hace 1 minuto" : 
                           `hace ${timeAgo} minutos`;
        lines.push(`└ 🕐 ${timeAgoText}`);
      }
      
      validReadings++;
      totalSoc += inst.battery;
    } else if (inst.error) {
      lines.push(`└ ⚠️ <i>${escapeHtml(inst.error)}</i>`);
      warnings++;
    } else {
      lines.push(`└ ⚠️ <i>Sin datos de batería disponibles</i>`);
      warnings++;
    }
    
    lines.push("");
  }
  
  if (validReadings > 0) {
    const avgSoc = Math.round(totalSoc / validReadings);
    const avgEmoji = getBatteryEmoji(avgSoc);
    lines.push("📈 <b>RESUMEN</b>");
    lines.push(`└ 📊 Instalaciones con datos: ${validReadings}/${installations.length}`);
    lines.push(`└ ${avgEmoji} SoC promedio: <b>${avgSoc}%</b>`);
    if (warnings > 0) {
      lines.push(`└ ⚠️ Advertencias/errores: ${warnings}`);
    }
  }
  
  return lines.join("\n");
}

/**
 * =========================
 * Handlers de comandos
 * =========================
 */

// /start
bot.onText(/^\/start$/, async (msg) => {
  if (!isAuthorizedChat(msg)) {
    await bot.sendMessage(msg.chat.id, "❌ No estás autorizado para usar este bot.");
    console.warn(`[SECURITY] Chat no autorizado: ${msg.chat.id}`);
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    [
      "⚓ <b>AUTORIDAD PORTUARIA DE SANTA CRUZ DE TENERIFE</b>",
      "<i>Sistemas de Ayudas a la Navegación</i>",
      "",
      "━━━━━━━━━━━━━━━━━━━━━━",
      "",
      "🟢 <b>Estado del Sistema VRM</b>",
      "",
      "🗺️ <b>Instalaciones monitoreadas:</b>",
      "• Sistemas de alimentación ininterrumpida",
      "• Equipos de señalización marítima",
      "• Estaciones de control de tráfico portuario",
      "• Respaldo energético en faros y boyas",
      "",
      "📊 <b>Métricas en tiempo real:</b>",
      "• 🔋 Estado de carga de baterías (SoC)",
      "• ⚡ Consumo y generación energética",
      "• 🌐 Estado de conectividad de equipos",
      "• 🚨 Alertas automáticas de fallos",
      "",
      "━━━━━━━━━━━━━━━━━━━━━━",
      "",
      "🤖 <i>Bot desarrollado para supervisión remota",
      "del sistema de gestión energética Victron VRM</i>",
      "",
      "<b>Selecciona una opción:</b>"
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: {
        keyboard: [
          [{ text: "📴 Instalaciones Offline" }, { text: "🔋 Consultar SoC" }],
          [{ text: "📡 Listar Instalaciones" }, { text: "ℹ️ Estado del Bot" }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    }
  );
});

// /test
bot.onText(/^\/test$/, async (msg) => {
  if (!isAuthorizedChat(msg)) return;
  
  console.log(`[BOT] Usuario ${msg.chat.id} ejecutó /test`);
  await bot.sendMessage(msg.chat.id, "🔎 Ejecutando comprobación manual de instalaciones VRM...");

  try {
    const result = await checkOfflineInstallations();

    const lines = [
      "📋 <b>Resumen de comprobación VRM</b>",
      "",
      `• Fecha: ${result.checkedAt.toLocaleString("es-ES", { timeZone: TIMEZONE })}`,
      `• Instalaciones revisadas: <b>${result.totalInstallations}</b>`,
      `• Alertas detectadas: <b>${result.offlineDevices.length}</b>`,
      ""
    ];

    if (result.offlineDevices.length === 0) {
      lines.push("✅ Todas las instalaciones están online.");
    } else {
      lines.push("🚨 <b>Instalaciones con alerta:</b>");
      lines.push("");

      for (const item of result.offlineDevices) {
        lines.push(formatOfflineDevice(item));
        lines.push("");
      }
    }

    if (result.warnings.length > 0) {
      lines.push("");
      lines.push("⚠️ <b>Advertencias:</b>");
      for (const warning of result.warnings) {
        lines.push(`• ${escapeHtml(warning)}`);
      }
    }

    await sendLongMessage(msg.chat.id, lines.join("\n"));
  } catch (error) {
    console.error("[BOT] Error en /test:", error.message);
    await bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
  }
});

// /listar
bot.onText(/^\/listar$/, async (msg) => {
  if (!isAuthorizedChat(msg)) return;
  
  console.log(`[BOT] Usuario ${msg.chat.id} ejecutó /listar`);

  try {
    await bot.sendMessage(msg.chat.id, "📡 Obteniendo lista de instalaciones...");
    
    const installations = await getInstallations();

    if (!installations.length) {
      await bot.sendMessage(msg.chat.id, "No se encontraron instalaciones para este usuario.");
      return;
    }

    const lines = [
      "📡 <b>INSTALACIONES VRM MONITORIZADAS</b>",
      "",
      `Total: <b>${installations.length}</b>`,
      "━━━━━━━━━━━━━━━━━━━━━━",
      ""
    ];

    for (const installation of installations) {
      const name = getInstallationName(installation);
      const idSite = getInstallationId(installation);
      
      let statusText = "";
      let statusEmoji = "";
      let lastConnectionInfo = "";
      
      if (installation._statusInfo) {
        const info = installation._statusInfo;
        statusEmoji = info.isOnline ? "🟢" : "🔴";
        statusText = info.status;
        
        if (info.lastConnection) {
          const timeAgo = Math.floor((Date.now() - info.lastConnection.getTime()) / 60000);
          const timeText = timeAgo < 1 ? "hace momentos" : 
                          timeAgo === 1 ? "hace 1 minuto" : 
                          `hace ${timeAgo} minutos`;
          lastConnectionInfo = `\n└ 🕐 Última conexión: ${timeText}`;
        }
      } else {
        statusEmoji = "⚫";
        statusText = "No disponible";
      }
      
      lines.push(`${statusEmoji} <b>${escapeHtml(name)}</b>`);
      lines.push(`└ 📍 ID: <code>${escapeHtml(String(idSite ?? "sin idSite"))}</code>`);
      lines.push(`└ 📡 Estado: ${escapeHtml(String(statusText))}${lastConnectionInfo}`);
      lines.push("");
    }

    lines.push("━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("🟢 Online  🔴 Offline");
    
    await sendLongMessage(msg.chat.id, lines.join("\n"));
  } catch (error) {
    console.error("[BOT] Error en /listar:", error.message);
    await bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
  }
});

// /soc
bot.onText(/^\/soc$/, async (msg) => {
  if (!isAuthorizedChat(msg)) return;
  
  console.log(`[BOT] Usuario ${msg.chat.id} ejecutó /soc`);
  await bot.sendMessage(msg.chat.id, "🔍 Consultando estado de baterías...");
  
  try {
    const installations = await getAllInstallationsWithBatteryStatus();
    
    if (installations.length === 0) {
      await bot.sendMessage(msg.chat.id, "❌ No se encontraron instalaciones.");
      return;
    }
    
    const report = formatBatteryReport(installations);
    await sendLongMessage(msg.chat.id, report);
    
  } catch (error) {
    console.error("[BOT] Error en /soc:", error.message);
    await bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
  }
});

// /estado
bot.onText(/^\/estado$/, async (msg) => {
  if (!isAuthorizedChat(msg)) return;
  
  await sendLongMessage(
    msg.chat.id,
    [
      "🟢 <b>Bot activo</b>",
      "",
      `Cron: <code>${escapeHtml(CRON_TIME)}</code>`,
      `Zona horaria: <code>${escapeHtml(TIMEZONE)}</code>`,
      `Umbral offline: <b>${offlineThresholdMinutes}</b> minutos`,
      "",
      "👥 <b>Usuarios autorizados:</b>",
      `• Administradores: ${ADMIN_IDS.length}`,
      `• Total usuarios: ${authorizedChatIds.length}`,
      "",
      "Comandos disponibles:",
      "• /test - Verificar instalaciones offline",
      "• /soc - Ver SoC de baterías",
      "• /listar - Listar instalaciones",
      "• /estado - Estado del bot",
      "• /usuarios - Listar usuarios (admin)",
      "• /broadcast - Mensaje masivo (admin)"
    ].join("\n")
  );
});

// /usuarios (solo admin)
bot.onText(/^\/usuarios$/, async (msg) => {
  if (!isAuthorizedChat(msg)) return;
  if (!isAdmin(msg)) {
    await bot.sendMessage(msg.chat.id, "❌ Solo administradores pueden ver la lista de usuarios.");
    return;
  }
  
  const lines = [
    "👥 <b>USUARIOS AUTORIZADOS</b>",
    "",
    `👑 <b>Administradores (${ADMIN_IDS.length}):</b>`
  ];
  
  ADMIN_IDS.forEach(id => lines.push(`• <code>${id}</code>`));
  
  lines.push("");
  lines.push(`📋 <b>Usuarios (${ALLOWED_IDS.length}):</b>`);
  ALLOWED_IDS.forEach(id => lines.push(`• <code>${id}</code>`));
  
  lines.push("");
  lines.push(`Total: <b>${authorizedChatIds.length}</b> usuarios`);
  
  await bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "HTML" });
});

// /broadcast (solo admin)
bot.onText(/^\/broadcast (.+)$/, async (msg, match) => {
  if (!isAuthorizedChat(msg)) return;
  if (!isAdmin(msg)) {
    await bot.sendMessage(msg.chat.id, "❌ Solo administradores pueden usar /broadcast");
    return;
  }
  
  const message = match[1];
  const adminName = msg.from?.first_name || msg.from?.username || msg.chat.id;
  
  console.log(`[BOT] Admin ${adminName} envió broadcast: ${message.substring(0, 50)}...`);
  
  await bot.sendMessage(msg.chat.id, "📢 Enviando mensaje a todos los usuarios...");
  
  const results = await sendToAllAuthorized(
    `📢 <b>MENSAJE DEL ADMINISTRADOR</b>\n\n${message}`,
    { parse_mode: "HTML" }
  );
  
  const successCount = results.filter(r => r.success).length;
  await bot.sendMessage(
    msg.chat.id,
    `✅ Mensaje enviado a ${successCount}/${authorizedChatIds.length} usuarios`
  );
});

// Mensajes de texto (botones)
bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (!isAuthorizedChat(msg)) return;

  if (msg.text === "📴 Instalaciones Offline") {
    await bot.sendMessage(msg.chat.id, "🔎 Ejecutando comprobación...");
    const result = await checkOfflineInstallations();
    const lines = [`📋 Instalaciones offline: ${result.offlineDevices.length}`];
    await bot.sendMessage(msg.chat.id, lines.join("\n"));
    return;
  }

  if (msg.text === "🔋 Consultar SoC") {
    await bot.sendMessage(msg.chat.id, "🔍 Consultando...");
    const installations = await getAllInstallationsWithBatteryStatus();
    const report = formatBatteryReport(installations);
    await sendLongMessage(msg.chat.id, report);
    return;
  }

  if (msg.text === "📡 Listar Instalaciones") {
    await bot.sendMessage(msg.chat.id, "📡 Obteniendo lista...");
    const installations = await getInstallations();
    const lines = [`📡 Instalaciones: ${installations.length}`];
    await bot.sendMessage(msg.chat.id, lines.join("\n"));
    return;
  }

  if (msg.text === "ℹ️ Estado del Bot") {
    await bot.sendMessage(
      msg.chat.id,
      `🟢 Bot activo\nCron: ${CRON_TIME}\nUsuarios: ${authorizedChatIds.length}`
    );
    return;
  }
});

/**
 * =========================
 * Rutina automática diaria
 * =========================
 */

async function runDailyCheck() {
  console.log("[CRON] Ejecutando comprobación automática diaria");

  try {
    const result = await checkOfflineInstallations();

    if (result.offlineDevices.length === 0) {
      console.log("[CRON] Sin incidencias offline");
      return;
    }

    const lines = [
      "🚨 <b>Alerta automática VRM</b>",
      "",
      `Se han detectado ${result.offlineDevices.length} instalación(es) offline.`,
      `Umbral configurado: ${offlineThresholdMinutes} minutos`,
      ""
    ];

    for (const item of result.offlineDevices) {
      lines.push(formatOfflineDevice(item));
      lines.push("");
    }

    await sendToAllAuthorized(lines.join("\n"));
  } catch (error) {
    console.error("[CRON] Error en comprobación automática:", error.message);
    await sendToAllAuthorized(
      `❌ Error en comprobación automática VRM:\n<code>${escapeHtml(error.message)}</code>`
    );
  }
}

if (!cron.validate(CRON_TIME)) {
  throw new Error(`CRON_TIME no es válido: ${CRON_TIME}`);
}

cron.schedule(
  CRON_TIME,
  runDailyCheck,
  {
    timezone: TIMEZONE
  }
);

console.log(`[CRON] Programado con CRON_TIME="${CRON_TIME}" y TIMEZONE="${TIMEZONE}"`);

/**
 * =========================
 * Manejo de errores
 * =========================
 */

bot.on("polling_error", (error) => {
  console.error("[BOT] Polling error:", error.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("[PROCESS] Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[PROCESS] Uncaught exception:", error);
});