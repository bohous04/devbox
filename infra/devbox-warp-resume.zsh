# Source from ~/.zshrc after installing the current dev CLI.
# Warp restores WARP_TERMINAL_SESSION_UUID with the original pane/window tree.
# Run once after Warp's bootstrap, in this shell's own TTY (no UI keystrokes).
if [[ -o interactive && "$TERM_PROGRAM" == WarpTerminal && -n "$WARP_TERMINAL_SESSION_UUID" ]]; then
  autoload -Uz add-zsh-hook
  _devbox_resume_restored_pane() {
    [[ -n "$WARP_BOOTSTRAPPED" ]] || return 0
    add-zsh-hook -d precmd _devbox_resume_restored_pane
    if [[ -t 0 && -t 1 ]]; then
      if [[ -n "$DEVBOX_RECOVERY_CLI" && -n "$DEVBOX_RECOVERY_BUN" ]]; then
        command "$DEVBOX_RECOVERY_BUN" "$DEVBOX_RECOVERY_CLI" resume --auto
      else
        command dev resume --auto
      fi
    fi
  }
  add-zsh-hook -d precmd _devbox_resume_restored_pane
  add-zsh-hook precmd _devbox_resume_restored_pane
fi
