; Instalátor Letáčkomatu (Inno Setup 6). Sestavuje ho scripts/build-installer.js, ručně:
;   ISCC /DAppVersion=1.4.1 /DStageDir=C:\cesta\ke\stage /DOutDir=C:\cesta\dist installer\letackomat.iss
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef NumVersion
  #define NumVersion "0.0.0.0"
#endif
#ifndef StageDir
  #error Chybi StageDir (slozka s aplikaci, node.exe a node_modules).
#endif
#ifndef OutDir
  #define OutDir "dist"
#endif

[Setup]
; Stabilní identifikátor: díky němu se novější instalátor poznává jako aktualizace téže aplikace
AppId={{8F3A2C1E-6B0D-4E57-9A41-2D7C5E9B1F30}
AppName=Letáčkomat
AppVersion={#AppVersion}
VersionInfoVersion={#NumVersion}
AppPublisher=OpiKula2877
AppPublisherURL=https://github.com/OpiKula2877/letackomat
AppSupportURL=https://github.com/OpiKula2877/letackomat/issues
AppUpdatesURL=https://github.com/OpiKula2877/letackomat/releases
; Výchozí C:\Program Files\Letackomat (potřebuje správce). Na příkazové řádce jde přepsat /CURRENTUSER nebo /ALLUSERS,
; v okně instalátoru nabídne volbu "jen pro mě" bez správce.
DefaultDirName={autopf}\Letackomat
DefaultGroupName=Letáčkomat
DisableProgramGroupPage=yes
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog commandline
OutputDir={#OutDir}
OutputBaseFilename=Letackomat-Setup-{#AppVersion}
SetupIconFile={#StageDir}\web\icons\icon.ico
UninstallDisplayIcon={app}\web\icons\icon.ico
UninstallDisplayName=Letáčkomat
#ifdef Fast
Compression=zip
#else
Compression=lzma2/max
#endif
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ShowLanguageDialog=no
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "czech"; MessagesFile: "compiler:Languages\Czech.isl"

[Tasks]
Name: "desktopicon"; Description: "Vytvořit zástupce na ploše"; Flags: unchecked
Name: "protocol"; Description: "Povolit tlačítko Spustit server v aplikaci (zaregistruje adresu letackomat://)"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; staré soubory předchozí verze se před kopírováním smažou, ať tu nezůstanou zbytky
Type: filesandordirs; Name: "{app}\server"
Type: filesandordirs; Name: "{app}\web"
Type: filesandordirs; Name: "{app}\scripts"
Type: filesandordirs; Name: "{app}\node_modules"

[Icons]
Name: "{autoprograms}\Letáčkomat"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\app.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\web\icons\icon.ico"; Comment: "Spustí Letáčkomat a otevře ho v prohlížeči"
Name: "{autoprograms}\Vypnout Letáčkomat"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\stop.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\web\icons\icon.ico"; Comment: "Vypne Letáčkomat běžící na pozadí"
Name: "{autoprograms}\Odinstalovat Letáčkomat"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Letáčkomat"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\app.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\web\icons\icon.ico"; Tasks: desktopicon

[Registry]
; tlačítko Spustit server v aplikaci (letackomat://start); HKA = pro všechny uživatele při instalaci správcem, jinak jen pro mě
Root: HKA; Subkey: "Software\Classes\letackomat"; ValueType: string; ValueName: ""; ValueData: "URL:Letackomat"; Flags: uninsdeletekey; Tasks: protocol
Root: HKA; Subkey: "Software\Classes\letackomat"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""; Tasks: protocol
Root: HKA; Subkey: "Software\Classes\letackomat\shell\open\command"; ValueType: string; ValueName: ""; ValueData: "wscript.exe ""{app}\scripts\start-hidden.vbs"""; Tasks: protocol
; název aplikace pro Windows oznámení vytváří aplikace sama při prvním oznámení, odinstalace ho smaže
Root: HKCU; Subkey: "Software\Classes\AppUserModelId\Letackomat"; Flags: dontcreatekey uninsdeletekey

[Run]
; po ruční instalaci nabídne spuštění, po tiché aktualizaci z aplikace se spustí samo
Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\app.vbs"""; Description: "Spustit Letáčkomat"; Flags: nowait postinstall skipifsilent runasoriginaluser
Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\start-hidden.vbs"""; Flags: nowait runasoriginaluser; Check: WizardSilent

[UninstallRun]
Filename: "{app}\node.exe"; Parameters: """{app}\scripts\launcher.js"" stop"; WorkingDir: "{app}"; Flags: runhidden; RunOnceId: "StopLetackomat"

[UninstallDelete]
; skript pro spuštění po přihlášení (vzniká zapnutím oznámení na pozadí)
Type: files; Name: "{userstartup}\Letackomat-na-pozadi.vbs"

[Code]
{ Před instalací vypne běžící Letáčkomat (starší verze téže instalace), aby šly vyměnit soubory. }
procedure StopRunningApp();
var
  ResultCode: Integer;
  AppDir: String;
begin
  AppDir := ExpandConstant('{app}');
  if FileExists(AppDir + '\node.exe') and FileExists(AppDir + '\scripts\launcher.js') then
    Exec(AppDir + '\node.exe', '"' + AppDir + '\scripts\launcher.js" stop', AppDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningApp();
  Result := '';
end;

{ Při odinstalaci se zeptá, jestli smazat i data; výchozí je ponechat (nákupní seznam, pravidla, stažené akce). }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\Letackomat');
    if DirExists(DataDir) then
      if MsgBox('Smazat i tvoje data (nákupní seznam, pravidla hlídače, stažené akce)?' + #13#10 + DataDir, mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
  end;
end;
