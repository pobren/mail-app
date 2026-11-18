; Mail App Bridge installer (Inno Setup 6). Built by .github/workflows/bridge.yml:
;   iscc /DAppVersion=0.1.0 /DSourceExe=path\to\Mail App Bridge.exe mailapp-bridge.iss
; Installs for the signed-in user only (no admin needed), starts the bridge, and opens its settings page.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceExe
  #define SourceExe "..\dist\Mail App Bridge.exe"
#endif

[Setup]
AppId={{7B4D2C1E-5A8F-4C3B-9E21-6D0F3A9B8C47}
AppName=Mail App Bridge
AppVersion={#AppVersion}
AppVerName=Mail App Bridge {#AppVersion}
AppPublisher=Paul O'Brien
AppPublisherURL=https://paulobrien.dev/mail/
AppSupportURL=https://github.com/pobren/mail-app/discussions
DefaultDirName={localappdata}\Programs\Mail App Bridge
DefaultGroupName=Mail App Bridge
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=Mail-App-Bridge-Setup-{#AppVersion}
OutputDir=..\dist
SetupIconFile=..\cmd\mailapp-bridge\assets\icon.ico
UninstallDisplayIcon={app}\Mail App Bridge.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
LicenseFile=..\..\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "Mail App Bridge.exe"; Flags: ignoreversion

[Icons]
Name: "{group}\Mail App Bridge"; Filename: "{app}\Mail App Bridge.exe"
Name: "{group}\Uninstall Mail App Bridge"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\Mail App Bridge.exe"; Description: "Start Mail App Bridge and open its settings"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/C taskkill /IM ""Mail App Bridge.exe"" /F"; Flags: runhidden; RunOnceId: "StopBridge"

[Registry]
; Starting with Windows. The bridge keeps this up to date itself from its settings page; removed on uninstall.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "Mail App Bridge"; Flags: uninsdeletevalue dontcreatekey
