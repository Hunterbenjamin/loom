#!/usr/bin/env bash
# Fidelity test pattern: colors, box drawing, wide characters. Each "|" in the width block should
# line up in one column if the renderer and Herdr agree on character widths.
printf '\e[1mbold\e[0m \e[2mdim\e[0m \e[3mitalic\e[0m \e[4munderline\e[0m \e[4:3mcurly\e[0m \e[7minverse\e[0m \e[9mstrike\e[0m\n'
for i in $(seq 0 15); do printf '\e[48;5;%sm  ' "$i"; done; printf '\e[0m  16 colors\n'
for i in $(seq 16 51); do printf '\e[48;5;%sm ' "$i"; done; printf '\e[0m  256 cube\n'
for i in $(seq 0 4 255); do printf '\e[48;2;%s;%s;%sm ' "$i" $((255 - i)) 128; done; printf '\e[0m  truecolor\n'
printf '┌──────┬──────┐ ╭──────╮ ╔══════╗\n'
printf '│ box  │ ━━━━ │ │round │ ║double║\n'
printf '├──────┼──────┤ ╰──────╯ ╚══════╝\n'
printf '└──────┴──────┘ ▁▂▃▄▅▆▇█ ░▒▓ ⣿⠿ \n'
printf '%s\n' \
  'ascii       abcdefgh|' \
  'cjk         宽字符宽|' \
  'emoji       😀🎉🚀✅|' \
  'zwj family  👨‍👩‍👧‍👦AAAAAA|' \
  'flag        🇯🇵AAAAAA|' \
  'vs16        ❤️AAAAAA|' \
  'combining   éééééééé|' \
  'hangul      한국어요|'
printf 'end-of-pattern\n'
