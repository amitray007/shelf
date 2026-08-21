#!/bin/sh

set -eu

trap 'stty echo 2>/dev/null || true' 0 HUP INT TERM

admin_cli=/opt/shelf/dist/operator/cli.js

if [ ! -t 0 ]; then
  echo "Shelf owner setup requires an interactive terminal." >&2
  exit 1
fi
if [ ! -f "$admin_cli" ]; then
  echo "Shelf administration is not installed in this container." >&2
  exit 1
fi
if [ -z "${SHELF_WEB_ROOT:-}" ]; then
  echo "Run this command in the Shelf web-server service." >&2
  exit 1
fi

echo "Shelf owner administration"
echo "  1) Set up the installation owner"
echo "  2) Reset the owner email, name, and password"
printf "Choose 1 or 2: "
IFS= read -r choice

case "$choice" in
  1) action=bootstrap ;;
  2) action=reset ;;
  *)
    echo "Choose either 1 or 2." >&2
    exit 1
    ;;
esac

while :; do
  printf "Owner email: "
  IFS= read -r email
  case "$email" in
    ?*@?*.?*) break ;;
    *) echo "Enter a valid email address." >&2 ;;
  esac
done

while :; do
  printf "Owner name: "
  IFS= read -r name
  if [ -n "$name" ] && [ "${#name}" -le 128 ]; then
    break
  fi
  echo "Name must contain between 1 and 128 characters." >&2
done

while :; do
  printf "Password: "
  stty -echo
  if ! IFS= read -r password; then
    stty echo
    printf "\n"
    exit 1
  fi
  stty echo
  printf "\nConfirm password: "
  stty -echo
  if ! IFS= read -r confirmation; then
    stty echo
    printf "\n"
    exit 1
  fi
  stty echo
  printf "\n"

  if [ "$password" != "$confirmation" ]; then
    echo "Passwords do not match." >&2
    continue
  fi
  if [ "${#password}" -lt 8 ] || [ "${#password}" -gt 128 ]; then
    echo "Password must contain between 8 and 128 characters." >&2
    continue
  fi
  break
done

if [ "$action" = bootstrap ]; then
  if printf "%s" "$password" | node "$admin_cli" owner bootstrap \
    --email "$email" \
    --name "$name" \
    --password-file - \
    --grant workspace-main:file.publish \
    --grant workspace-main:revision.read
  then
    echo "Shelf owner setup complete."
  else
    echo "Shelf owner setup failed. If an owner already exists, choose reset instead." >&2
    exit 1
  fi
else
  if printf "%s" "$password" | node "$admin_cli" owner reset \
    --email "$email" \
    --name "$name" \
    --password-file -
  then
    echo "Shelf owner reset complete. Existing browser sessions were signed out."
  else
    echo "Shelf owner reset failed. Check that an owner has already been set up." >&2
    exit 1
  fi
fi

password=
confirmation=
trap - 0 HUP INT TERM
