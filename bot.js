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
  TELEGRAM_CHAT_ID,
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

if (!TELEGRAM_BOT_TOKEN) throw new Error("Falta TELEGRAM_BOT_TOKEN");
if (!TELEGRAM_CHAT_ID) throw new Error("Falta TELEGRAM_CHAT_ID");
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
    time: new Date().toISOString()
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
 * Comprueba si el mensaje viene del chat autorizado.
 */
function isAuthorizedChat(msg) {
  return String(msg.chat.id) === String(TELEGRAM_CHAT_ID);
}

/**
 * Envía mensajes largos dividiéndolos en varios mensajes.
 */
async function sendLongMessage(text) {
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
    await bot.sendMessage(TELEGRAM_CHAT_ID, chunk, {
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

  return installations;
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
 *
 * Puede venir como:
 * - Unix timestamp en segundos
 * - Unix timestamp en milisegundos
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
 * Extrae estado básico de instalación de forma tolerante.
 */
function getInstallationStatus(installation) {
  const possibleStatus =
    installation?.status ||
    installation?.state ||
    installation?.connectionState ||
    installation?.systemStatus ||
    installation?.siteStatus ||
    installation?.extended?.status ||
    installation?.extended?.state ||
    installation?.extended?.connectionState ||
    installation?.extended?.systemStatus ||
    installation?.extended?.siteStatus ||
    installation?.overview?.status ||
    installation?.overview?.state ||
    installation?.overview?.connectionState ||
    installation?.overview?.systemStatus ||
    installation?.overview?.siteStatus ||
    installation?.alarm ||
    installation?.alarmStatus ||
    installation?.hasAlarm ||
    installation?.isOnline ||
    installation?.online;

  if (possibleStatus === true) return "Online";
  if (possibleStatus === false) return "Offline";

  if (
    possibleStatus !== undefined &&
    possibleStatus !== null &&
    possibleStatus !== ""
  ) {
    return String(possibleStatus);
  }

  return "No disponible";
}

/**
 * Revisa todas las instalaciones.
 *
 * Importante:
 * - Se genera una alerta por instalación, no por dispositivo.
 * - Para cada instalación se usa la conexión más reciente de sus devices.
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
 * Comando /estado
 * =========================
 */

async function handleStatusCommand() {
  await sendLongMessage(
    [
      "🟢 <b>Bot activo</b>",
      "",
      `Cron: <code>${escapeHtml(CRON_TIME)}</code>`,
      `Zona horaria: <code>${escapeHtml(TIMEZONE)}</code>`,
      `Umbral offline: <b>${offlineThresholdMinutes}</b> minutos`
    ].join("\n")
  );
}

/**
 * =========================
 * Comando /test
 * =========================
 */

async function handleTestCommand() {
  console.log("[BOT] Ejecutando /test");

  await sendLongMessage("🔎 Ejecutando comprobación manual de instalaciones VRM...");

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

    await sendLongMessage(lines.join("\n"));
  } catch (error) {
    console.error("[BOT] Error en /test:", error.message);
    await sendLongMessage(
      `❌ Error ejecutando comprobación manual:\n<code>${escapeHtml(error.message)}</code>`
    );
  }
}

/**
 * =========================
 * Comando /listar
 * =========================
 */

async function handleListCommand() {
  console.log("[BOT] Ejecutando /listar");

  try {
    const installations = await getInstallations();

    if (!installations.length) {
      await sendLongMessage("No se encontraron instalaciones para este usuario.");
      return;
    }

    const lines = [
      "📡 <b>Instalaciones VRM disponibles</b>",
      "",
      `Total: <b>${installations.length}</b>`,
      ""
    ];

    for (const installation of installations) {
      const name = getInstallationName(installation);
      const idSite = getInstallationId(installation);
      const state = getInstallationStatus(installation);

      lines.push(`• <b>${escapeHtml(name)}</b>`);
      lines.push(`  ID: <code>${escapeHtml(String(idSite ?? "sin idSite"))}</code>`);
      lines.push(`  Estado: ${escapeHtml(String(state))}`);
      lines.push("");
    }

    await sendLongMessage(lines.join("\n"));
  } catch (error) {
    console.error("[BOT] Error en /listar:", error.message);
    await sendLongMessage(
      `❌ Error listando instalaciones:\n<code>${escapeHtml(error.message)}</code>`
    );
  }
}

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

    await sendLongMessage(lines.join("\n"));
  } catch (error) {
    console.error("[CRON] Error en comprobación automática:", error.message);

    await sendLongMessage(
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
 * Handlers Telegram
 * =========================
 */

bot.onText(/^\/start$/, async (msg) => {
  if (!isAuthorizedChat(msg)) {
    console.warn(`[SECURITY] Chat no autorizado ignorado: ${msg.chat.id}`);
    return;
  }

  await bot.sendMessage(
    TELEGRAM_CHAT_ID,
    [
      "🤖 <b>Bot Victron VRM activo</b>",
      "",
      "Selecciona una opción:"
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: {
        keyboard: [
          [{ text: "🔍 Test" }, { text: "📡 Listar" }],
          [{ text: "ℹ️ Estado" }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    }
  );
});

bot.onText(/^\/test$/, async (msg) => {
  if (!isAuthorizedChat(msg)) {
    console.warn(`[SECURITY] Chat no autorizado ignorado: ${msg.chat.id}`);
    return;
  }

  await handleTestCommand();
});

bot.onText(/^\/listar$/, async (msg) => {
  if (!isAuthorizedChat(msg)) {
    console.warn(`[SECURITY] Chat no autorizado ignorado: ${msg.chat.id}`);
    return;
  }

  await handleListCommand();
});

bot.onText(/^\/estado$/, async (msg) => {
  if (!isAuthorizedChat(msg)) {
    console.warn(`[SECURITY] Chat no autorizado ignorado: ${msg.chat.id}`);
    return;
  }

  await handleStatusCommand();
});

bot.on("message", async (msg) => {
  if (!msg.text) return;

  if (!isAuthorizedChat(msg)) {
    console.warn(`[SECURITY] Mensaje de chat no autorizado ignorado: ${msg.chat.id}`);
    return;
  }

  if (msg.text === "🔍 Test") {
    await handleTestCommand();
    return;
  }

  if (msg.text === "📡 Listar") {
    await handleListCommand();
    return;
  }

  if (msg.text === "ℹ️ Estado") {
    await handleStatusCommand();
    return;
  }

  const knownCommands = ["/start", "/test", "/listar", "/estado"];

  if (msg.text.startsWith("/") && !knownCommands.includes(msg.text.trim())) {
    await sendLongMessage(
      "Comando no reconocido. Usa /test, /listar o /estado."
    );
  }
});

bot.on("polling_error", (error) => {
  console.error("[BOT] Polling error:", error.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("[PROCESS] Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[PROCESS] Uncaught exception:", error);
});