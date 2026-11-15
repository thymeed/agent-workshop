#!/usr/bin/env bash
# Masks each comma-separated word in $PRIVACY_WORDS for GitHub Actions logs.
# GitHub masks only the whole secret value, so each word is masked on its own.
# Words shorter than 3 characters cannot be masked: warn once, never print the word
# except inside an ::add-mask:: line. Always exits 0 (an empty secret is allowed).
short=0
IFS=',' read -ra words <<< "${PRIVACY_WORDS:-}"
for word in "${words[@]}"; do
  word="${word#"${word%%[![:space:]]*}"}"
  word="${word%"${word##*[![:space:]]}"}"
  [ -n "$word" ] || continue
  printf '::add-mask::%s\n' "$word"
  [ "${#word}" -ge 3 ] || short=1
done
if [ "$short" -eq 1 ]; then
  printf '::warning::a privacy word shorter than 3 chars cannot be masked\n'
fi
exit 0
