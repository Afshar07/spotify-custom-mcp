import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Static script only: no user-controlled text is interpolated into PowerShell. */
export async function pickHistoryFolder(): Promise<string | null> {
  if (process.platform !== 'win32') throw new Error('Paste the absolute history folder path below on this platform.');
  const script = "Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = 'Choose your extracted Spotify Extended Streaming History folder'; $picker.ShowNewFolderButton = $false; if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Write($picker.SelectedPath) }; $picker.Dispose()";
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, timeout: 180000, maxBuffer: 16384, encoding: 'utf8' });
  return stdout.trim() || null;
}
