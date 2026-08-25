@echo off
REM Watches for heartbeat gaps and signs MONITOR_SILENT when a monitor goes quiet.
REM
REM The device identity below was provisioned with:
REM   node tools/provision-device/index.mjs --kind service
REM
REM MONITOR_SILENT is service-only on purpose: a monitor cannot report its own
REM silence, because a device that could declare itself silent could also
REM decline to.
set LEDGER_URL=http://localhost:8081
set MONITOR_HEARTBEAT_SECONDS=30
set MONITOR_MISSED_HEARTBEATS_ALARM=3
set WATCHDOG_DEVICE_ID=607678c6-2d59-44dc-8989-d90c0280a6fb
set WATCHDOG_PRIVKEY=eb5b888205cc33faa37acb76caf5a452d2ca64eb0a725ec233b37cacd4f8e2c6
node "%~dp0index.mjs"
