!macro NSIS_HOOK_PREINSTALL
  ; These directories contain only versioned package files. Removing them
  ; prevents an upgrade from retaining files deleted by a newer package.
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\acceptance"
!macroend
