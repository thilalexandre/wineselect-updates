@echo off
rem Appel interne : la fenetre du serveur relance ce fichier avec "serveur".
if /i "%~1"=="serveur" goto :boucleServeur

title Wine Select - Demarrage
cd /d "%~dp0"

echo ======================================
echo   Wine Select - Demarrage du serveur
echo ======================================
echo.

echo Verification du port 3000...
rem Ancienne fenetre du serveur (lancement precedent) : sa boucle relancerait
rem le serveur en concurrence avec le nouveau, on la ferme d'abord.
taskkill /FI "WINDOWTITLE eq Wine Select Serveur - Ne pas fermer*" /T /F >nul 2>&1
rem NB : on ne filtre plus sur le mot d'etat ("LISTENING"/"ECOUTE") car il est
rem traduit selon la langue de Windows -> on filtre uniquement sur l'adresse,
rem ce qui marche quelle que soit la langue du systeme.
for /f "tokens=5" %%P in ('netstat -aon ^| findstr "TCP" ^| findstr /r /c:":3000 "') do (
    if not "%%P"=="0" taskkill /PID %%P /F >nul 2>&1
)
echo   -^> OK.
echo.

where node >nul 2>&1
if errorlevel 1 goto :noNode

if exist "api-key.txt" goto :hasKey
if not "%MISTRAL_API_KEY%"=="" goto :hasKey
rem Mode connecte (2026-10) : la cle Mistral est sur le serveur central,
rem la borne n'a besoin que de son jeton.
if exist "borne-jeton.txt" goto :hasKey
rem Borne neuve (ni cle ni jeton) : elle demarre quand meme, sans IA, pour
rem pouvoir etre installee depuis l'ecran de depannage.
echo [INFO] Borne pas encore installee : elle conseillera sans IA.
echo Pour l'installer : appui long sur le logo de l'ecran, puis le code (PIN de la borne),
echo puis saisir l'adresse du serveur et le jeton de la borne.
echo.
goto :hasKey

:hasKey
echo Verification des mises a jour...
if exist "check-update.js" (
    node check-update.js
) else (
    echo   -^> check-update.js introuvable, verification ignoree.
)
echo.

rem Nouvelle version de ce fichier deposee par check-update.js : on la met en
rem place puis on la lance. Le bloc entre parentheses est lu en entier avant
rem d'etre execute : remplacer le fichier pendant ce temps est sans risque.
rem WS_MAJ_INSTALLER empeche de recommencer si la mise a jour se representait.
if not defined WS_MAJ_INSTALLER if exist "INSTALLER.bat.nouveau" (
    set WS_MAJ_INSTALLER=1
    echo Mise a jour du demarrage de la borne...
    copy /y "%~f0" "INSTALLER.bat.ancien" >nul
    move /y "INSTALLER.bat.nouveau" "%~f0" >nul
    if errorlevel 1 (
        del "INSTALLER.bat.nouveau" >nul 2>&1
        echo [ATTENTION] Mise a jour impossible, on garde la version actuelle.
        echo.
    ) else "%~f0"
)

echo Lancement du serveur Wine Select...
rem Fenetre reduite, qui relance le serveur s'il s'arrete (voir :boucleServeur).
start "Wine Select Serveur - Ne pas fermer" /min cmd /c ""%~f0" serveur"

echo Attente du demarrage du serveur...
rem Au plus 30 secondes ; l'ecran s'ouvre de toute facon ensuite.
set /a essais=0
:attente
curl.exe -s -o nul -m 2 http://localhost:3000/version >nul 2>&1
if not errorlevel 1 goto :ouvrirEcran
set /a essais+=1
if %essais% geq 30 goto :ouvrirEcran
timeout /t 1 /nobreak >nul
goto :attente

:ouvrirEcran
rem Ecran en plein ecran kiosque (pas de barre d'adresse, pas d'onglets).
rem Profil dedie : le mode kiosque s'applique meme si le navigateur est deja
rem ouvert, et aucune bulle "restaurer les pages" apres une coupure de courant.
rem Pour sortir du mode kiosque (technicien) : Alt+F4.
set "PROFIL_KIOSQUE=%LOCALAPPDATA%\WineSelect-kiosque"
set "OPTIONS_KIOSQUE=--kiosk http://localhost:3000 --no-first-run --disable-pinch --overscroll-history-navigation=0 --user-data-dir="%PROFIL_KIOSQUE%""
set "NAVIGATEUR="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "NAVIGATEUR=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined NAVIGATEUR if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "NAVIGATEUR=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined NAVIGATEUR if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "NAVIGATEUR=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined NAVIGATEUR if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "NAVIGATEUR=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined NAVIGATEUR if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "NAVIGATEUR=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if defined NAVIGATEUR (
    start "" "%NAVIGATEUR%" %OPTIONS_KIOSQUE%
) else (
    echo [ATTENTION] Ni Chrome ni Edge trouves : ecran ouvert dans le navigateur par defaut, sans mode kiosque.
    start "" "http://localhost:3000"
    timeout /t 10 /nobreak >nul
)
exit /b 0

rem --- Fenetre du serveur : relance serveur.js s'il s'arrete ---
:boucleServeur
title Wine Select Serveur - Ne pas fermer
cd /d "%~dp0"
:relancer
node serveur.js
echo.
echo [%date% %time%] Le serveur s'est arrete. Redemarrage dans 5 secondes...
echo (Pour l'arreter vraiment : fermer cette fenetre.)
timeout /t 5 /nobreak >nul
goto :relancer

:noNode
echo [ERREUR] Node.js n'est pas installe ou n'est pas dans le PATH.
echo Installe Node.js depuis https://nodejs.org puis relance ce fichier.
echo.
pause
exit /b 1

:noKey
echo [ERREUR] Aucune cle API Mistral trouvee.
echo Cree un fichier api-key.txt dans ce dossier avec ta cle dedans,
echo ou definis la variable d'environnement MISTRAL_API_KEY.
echo.
pause
exit /b 1
