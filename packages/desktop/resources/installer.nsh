!macro customInit
  ${if} $installMode == "all"
    StrCpy $INSTDIR "$PROGRAMFILES\${APP_FILENAME}"
  ${else}
    StrCpy $INSTDIR "$LocalAppData\Programs\${APP_FILENAME}"
  ${endIf}
!macroend
