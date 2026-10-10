; Spotify Curator per-user installer (Inno Setup 6). Build: iscc /DAppVersion=0.3.0 installer\SpotifyCurator.iss
; Not buildable on Linux; verified only by the windows-installer GitHub Actions workflow.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
; Never change AppId: upgrades and uninstall are keyed on it.
AppId={{7C1B2E0A-5D3F-4C8B-9A41-2F6E8B0D7A13}
AppName=Spotify Curator
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersion}
AppPublisher=Spotify Curator
; Per-user install, no administrator prompt. Deterministic path: %LOCALAPPDATA%\Programs\SpotifyCurator
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\SpotifyCurator
DisableDirPage=yes
DefaultGroupName=Spotify Curator
DisableProgramGroupPage=yes
OutputDir=..\dist-installer
OutputBaseFilename=SpotifyCurator-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
; An AI app may be running the MCP from this folder; let Windows close it so the file can be replaced.
CloseApplications=yes
RestartApplications=no
UninstallDisplayName=Spotify Curator
UninstallDisplayIcon={app}\spotify-curator.exe

[Files]
Source: "..\build\spotify-curator.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Spotify Curator Setup"; Filename: "{app}\spotify-curator.exe"; Parameters: "setup"

[Run]
Filename: "{app}\spotify-curator.exe"; Parameters: "setup"; Description: "Open Spotify Curator Setup"; Flags: postinstall nowait skipifsilent

[Code]
// Credentials and settings live in %LOCALAPPDATA%\SpotifyCurator, outside the install folder, so upgrades keep them.
var
  RemoveData: Boolean;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  // Silent uninstalls keep user data unless /REMOVEDATA=1 is passed.
  if UninstallSilent then
    RemoveData := ExpandConstant('{param:REMOVEDATA|0}') = '1'
  else
    RemoveData := MsgBox(
      'Also remove your saved Spotify sign-in and the Spotify Curator entries in OpenCode and ChatGPT Desktop?' + #13#10#13#10 +
      'Choose No to keep them (for example, if you plan to reinstall).',
      mbConfirmation, MB_YESNO or MB_DEFBUTTON1) = IDYES;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if (CurUninstallStep = usUninstall) and RemoveData then
    Exec(ExpandConstant('{app}\spotify-curator.exe'), 'cleanup --opencode --chatgpt --credentials --settings',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;
