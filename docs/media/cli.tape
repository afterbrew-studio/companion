# Source for docs/media/cli.gif, the first-run recording in the README.
# Regenerate with:
#
#   vhs docs/media/cli.tape
#
# The hidden block below is what keeps the recording neutral and repeatable: a
# throwaway data directory so no real path appears and every take is a genuine
# first run, and an empty gh config dir so the setup does not offer to connect
# the operator's GitHub account. HOME stays real on purpose: harness detection
# reads the agent CLIs installed on this machine, and that answer is the point
# of the question being recorded.

Output docs/media/cli.gif

Set Shell "zsh"
Set FontSize 15
Set Width 1000
Set Height 760
Set Padding 26
Set TypingSpeed 55ms
Set Framerate 24
Set Theme { "background": "#09090b", "foreground": "#fafafa", "cursor": "#fafafa", "selection": "#27272a", "black": "#18181b", "red": "#f87171", "green": "#34d399", "yellow": "#fbbf24", "blue": "#60a5fa", "magenta": "#c084fc", "cyan": "#22d3ee", "white": "#e4e4e7", "brightBlack": "#71717a", "brightRed": "#f87171", "brightGreen": "#34d399", "brightYellow": "#fbbf24", "brightBlue": "#60a5fa", "brightMagenta": "#c084fc", "brightCyan": "#22d3ee", "brightWhite": "#fafafa" }

Hide
Type "export COMPANION_HOME=/tmp/companion-demo/.companion GH_CONFIG_DIR=/tmp/companion-demo/nogh" Enter
Type "rm -rf /tmp/companion-demo/.companion" Enter
# Recorded outside a git checkout: standing in one makes the first run offer to
# add that repository, which is a different demo than this one.
Type "cd /tmp/companion-demo" Enter
Type "PROMPT='%F{8}$%f '" Enter
Type "clear" Enter
Sleep 1s
Show

Sleep 1s
Type "npx @moxxy/companion" Sleep 700ms Enter
Sleep 7s
Enter
Sleep 2500ms
Enter
Sleep 2500ms
Enter
Sleep 7s
Enter
Sleep 9s

Hide
Ctrl+C
Sleep 2s
