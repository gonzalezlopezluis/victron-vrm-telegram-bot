# Victron VRM Telegram Bot

Bot de Telegram en Node.js para monitorizar instalaciones de Victron Energy VRM y avisar si algún dispositivo aparece offline según `devices[].lastConnection`.

## Funcionalidades

- Comprobación automática diaria mediante `node-cron`.
- Comando `/test` para ejecutar una comprobación manual.
- Comando `/listar` para listar instalaciones disponibles.
- Endpoint `/health` para Render.
- Detección automática de timestamps en segundos o milisegundos.
- División automática de mensajes largos de Telegram.
- Ignora comandos de chats no autorizados.

## Requisitos

- Node.js 18 o superior.
- Token de bot de Telegram.
- Chat ID autorizado.
- Token de Victron VRM.
- ID de usuario de Victron VRM.

## Instalación local

```bash
npm install
cp .env.example .env
npm start