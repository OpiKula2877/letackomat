// Windows oznámení (toast) přes PowerShell a WinRT, bez dalších závislostí.
// Aplikace se ve Windows zaregistruje pod vlastním názvem "Letáčkomat" (jen klíč v HKCU, bez admin práv).
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { rootDir } from '../install.js';

export const APP_ID = 'Letackomat';

const xmlEscape = (s) =>
  String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

/** XML oznámení: nadpis + nejvýš 2 řádky textu; kliknutí otevře adresu aplikace. */
export function buildToastXml({ title, lines = [], url }) {
  const texts = [title, ...lines.slice(0, 2)].filter(Boolean).map((t) => `<text>${xmlEscape(t)}</text>`).join('');
  return `<toast activationType="protocol" launch="${xmlEscape(url)}"><visual><binding template="ToastGeneric">${texts}</binding></visual></toast>`;
}

const REGISTER_AND_LOAD = `
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$id = $env:LETACKOMAT_APP_ID
$reg = "HKCU:\\Software\\Classes\\AppUserModelId\\$id"
if (-not (Test-Path $reg)) { New-Item -Path $reg -Force | Out-Null }
New-ItemProperty -Path $reg -Name DisplayName -Value 'Letáčkomat' -PropertyType String -Force | Out-Null
if ($env:LETACKOMAT_TOAST_ICON) { New-ItemProperty -Path $reg -Name IconUri -Value $env:LETACKOMAT_TOAST_ICON -PropertyType String -Force | Out-Null }
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id)
`;

const SHOW_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
${REGISTER_AND_LOAD}
  $setting = $notifier.Setting.ToString()
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($env:LETACKOMAT_TOAST_XML)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  $notifier.Show($toast)
  @{ ok = $true; setting = $setting } | ConvertTo-Json -Compress
} catch { @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress }
`;

const SETTING_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
${REGISTER_AND_LOAD}
  @{ ok = $true; setting = $notifier.Setting.ToString() } | ConvertTo-Json -Compress
} catch { @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress }
`;

/** Výchozí spuštění PowerShellu; v testech se nahrazuje. */
export function runPowerShell(script, env = {}) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 20_000, encoding: 'utf8' },
      (err, stdout) => {
        if (err && !stdout) return resolve({ ok: false, error: err.message });
        try {
          resolve(JSON.parse(stdout.trim().split('\n').pop()));
        } catch {
          resolve({ ok: false, error: `Nečekaný výstup PowerShellu: ${String(stdout).slice(0, 200)}` });
        }
      },
    );
  });
}

const baseEnv = () => ({ LETACKOMAT_APP_ID: APP_ID, LETACKOMAT_TOAST_ICON: join(rootDir, 'web', 'icons', 'icon-192.png') });

/** Zobrazí oznámení. Vrací { ok, setting?, error? }; mimo Windows { ok:false, error:'unsupported' }. */
export async function showToast({ title, lines = [], url }, run = runPowerShell) {
  if (process.platform !== 'win32' && run === runPowerShell) return { ok: false, error: 'unsupported' };
  return run(SHOW_SCRIPT, { ...baseEnv(), LETACKOMAT_TOAST_XML: buildToastXml({ title, lines, url }) });
}

/** Je ve Windows povolené zobrazovat oznámení pro Letáčkomat? ('Enabled', 'DisabledForUser', ...) */
export async function toastSetting(run = runPowerShell) {
  if (process.platform !== 'win32' && run === runPowerShell) return { ok: false, error: 'unsupported' };
  return run(SETTING_SCRIPT, baseEnv());
}
