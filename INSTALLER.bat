@echo off
title Wine Select - Demarrage
cd /d "%~dp0"

echo ======================================
echo   Wine Select - Demarrage du serveur
echo ======================================
echo.

echo Verification du port 3000...
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
goto :noKey

:hasKey
echo Verification des mises a jour...
if exist "check-update.js" (
    node check-update.js
) else (
    echo   -^> check-update.js introuvable, verification ignoree.
)
echo.

echo Lancement du serveur Wine Select...
echo Laisse la fenetre du serveur ouverte.
echo.
start "Wine Select Serveur - Ne pas fermer" cmd /k "node serveur.js"

echo Attente du demarrage du serveur...
timeout /t 4 /nobreak >nul

start "" "http://localhost:3000"

echo.
echo Wine Select est lance.
echo Cette fenetre peut etre fermee, mais laisse la fenetre
echo du serveur ouverte tant que l'application tourne.
echo.
pause
exit /b 0

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
